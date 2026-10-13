/**
 * 浏览器版的 window.pokerAPI 实现。
 *
 * 桌面版这个接口由 Electron 的 preload(contextBridge + ipcRenderer)提供,
 * 浏览器版没有主进程,所以在这里用 Web API 实现同一套接口,
 * 让 src/ 里的业务代码一行都不用改。
 *
 * 接口对照:
 *   getConfig()   → localStorage 读取(桌面版读 userData/settings.json)
 *   setConfig(p)  → localStorage 深合并写入
 *   clearKey()    → 清掉所有厂商的 Key
 *   appInfo()     → 返回浏览器信息(桌面版返回 Electron 版本)
 *   llmChat(spec) → POST 到 Cloudflare Worker 转发(桌面版走主进程代理)
 *   llmAbort(id)  → AbortController 取消
 *   llmPing()     → 探测 Worker 是否可达
 *
 * 安全说明(方案 A:用户自带 Key):
 *   Key 存在**本机 localStorage**,只在你主动点「开始牌局」时随请求发给
 *   你自己部署的 Worker,再由 Worker 转发给厂商。Worker 不落盘、不记录。
 *   这意味着:① 换设备/换浏览器要重新填;② 共用电脑时同浏览器其他页面理论上
 *   能读到 localStorage(同源限制下风险有限,但请勿在公用电脑上保存 Key)。
 */

// 浏览器侧走 .mjs 包装 —— .cjs 无法被具名导入(见 src/shared/providers.mjs 的说明)
import { providerList, getProvider, PROVIDERS } from './src/shared/providers.mjs';
import { buildRequest, consumeSseBuffer } from './src/shared/llmStream.mjs';

const STORAGE_KEY = 'poker-dealer/config/v1';

