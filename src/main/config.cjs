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
  // 逐座位的性格(决定打法)。留空 = 随机分配。
  // 与座位显示名无关 —— 名字跟着模型走(相同模型自动加序号)。
  seatPersonas: {},         // { '0': 'nit', '1': 'maniac' }
  // ── 自定义中转站(OpenAI 兼容)─────────────────────────────
  // 中转站的特点:**一个地址 + 多个 Key**,每个 Key 能调的模型不一定相同。
  customEndpoint: '',       // 地址,填到 /v1 为止或完整路径都行(按协议自动补尾巴)
  // protocol:'openai' | 'anthropic' | 'responses' | 'gemini' —— **协议跟着令牌分组走**,
  // 所以必须逐 Key 配置,不能全局一个。PackyAPI 的模型卡片上有协议标签:
  // ANTHROPIC / OPENAI-RESPONSE / OPENAI / GOOGLE(Gemini 原生格式),
  // 见 shared/llmStream.mjs 的 RELAY_PROTOCOLS。
  // gemini 那条地址填到域名或 /v1 都行,路径由 geminiUrl() 自己拼。
  customKeys: [],           // [{ id: 'k1', label: 'Key 1', key: 'sk-...', protocol: 'openai' }]
  seatCustomKeys: {},       // { '0': 'k1' } 座位用哪个 Key;不填 = 第一个
  endpoint: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-flash',     // 与 providers.mjs 里 deepseek 的 defaultModel 一致
  temperature: 1.1,
  // 推理型模型(deepseek-flash / deepseek-v4-pro / qwen3-thinking 等)会先输出
  // 一大段 reasoning_content 再给正式回答,两者共用同一个 max_tokens 预算。
  // 实测 deepseek-flash:max_tokens=300 时推理就吃了 940 字,正式回答被挤掉
  // (finish_reason=length),决策只能从残缺文本硬猜;600 以上才够。
  // 所以默认给足,不然「思考」会挤掉「决策」。
  // 提到 2000:推理已压到最低档(reasoningLevel:'low' —— openai 协议发
  // reasoning_effort:'low'、Gemini 发 thinkingBudget:512),额度基本都留给正文,
  // 再留足冗余,避免「没有可识别的动作」那种截断。
  maxTokens: 2000,
  // 推理档位(四家协议统一,字段映射见 shared/llmStream.mjs 的 REASONING_LEVELS):
  //   'off'     完全关闭(Gemini thinkingBudget:0 / 不 Anthropic thinking / 不发 reasoning_effort)
  //   'low'     **默认**:保留推理但压到各家允许的最低档 —— 关掉推理在难题上会降智,
  //             而牌桌只需要它「别啰嗦」
  //   'default' 什么都不发,走厂商默认
  // ⚠️ 这就是用户实测「等了 78 秒 → 请求超时」的对策之一:默认档会让推理型模型长考,
  //    而推理 token 和正式回答共用额度,长考的另一个后果是正式 JSON 被截断。
  reasoningLevel: 'low',
  // 单次模型调用的超时。45s:一张桌子是**轮流**调用模型的,一个人卡 90 秒,
  // 整桌就停等一分半 —— 实测那比「偶尔退回本地策略」难忍得多。
  // 推理已经压到最低档之后,45s 足够推理型模型想完(实测 low 档推理均长几百字)。
  // ⚠️ 这个值以前是**死字段**:app.js 的 agentCfg 从来没把它传给 agent,
  //    调用层一直只用它自己的 45s 缺省。现已接通。
  timeoutMs: 45000,
  /**
   * 模型调用的重试(临时性失败:超时 / 网络 / 5xx / 无可用渠道 / 过载 / 限流)。
   *
   * 为什么要:上游抖动是**一过性**的 —— 报一次「无可用渠道」「overloaded」,
   * 隔几秒同一条请求就能成。以前一失败就立刻退回本地策略,用户看到的是
   * 「某个模型偶发超时 → 那一手突然变成本地策略在打」,而它下一手又好了。
   *
   * ⚠️ budgetMs 是**一次决策的累计上限**,不是单次调用的超时:
   *    没有它的话「timeoutMs(45s)× 3 次重试 = 135s」,一张桌子是轮流调模型的,
   *    一个人卡 135 秒全桌一起等 —— 那比偶尔退回本地策略难忍得多。
   *    90s = 首次跑满 45s + 一次重试;快速失败(503 通常 1s 内返回)时四次都能试上。
   *    到点立刻兜底,绝不会让一张桌子停等两分钟。
   *
   * ⚠️ 想「任何失败都重试 3 次」(不区分错误类型)就把 classifyErrors 改成 false。
   *    默认 true 时,401/403、协议不对、模型名错、余额不足直接兜底 ——
   *    那几种重试必然同样失败,只会白等 5 秒退避再兜底。
   *
   * 改这里就够:agent.js 的 resolveRetryPolicy 会把它并到默认策略上
   * (单个字段缺省/非法都退回内置默认,不会因为一次手误把重试关掉或开成无限)。
   */
  llmRetry: {
    times: 3,                      // 失败后再试几次(一共最多 1 + 3 次请求)
    backoffMs: [600, 1500, 3000],  // 每次重试前的等待;短退避,不重头等满一个超时
    budgetMs: 90000,               // 一次决策的累计耗时上限
    classifyErrors: true,          // false = 不看错误类型,失败就重试
  },
  game: {
    seats: 6,
    shortDeck: false,
    startingStack: 2000,
    smallBlind: 10,
    bigBlind: 20,
    ante: 0,
    bigBlindAnte: false,      // 大盲前注(与上面的 ante 二选一,见 app.js 的 buildEngine)
    blindLevelUp: false,      // 每 N 手按 21 档表升一档(N 见下面的 blindLevelHands)
    // ★ 升盲周期:每多少**手**按档位表升一档。
    //   ⚠️ 单位改过一次:上一版按「个人回合(orbit = 按钮位转一圈 = 人数手)」算,
    //      用户实测指出单位不对(9 人桌设 3 = 每 27 手才升一档,他以为是一手),
    //      所以现在按手计数,与人数无关。
    //   默认 20:旧默认 10 个 orbit 换算成手数会跟人数走(6 人桌 60 / 9 人桌 90),
    //      而手数只有一个人一个数,取一个与人数无关的整数档 —— 20 手 × 20 次升档
    //      = 400 手到顶档(第 401 手开始是 50,000/100,000),约等于 6 人桌 3.3 圈。
    //      完整推导见 engine.js 的 BLIND_LEVEL_HANDS。
    //   由设置面板的 #blindLevelHands 直通 app.js 的 buildEngine → PokerEngine,
    //   牌局进行中改也立即生效(见 engine.js 的 setBlindLevelHands)。
    //   0 = 永不按档位升盲。
    blindLevelHands: 20,
    // 每 N 手盲注翻倍(0 = 不升盲)。★ 引擎能力保留、但**用户入口已撤掉**
    //   (用户明确要求「不要翻倍的,只要档位那个」)。所以这个字段不会出现在设置面板里,
    //   但配置默认 0 = 不升盲,行为与从前完全一致;面板 collect() 对它
    //   「不读取、也不覆盖」,不会把老配置里的值冲掉。
    blindUpEvery: 0,
  },
  ui: {
    thinkDelayMs: 900,
    autoNextHand: false,
    showThinking: true,
    deckView: 'down',        // down = 全部盖着(默认) | board = 只看公共牌 | up = 全翻开(荷官特权)
  },
};

