'use strict';
/**
 * 配置读写 + IPC 注册。
 * 单独抽出来是为了让主进程(main.js)和端到端测试(tools/smoke.mjs)共用同一套逻辑,
 * 测试里跑的就是真实代码,而不是复制品。
 */

const { ipcMain, shell, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { providerList, getProvider } = require('../shared/providers.cjs');
const { buildRequest, consumeSseBuffer } = require('../shared/llmStream.cjs');

const DEFAULT_CONFIG = {
  // 默认厂商(新版:多厂商 + 按座位分配;旧的 endpoint/apiKey 字段仍然兼容)
  defaultProvider: 'deepseek',
  keys: {},                 // { deepseek: 'sk-...', openrouter: 'sk-or-...' }
  seatProviders: {},        // { '0': 'deepseek', '1': 'groq' } 不填则跟随默认
  seatModels: {},           // { '0': 'deepseek-chat', '2': 'llama-3.1-8b-instant' }
  endpoint: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 1.1,
  // 推理型模型(deepseek-flash / deepseek-v4-pro / qwen3-thinking 等)会先输出
  // 一大段 reasoning_content 再给正式回答,两者共用同一个 max_tokens 预算。
  // 实测 deepseek-flash:max_tokens=300 时推理就吃了 940 字,正式回答被挤掉
  // (finish_reason=length),决策只能从残缺文本硬猜;600 以上才够。
  // 所以默认给足,不然「思考」会挤掉「决策」。
  maxTokens: 1200,
  timeoutMs: 45000,
  game: {
    seats: 6,
    shortDeck: false,
    startingStack: 2000,
    smallBlind: 10,
    bigBlind: 20,
    ante: 0,
    blindUpEvery: 0,
  },
  ui: {
    thinkDelayMs: 900,
    autoNextHand: false,
    showThinking: true,
    deckView: 'down',        // down = 全部盖着(默认) | board = 只看公共牌 | up = 全翻开(荷官特权)
  },
};

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** 正在进行的 LLM 请求(用于取消) */
const llmAborts = new Map();

function makeStore(configPath) {
  function read() {
    try {
      return deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }
  function write(cfg) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      return { ok: true, path: configPath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { read, write, configPath, defaults: DEFAULT_CONFIG };
}

/** 注册所有 IPC 处理器(重复调用安全) */
function registerIpc(configPath) {
  const store = makeStore(configPath);
  const handle = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch { /* 没注册过就忽略 */ }
    ipcMain.handle(channel, fn);
  };

  handle('config:get', () => {
    const cfg = store.read();
    return {
      ...cfg,
      configPath,
      hasKey: !!cfg.apiKey || Object.values(cfg.keys || {}).some((k) => k && k.trim()),
      providerList: providerList(),
    };
  });

  handle('config:set', (_e, patch) => {
    const cfg = deepMerge(store.read(), patch || {});
    const res = store.write(cfg);
    return { ...res, config: cfg, hasKey: !!cfg.apiKey || Object.values(cfg.keys || {}).some((k) => k && k.trim()) };
  });

  handle('config:clearKey', () => {
    const cfg = store.read();
    cfg.apiKey = '';
    return store.write(cfg);
  });

  handle('app:info', () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    configPath,
  }));

  handle('shell:openConfigFolder', () => {
    try { shell.showItemInFolder(configPath); return true; } catch { return false; }
  });

  /**
   * LLM 流式代理。
   * 放在主进程做的两个原因:
   *   1. 绕开渲染进程的 CORS 限制(各家 API 的 CORS 策略不一致);
   *   2. API Key 不必暴露在页面上下文里。
   * 返回 { ok, status, error, text }；增量通过 llm:chunk 推给渲染进程。
   */
  handle('llm:chat', async (event, spec) => {
    const sender = event.sender;
    const provider = getProvider(spec.provider || 'deepseek');
    // 请求构造与流式解析都走共享模块(与浏览器版、Cloudflare Worker 同一份实现)。
    // 注意:主进程是 CJS,共享模块是 ESM,中间经 llmStream.cjs 用 import() 桥接,
    // 所以这两个函数是异步的 —— 必须 await。
    const built = await buildRequest(spec, provider);
    if (built.error) return { ok: false, status: 0, error: built.error };
    const { url, headers, body, kind } = built;

    const controller = new AbortController();
    if (spec.requestId) llmAborts.set(spec.requestId, controller);
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs || 45000);

    let chunkCount = 0;
    // 累积到这里的正文,一并回推给渲染层方便它显示「已收到的完整文本」
    let fullForEmit = '';
    const emit = (delta, thinking = false) => {
      if (!delta) return;
      chunkCount += 1;
      if (!thinking) fullForEmit += delta;
      try {
        if (!sender.isDestroyed()) {
          sender.send('llm:chunk', {
            requestId: spec.requestId, delta, thinking, full: fullForEmit,
          });
        }
      } catch { /* 窗口关了就算了 */ }
    };

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `接口返回 ${res.status}: ${text.slice(0, 200)}`, chunks: chunkCount };
      }
      if (!res.body) return { ok: false, status: res.status, error: '接口没有返回流式内容' };

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';
      let reasoning = '';
      // 推理阶段 → 正式回答的切换只通知一次
      let answerStarted = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = await consumeSseBuffer(buffer, kind, (c) => {
          if (c.phase === 'reasoning') {
            reasoning += c.reasoning;
            // 推理增量也要推给界面 —— 否则整个思考阶段是空白的
            // (deepseek-flash 先流 137 字推理再流 23 字回答,只推 content 就什么都看不到)
            emit(c.reasoning, true);
            return;
          }
          if (c.phase === 'answer') {
            if (!answerStarted) {
              answerStarted = true;
              try {
                if (!sender.isDestroyed()) sender.send('llm:chunk', { requestId: spec.requestId, reset: true });
              } catch { /* 忽略 */ }
            }
            full += c.text;
            emit(c.text);
          }
        });
      }
      return { ok: true, status: 200, text: full || reasoning, reasoning, chunks: chunkCount };
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      return { ok: false, status: 0, error: aborted ? '请求超时或被取消' : (err?.message || String(err)), chunks: chunkCount };
    } finally {
      clearTimeout(timer);
      if (spec.requestId) llmAborts.delete(spec.requestId);
    }
  });

  handle('llm:abort', (_e, requestId) => {
    const c = llmAborts.get(requestId);
    if (c) { c.abort(); llmAborts.delete(requestId); return true; }
    return false;
  });

  /** 让渲染进程确认主进程还活着(排障用) */
  handle('llm:ping', () => ({ ok: true, providers: providerList().length }));

  return store;
}

module.exports = { registerIpc, makeStore, deepMerge, DEFAULT_CONFIG };
