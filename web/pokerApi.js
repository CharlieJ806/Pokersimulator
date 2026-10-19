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
// 游戏默认值的**唯一真源**(桌面版 config.cjs 通过 gameDefaults.cjs 同步桥接读同一份)。
import { DEFAULT_GAME_ID, gameDefaultsAll } from './src/shared/gameDefaults.mjs';

const STORAGE_KEY = 'poker-dealer/config/v1';

/**
 * 与桌面版 src/main/config.cjs 的 DEFAULT_CONFIG **逐字段一致**
 * (global / games 两层的 deepEqual 由 tools/configmigrate.mjs 盯着)。
 *
 * 三层结构,理由见桌面版那份注释,这里只记两端相关的坑:
 *   · global —— API / 模型 / 代理行为,对所有游戏生效;
 *   · games[gameId] —— 只对那个游戏生效的规则(一期只有 poker);
 *   · ui —— 界面与节奏。⚠️ 这一期**刻意不动**(归属二期再议)。
 *
 * ⚠️ 两端的默认值必须一样,否则「网页版一开局就升档、桌面版不升」
 *    「网页版还认某个键、桌面版不认」这类差异没人查得出来。
 *    这个仓库在 reasoningLevel / timeoutMs / blindLevelHands 上都踩过。
 */
const DEFAULT_CONFIG = {
  global: {
    defaultProvider: 'deepseek',
    keys: {},
    seatProviders: {},
    seatModels: {},
    // 逐座位的性格(决定打法;名字跟着模型走,与此无关)。
    // 网页版以前漏了这一格 —— 模型面板有「性格」下拉,存进去却没有默认值,
    // 默认结构两端不一致,测试立刻能看出来。
    seatPersonas: {},
    // 自定义中转站(与 config.cjs 的默认值保持一致)。
    // protocol 逐 Key 配置 —— 中转站的令牌分组不同,协议就不同,
    // 可选 openai / anthropic / responses / **gemini**(Google 原生格式),
    // 见 shared/llmStream.mjs 的 RELAY_PROTOCOLS。
    customEndpoint: '',
    customKeys: [],
    seatCustomKeys: {},
    // 单厂商时代的兼容字段。仍有读者(hasAnyKey / app.js 的 agentCfg /
    // 模型面板的 apiKey→keys 迁移),迁移时必须一起从顶层搬进来。
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
    // 'off' = 完全关闭,'low' = 压到各家最低档,'default' = 走厂商默认。
    // ⚠️ 默认是 'default' 而不是 'low',理由同桌面版 config.cjs:对本来不思考的模型
    //    (deepseek-chat 这类),`reasoning_effort:'low'` 是**打开**推理而不是降低它 ——
    //    实测 42 倍 completion token、3 倍耗时,答案一字不差,还容易把正式回答挤出 max_tokens。
    reasoningLevel: 'low',
    timeoutMs: 45000,
    // 模型调用的重试策略。桌面版一直在用它(agent.js 的 resolveRetryPolicy 读它),
    // 网页版以前默认值里没有 —— 不是「网页版不需要」,而是漏了:网页版同样会遇到
    // 超时 / 5xx / 过载,缺这一格等于把两端的重试行为改成了不一样。
    llmRetry: {
      times: 3,
      backoffMs: [600, 1500, 3000],
      budgetMs: 90000,
      classifyErrors: true,
    },
    /**
     * 全局排行榜的权重 —— 与桌面版 src/main/config.cjs 的 `global.leaderboard`
     * **逐字段一致**(configmigrate 的 deepEqual 盯着两端)。
     *
     * 公式与逐项理由写在 src/shared/leaderboard.mjs 的文件头(那里是唯一真源):
     *   名次分 = 参战人数 - 名次;权重 W = 游戏系数 × 回合系数 × 人数系数;
     *   全局分 = round(名次分 × W)。
     *
     * ⚠️ 网页版这层配置也有用:权重是**用户可调设置**,不是排行榜数据。
     *    排行榜数据本身落在 localStorage 的 poker-dealer/leaderboard/v1,
     *    与配置分开(见 shared/leaderboard.mjs 的存储说明)。
     */
    leaderboard: {
      enabled: true,
      gameWeights: { poker: 1.0, undercover: 1.0, werewolf: 1.2, avalon: 1.2 },
      defaultGameWeight: 1.0,
      rounds: { step: 0.05, max: 1.5 },
      seats: { step: 0.05, base: 4, max: 1.5 },
      maxRows: 200,
    },
  },
  games: gameDefaultsAll(),
  // Worker 转发地址:部署后填自己的,或走同源 /api/llm。
  // ⚠️ 刻意留在**顶层**、没有并进 global:它是「网页版怎么把请求送出去」的部署参数,
  //    桌面版走主进程代理、根本没有这个概念。放进 global 等于给桌面版塞一个永远
  //    没人读的键(本仓库反复踩的「死字段」)。留在顶层,global 才能两端逐字相等。
  workerUrl: '',
  ui: {
    thinkDelayMs: 900,
    autoNextHand: false,
    // ⚠️ showThinking 已删(与 config.cjs 同步):顶栏的「💭 气泡」按钮和设置里的
    //    「显示思考气泡」都没了,思考文字在气泡里恒为显示。
    deckView: 'down',
    flowMode: 'manual',
    flowSpeed: 1,
    // ⚠️ 这一层这一期**刻意不动**(flowMode / flowSpeed 的归属二期再议),
    //    与桌面版 ui 的差异也照原样保留。tools/configmigrate.mjs 把这份差异
    //    钉成了显式清单:哪天有人在一边加/删了 ui 键,测试会红,而不是悄悄漂移。
  },
};