/** 与桌面版 src/main/config.cjs 的 DEFAULT_CONFIG 保持一致 */
const DEFAULT_CONFIG = {
  defaultProvider: 'deepseek',
  keys: {},
  seatProviders: {},
  seatModels: {},
  endpoint: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-flash',
  temperature: 1.1,
  // 推理型模型(deepseek-flash 等)先输出 reasoning_content 再给正式回答,
  // 两者共用同一个 max_tokens。实测 max_tokens=300 时推理就把额度吃光、
  // 正式回答被挤掉(finish_reason=length),决策只能从残缺文本硬猜。默认给足。
  maxTokens: 1200,
  timeoutMs: 45000,
  // Worker 转发地址:部署后填自己的,或走同源 /api/llm
  workerUrl: '',
  game: {
    seats: 6,
    shortDeck: false,
    startingStack: 2000,
    smallBlind: 10,
    bigBlind: 20,
    ante: 0,
    bigBlindAnte: false,
    blindLevelUp: false,
    blindUpEvery: 0,
    humanSeat: null,
  },
  ui: {
    thinkDelayMs: 900,
    autoNextHand: false,
    showThinking: true,
    deckView: 'down',
    flowMode: 'manual',
    flowSpeed: 1,
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

/* ------------------------------------------------------------ 存储 */

function readConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function writeConfig(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    return { ok: true, path: 'localStorage' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function hasAnyKey(cfg) {
  if (cfg.apiKey && cfg.apiKey.trim()) return true;
  return Object.values(cfg.keys || {}).some((k) => k && String(k).trim());
}

/* ------------------------------------------------------------ Worker 转发 */

/** 正在进行的请求(用于取消) */
const inflight = new Map();

/**
 * 默认转发地址:
 *   · 配置里填了 workerUrl 就用它;
 *   · 否则用同源 /api/llm(适合把前端和 Worker 部署在一起,或本地 dev 代理)。
 */
function resolveWorkerUrl(cfg) {
  const explicit = String(cfg.workerUrl || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return `${location.origin}/api/llm`;
}

/**
 * 发起一次流式对话。
 * @param {object} spec 与桌面版一致的请求描述
 * @param {{onDelta?:(delta:string, full:string, thinking:boolean)=>void, onReset?:()=>void}} hooks
 *   onDelta 的第三个参数 thinking=true 表示这是「推理阶段」的增量(界面可弱化显示);
 *   onReset 在推理结束、正式回答开始时触发一次(界面据此切换显示)。
 */
async function llmChat(spec, hooks = {}) {
  const cfg = readConfig();
  const provider = getProvider(spec.provider || 'deepseek');
  const built = buildRequest(spec, provider);
  if (built.error) return { ok: false, status: 0, error: built.error };

  const workerUrl = resolveWorkerUrl(cfg);
  const controller = new AbortController();
  if (spec.requestId) inflight.set(spec.requestId, controller);
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs || 45000);

  let chunkCount = 0;
  let full = '';
  let reasoning = '';
  // 推理阶段 → 正式回答的切换只通知一次
  let answerStarted = false;

  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 目标地址与请求体交由 Worker 原样转发;
        // 认证头由 Worker 按模板拼(避免浏览器端设置被禁止的请求头)。
        url: built.url,
        headers: built.headers,
        body: built.body,
        kind: built.kind,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Worker 自己出错时通常是 JSON {error}
      let msg = `转发层返回 ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error) msg = j.error; } catch { if (text) msg = `${msg}: ${text.slice(0, 200)}`; }
      return { ok: false, status: res.status, error: msg, chunks: chunkCount };
    }
    if (!res.body) return { ok: false, status: res.status, error: '转发层没有返回流式内容' };

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseBuffer(buffer, built.kind, (c) => {
        if (c.phase === 'reasoning') {
          reasoning += c.reasoning;
          // 推理增量也要推给界面 —— 否则整个思考阶段是空白的
          try { hooks.onDelta?.(c.reasoning, reasoning, true); } catch { /* 界面出错不影响主流程 */ }
          return;
        }
        if (c.phase === 'answer') {
          if (!answerStarted) {
            answerStarted = true;
            // 通知界面:推理结束,接下来是正式回答(界面据此清掉推理文本)
            try { hooks.onReset?.(); } catch { /* 忽略 */ }
          }
          full += c.text;
          chunkCount += 1;
          try { hooks.onDelta?.(c.text, full, false); } catch { /* 界面出错不影响主流程 */ }
        }
      });
    }
    return { ok: true, status: 200, text: full || reasoning, reasoning, chunks: chunkCount };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false, status: 0,
      error: aborted ? '请求超时或被取消' : (err?.message || String(err)),
      chunks: chunkCount,
    };
  } finally {
    clearTimeout(timer);
    if (spec.requestId) inflight.delete(spec.requestId);
  }
}

/* ------------------------------------------------------------ 对外接口 */

export function installWebApi() {
  const api = {
    isWeb: true,

    getConfig: async () => {
      const cfg = readConfig();
      return {
        ...cfg,
        configPath: '浏览器 localStorage',
        hasKey: hasAnyKey(cfg),
        providerList: providerList(),
      };
    },

    setConfig: async (patch) => {
      const cfg = deepMerge(readConfig(), patch || {});
      const res = writeConfig(cfg);
      return { ...res, config: cfg, hasKey: hasAnyKey(cfg) };
    },

    clearKey: async () => {
      const cfg = readConfig();
      cfg.apiKey = '';
      cfg.keys = {};
      return writeConfig(cfg);
    },

    appInfo: async () => ({
      web: true,
      ua: navigator.userAgent,
      // 桌面上这里返回 Electron/Node/Chrome 版本,浏览器版给等价的可用信息
      chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '',
      configPath: '浏览器 localStorage',
      secureContext: window.isSecureContext,
      dpr: window.devicePixelRatio,
    }),

    // 桌面版可以「打开配置文件夹」,浏览器没有这个概念 —— 保留接口避免调用方判断
    openConfigFolder: async () => false,

    llmPing: async () => {
      const cfg = readConfig();
      const url = resolveWorkerUrl(cfg);
      try {
        const r = await fetch(url, { method: 'GET' });
        const j = await r.json().catch(() => null);
        return { ok: r.ok && j?.ok !== false, status: r.status, url, providers: providerList().length, detail: j };
      } catch (err) {
        return { ok: false, status: 0, url, error: err?.message || String(err) };
      }
    },

    llmChat,
    llmAbort: (requestId) => {
      const c = inflight.get(requestId);
      if (c) { c.abort(); inflight.delete(requestId); return true; }
      return false;
    },
  };

  window.pokerAPI = api;
  // 方便在控制台排查
  window.__pokerWeb = { readConfig, writeConfig, resolveWorkerUrl, PROVIDERS, DEFAULT_CONFIG };
  return api;
}

export { readConfig, writeConfig, resolveWorkerUrl, DEFAULT_CONFIG, STORAGE_KEY };
