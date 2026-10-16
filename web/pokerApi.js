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
  // 与桌面版 src/main/config.cjs 保持一致:2000。
  maxTokens: 2000,
  // 推理档位:与桌面版同一套(字段映射见 src/shared/llmStream.mjs 的 REASONING_LEVELS)。
  // 'low' = 保留推理但压到各家最低档,'off' = 完全关闭,'default' = 走厂商默认。
  // ⚠️ 两边的默认值必须一样,否则「网页版好好的、桌面版超时」这类差异没人查得出来。
  reasoningLevel: 'low',
  timeoutMs: 45000,
  // Worker 转发地址:部署后填自己的,或走同源 /api/llm
  workerUrl: '',
  // 自定义中转站(与 config.cjs 的默认值保持一致)。
  // protocol 逐 Key 配置 —— 中转站的令牌分组不同,协议就不同,
  // 可选 openai / anthropic / responses / **gemini**(Google 原生格式),
  // 见 shared/llmStream.mjs 的 RELAY_PROTOCOLS。
  customEndpoint: '',
  customKeys: [],
  seatCustomKeys: {},
  game: {
    seats: 6,
    shortDeck: false,
    startingStack: 2000,
    smallBlind: 10,
    bigBlind: 20,
    ante: 0,
    bigBlindAnte: false,
    blindLevelUp: false,
    // 每多少**手**按档位表升一档(0 = 不按档位升盲)。
    // ⚠️ 单位改过一次:上一版是「个人回合(orbit)」,用户实测指出不对(9 人桌设 3
    //    = 每 27 手才升一档),现在按手算,与人数无关。默认 20,推导见
    //    engine.js 的 BLIND_LEVEL_HANDS。
    // ⚠️ 与 config.cjs 的默认值必须一致,否则「网页版一开局就升档、桌面版不升」这类
    //    差异没人查得出来(同一个坑在 reasoningLevel / timeoutMs 上踩过)。
    blindLevelHands: 20,
    blindUpEvery: 0,
    humanSeat: null,
  },
  ui: {
    thinkDelayMs: 900,
    autoNextHand: false,
    // ⚠️ showThinking 已删(与 config.cjs 同步):顶栏的「💭 气泡」按钮和设置里的
    //    「显示思考气泡」都没了,思考文字在气泡里恒为显示。
    //    两端默认值必须一致 —— 否则会出现「网页版还认这个键、桌面版不认」的差异。
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

/**
 * 清掉已废弃的配置键(game.blindLevelOrbits 和 ui.showThinking)。
 *
 * 与桌面版 config.cjs 的 stripLegacyKeys 同一份规矩:**只删键、不迁移数值** ——
 * 旧值是在「个人回合」这个错单位下填的,乘人数会造出一个用户从没打算要的数字。
 * 两端的迁移规则必须一致,否则「网页版还认旧键、桌面版不认」这种差异没人查得出来。
 *
 * ui.showThinking 是「气泡里显不显示思考文字」的旧开关(顶栏按钮 + 设置开关都删了,
 * 现在恒为显示)。老配置里存着的 false 必须一并删掉,不然「配置写着 false、
 * 气泡却照样显示文字」会被当成 bug 查。
 */
function stripLegacyKeys(cfg) {
  if (!cfg) return cfg;
  const hasOrbits = cfg.game?.blindLevelOrbits !== undefined;
  const hasThinking = cfg.ui?.showThinking !== undefined;
  if (!hasOrbits && !hasThinking) return cfg;
  const out = { ...cfg };
  if (hasOrbits) { out.game = { ...cfg.game }; delete out.game.blindLevelOrbits; }
  if (hasThinking) { out.ui = { ...cfg.ui }; delete out.ui.showThinking; }
  return out;
}

function readConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    return stripLegacyKeys(deepMerge(DEFAULT_CONFIG, JSON.parse(raw)));
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
  if (Object.values(cfg.keys || {}).some((k) => k && String(k).trim())) return true;
  // 自定义中转站的 Key 存在 customKeys 里,不在 keys 里
  return !!cfg.customEndpoint && (cfg.customKeys || []).some((k) => k?.key && String(k.key).trim());
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
  // 流里报出来的错误(共享解析器在 finish 事件上带出来的 error 字段)。
  // ⚠️ 以前这里**直接忽略**了 finish 通道,于是「HTTP 200 + 流里 response.failed」
  //    被当成一次成功、text 为空 —— 调用方只能看到「模型没给出可识别动作」这种
  //    误导性的结论,真正的死因(上游渠道不可用 / 额度不足)一个字都没露出来。
  //    桌面版 config.cjs 里是同一处改动,两边必须一起改(否则又变成「一条路径一个样」)。
  let streamError = '';
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
        if (c.error) { streamError = String(c.error); return; }
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
    // 流里报错要当失败(原文带上),不能返回一个「成功的空文本」
    if (streamError) return { ok: false, status: 200, error: `上游流里报错:${streamError}`, chunks: chunkCount };
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