/** 只认真正的「纯对象」,数组和 null 都不算 */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 旧配置里曾经平铺在顶层的全局字段 —— 迁移白名单。
 * ⚠️ 必须与桌面版 config.cjs 的 LEGACY_GLOBAL_FIELDS **逐字一致**:
 *    两端迁移规则不一致的话,同一份配置在桌面版和网页版搬出来就是两套值。
 */
const LEGACY_GLOBAL_FIELDS = [
  'defaultProvider', 'keys', 'seatProviders', 'seatModels', 'seatPersonas',
  'customEndpoint', 'customKeys', 'seatCustomKeys',
  'endpoint', 'apiKey', 'model', 'temperature', 'maxTokens',
  'reasoningLevel', 'timeoutMs', 'llmRetry',
];

/**
 * 旧扁平配置 → 新分层配置(global / games[gameId])。
 *
 * ⚠️ 必须在 `deepMerge(DEFAULT_CONFIG, raw)` **之前**跑:合并之后新位置已经被
 *    默认值填满,「新位置没有这个键才搬」的判据永远为假 —— 旧值一个都搬不过去,
 *    而且不报错,只表现为「一打开设置全是默认值」(用户会以为配置被重置了)。
 *
 * 幂等:新位置的值优先,旧键只补空缺;连读两次结果相同。
 * 与桌面版 config.cjs 的同名函数逐条对齐(包括 gameId 参数:那边默认也是
 * DEFAULT_GAME_ID,不写死 'poker' —— 二期主页有游戏选择后要能传别的)。
 *
 * @param {object} cfg
 * @param {string} [gameId] 旧 game.* 搬到 games 的哪个游戏下
 */