/** 至少配了一个可用的 Key(含自定义中转站的 customKeys) */
function hasAnyKey(cfg) {
  if (cfg.apiKey) return true;
  if (Object.values(cfg.keys || {}).some((k) => k && String(k).trim())) return true;
  return !!cfg.customEndpoint && (cfg.customKeys || []).some((k) => k?.key && String(k.key).trim());
}

/**
 * 深合并配置补丁。
 *
 * `null` 表示**删除这个键** —— 这是必要的:像 seatPersonas 这种「按座位覆盖」
 * 的字典,用户把某个座位改回「随机」时得能把那一条删掉。如果只是合并,
 * 空对象不会删任何东西,那一条会一直留着,用户就再也回不到随机了。
 */
function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) { delete out[k]; continue; }          // null = 显式删除
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

/**
 * 清掉已废弃的配置键 —— 目前只有一个:game.blindLevelOrbits。
 *
 * 它是上一版加的「每 N 个人回合升一档」的周期,单位错了(9 人桌 1 个回合 = 9 手),
 * 已被 game.blindLevelHands(按手)取代。这里**只删键、不迁移数值**:
 *   · 旧值是在「回合」这个错单位下填进去的。乘上人数看似"保留原手感",
 *     实际会造出一个用户从没打算要的数字 —— 他填 3 想的是 3 手,×6 变 18 手,
 *     对他来说还是「设了没反应」,只是换了个样子;
 *   · 这个键从没进过任何一次提交(是工作区里未发布的改动),不存在"老配置要靠它"的问题;
 *   · 留着才是真麻烦:仓库里已经有过「死字段」—— 键在配置里、没人读、排查时
 *     以为它还在起作用。删掉后 blindLevelHands 走默认值,设置面板里那格会显示
 *     明确的「每 N 手升一档」,用户看一眼就能重填。
 */
function stripLegacyKeys(cfg) {
  if (!cfg || !cfg.game || cfg.game.blindLevelOrbits === undefined) return cfg;
  // 复制一层再删:deepMerge 在「补丁里没有 game 这一支」时会直接把 DEFAULT_CONFIG.game
  // 的引用交出来,原地 delete 会动到默认配置(下次读就少一个键)。
  const out = { ...cfg, game: { ...cfg.game } };
  delete out.game.blindLevelOrbits;
  return out;
}

function makeStore(configPath) {
  function read() {
    try {
      return stripLegacyKeys(deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(configPath, 'utf8'))));
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
      hasKey: hasAnyKey(cfg),
      providerList: providerList(),
    };
  });

  handle('config:set', (_e, patch) => {
    const cfg = deepMerge(store.read(), patch || {});
    const res = store.write(cfg);
    return { ...res, config: cfg, hasKey: hasAnyKey(cfg) };
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
    // 流里报出来的错误(共享解析器在 finish 事件上带出来的 error 字段)。
    // ⚠️ 以前这里**直接忽略**了 finish 通道,于是「HTTP 200 + 流里 response.failed」
    //    被当成一次成功、text 为空 —— 调用方只能看到「模型没给出可识别动作」这种
    //    误导性的结论,真正的死因(上游渠道不可用 / 额度不足)一个字都没露出来。
    //    连通性测试按钮的全部价值就是把这种话原样交给用户,所以必须接住。
    let streamError = '';
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
          if (c.error) { streamError = String(c.error); return; }
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
      // 流里报错要当失败(原文带上),不能返回一个「成功的空文本」
      if (streamError) return { ok: false, status: 200, error: `上游流里报错:${streamError}`, chunks: chunkCount };
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