function migrateLegacyConfig(cfg, gameId = DEFAULT_GAME_ID) {
  if (!isPlainObject(cfg)) return cfg;

  const legacyGlobal = LEGACY_GLOBAL_FIELDS.filter((k) => cfg[k] !== undefined);
  const hasLegacyGame = Object.prototype.hasOwnProperty.call(cfg, 'game');
  if (!legacyGlobal.length && !hasLegacyGame) return cfg;

  const out = { ...cfg };

  if (legacyGlobal.length) {
    const g = { ...(isPlainObject(cfg.global) ? cfg.global : {}) };
    for (const k of legacyGlobal) {
      if (g[k] === undefined) g[k] = cfg[k];
      delete out[k];
    }
    out.global = g;
  }

  if (hasLegacyGame) {
    const games = { ...(isPlainObject(out.games) ? out.games : {}) };
    const cur = { ...(isPlainObject(games[gameId]) ? games[gameId] : {}) };
    if (isPlainObject(cfg.game)) {
      for (const [k, v] of Object.entries(cfg.game)) {
        // blindLevelOrbits 是已废弃的旧键(单位错的那版):**只删不迁**,
        // 理由见 stripLegacyKeys 的注释。
        if (k === 'blindLevelOrbits') continue;
        if (cur[k] === undefined) cur[k] = v;
      }
    }
    games[gameId] = cur;
    out.games = games;
    delete out.game;
  }

  return out;
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    // ★ `null` = **删除这个键** —— 与桌面版 config.cjs 的 deepMerge 同义。
    //   网页版以前没有这一条(null 会被当普通值写进去),于是「把某个座位改回
    //   随机性格」在桌面版是删键、在网页版留下一条 seatPersonas.0 = null。
    //   运行时看着差不多,但配置里会慢慢堆一堆 null,而且「删键」在两端的语义
    //   不再是同一件事 —— 这正是本仓库反复踩的「只在一端改」。
    if (v === null) { delete out[k]; continue; }
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
 * 清掉已废弃的配置键(现在只剩 ui.showThinking)。
 *
 * 与桌面版 config.cjs 的 stripLegacyKeys 同一份规矩:**只删键、不迁移数值** ——
 * 旧值是在「个人回合」这个错单位下填的,乘人数会造出一个用户从没打算要的数字。
 * 旧的 game.blindLevelOrbits 由 migrateLegacyConfig 处理(整组搬家时跳过它,
 * 旧位置随之消失);这里再兜一道,防手改过的配置把旧键写进 games.poker。
 *
 * ui.showThinking 是「气泡里显不显示思考文字」的旧开关(顶栏按钮 + 设置开关都删了,
 * 现在恒为显示)。老配置里存着的 false 必须一并删掉,不然「配置写着 false、
 * 气泡却照样显示文字」会被当成 bug 查。
 */
function stripLegacyKeys(cfg) {
  if (!cfg) return cfg;
  const games = cfg.games;
  // 每个游戏都扫一遍(不写死 games.poker):清理逻辑没必要知道
  // blindLevelOrbits 是哪个游戏的旧键,以后加的游戏也不会被误伤别的键。
  const gamesWithOrbits = isPlainObject(games)
    ? Object.keys(games).filter((id) => games[id]?.blindLevelOrbits !== undefined)
    : [];
  const hasThinking = cfg.ui?.showThinking !== undefined;
  if (!gamesWithOrbits.length && !hasThinking) return cfg;
  const out = { ...cfg };
  if (gamesWithOrbits.length) {
    out.games = { ...games };
    for (const id of gamesWithOrbits) {
      out.games[id] = { ...games[id] };
      delete out.games[id].blindLevelOrbits;
    }
  }
  if (hasThinking) { out.ui = { ...cfg.ui }; delete out.ui.showThinking; }
  return out;
}

function readConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    // ⚠️ 先迁移再合默认值(理由见 migrateLegacyConfig)。
    return stripLegacyKeys(deepMerge(DEFAULT_CONFIG, migrateLegacyConfig(JSON.parse(raw))));
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
  // 容错:允许被「旧形状」调用(cfg 本身就是 global 那一层)。
  const g = isPlainObject(cfg?.global) ? cfg.global : (cfg || {});
  if (g.apiKey && g.apiKey.trim()) return true;
  if (Object.values(g.keys || {}).some((k) => k && String(k).trim())) return true;
  // 自定义中转站的 Key 存在 customKeys 里,不在 keys 里
  return !!g.customEndpoint && (g.customKeys || []).some((k) => k?.key && String(k.key).trim());
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
      // 与桌面版 config:clearKey 同义:apiKey(单厂商兼容字段)和逐厂商的 keys
      // 一起清。以前桌面版只清 apiKey,网页版两样都清 —— 同名操作两端不同义。
      const cfg = readConfig();
      return writeConfig({ ...cfg, global: { ...cfg.global, apiKey: '', keys: {} } });
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

export {
  readConfig, writeConfig, resolveWorkerUrl, DEFAULT_CONFIG, STORAGE_KEY,
  // 纯函数也导出:tools/configmigrate.mjs 要拿它和桌面版逐条比对
  //(迁移/清理/深合并/判 Key 的规则必须两端同义)。
  deepMerge, migrateLegacyConfig, stripLegacyKeys, hasAnyKey, LEGACY_GLOBAL_FIELDS,
  DEFAULT_GAME_ID,
};
