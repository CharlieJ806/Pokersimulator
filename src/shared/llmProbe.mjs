/**
 * 模型配置「连通性测试」的判定逻辑(**唯一真源**,不碰 DOM)
 *
 * 为什么单独一个模块、而且一行 DOM 都不写:
 *   这段逻辑必须能被 `node tools/relayprobe.mjs` 直接跑起来。这个仓库里
 *   Electron 脚本很容易卡死(用户已经为它抱怨过两次),所以「按钮点了到底有没有用」
 *   不能只靠开窗口验证 —— 把「怎么拼探活请求」「怎么判定结果」「结果该说什么话」
 *   全放在这里,界面只负责画,测试就能纯 Node 跑,和界面走的是同一份代码。
 *
 * 为什么探活**必须**走 window.pokerAPI.llmChat,而不是自己 fetch 目标地址:
 *   网页版所有外部请求都由用户自己部署的 Worker 转发(白名单 + 绕开 CORS)。
 *   面板自己 fetch 的话,浏览器会因为 CORS / 白名单直接失败 ——
 *   于是「明明能用的配置被判成不通」,比没有这个按钮更糟(用户会去改本来没错的东西)。
 *   桌面版同理走主进程 IPC(Key 不进页面上下文)。所以这里只认 llmChat,别的路一条都不走。
 *
 * 关键词:探活不是要答案。prompt 最短、输出额度 64、**一个思考参数都不发**
 * (理由见 PROBE_REASONING_LEVEL —— 这条链没有参数降级重试,发出去被拒就是误报),
 * 目的是「拿一个明确的成败结论」,不是让模型干活。
 */

import { normalizeProtocol, kindForProtocol } from './llmStream.mjs';

/** 硬超时(毫秒)。探活请求本身极短,20 秒还没动静就是真有问题 */
export const PROBE_TIMEOUT_MS = 20000;

/**
 * 探活的输出额度。
 *
 * 为什么给 16:探活只要求模型「开口」,不要求它说完整。额度给大了有两个坏处 ——
 * ① 用户点一下按钮就真花钱(有些模型 16 token 也是按次计费,但至少不会几十倍);
 * ② 慢。实测同一家中转站,额度 300 和 16 的排队延迟差不多,但输出阶段差好几秒。
 */
/**
 * 探活的输出额度。
 *
 * ⚠️ 别给太小。原来用 16,对**推理型模型**(Gemini 2.5+/3.x 默认开思考通道、
 *    o 系列、各种 thinking 型号)连一段推理都吐不完,表现为
 *    「HTTP 200 但流里一个字都没有」—— 用户实测就撞上了,还被误判成配置错。
 * 64 足够让普通模型吐一两个汉字,也让推理模型至少留下一点痕迹
 * (真有残留也由 runProbe 的 chunks>0 分支接住,判成「通」)。
 * 这点额度花不了钱:探活本来就是要极省。
 */
export const PROBE_MAX_TOKENS = 64;

/** 探活用的最小 prompt。系统提示压成一句话,避免任何「你必须输出 JSON」之类的约束干扰 */
export const PROBE_SYSTEM = '探活测试,收到就回一个字:好';
export const PROBE_USER = 'hi';

/**
 * 探活请求用的推理档位:**固定 default(一个推理字段都不发)**。
 *
 * 为什么探活不跟着真实调用走最低档 —— 这不是偷懒,是探活这条路**没有兜底**:
 *   ① 参数降级重试(按上游报错摘掉字段再试)只存在于 agent.js 的真实对局路径,
 *      llmChat / 主进程代理 / Worker 转发这条链上没有任何重试。一旦某个模型不认
 *      我们发的思考参数,按钮就会把一个**完全正确的配置**报成 ❌,
 *      用户于是去改本来就没错的东西 —— 比没有这个按钮更糟。
 *   ② 「最低档」里 Anthropic 的 budget_tokens 最小就是 1024,而探活额度只有 64
 *      (PROBE_MAX_TOKENS,极省),上游要求 budget_tokens < max_tokens —— 带着它每一条
 *      Claude 探活都会 400;把额度抬到 1024 以上又等于让每次探活都真花一笔推理钱。
 *   ③ Gemini 的「关闭档」是 thinkingBudget:0,而 0 在 2.5 Pro 这类型号上会被拒。
 *   ⇒ 探活只验「地址 / Key / 协议 / 模型名」这道关,一个可选的思考参数都不发;
 *     报文里唯一的推理相关字段就是**不该出现**的字段(测试里反向断言)。
 *     真实对局发什么档位、四个协议各自的字段对不对,由 tools/relayprotocol.mjs
 *     用假中转站严格校验(那边没有额度限制,可以逐字比对报文)。
 */
export const PROBE_REASONING_LEVEL = 'default';

/**
 * 测「中转站 Key」时用的占位模型名。
 *
 * 为什么要一个**很可能存在、但一定最便宜**的名字,而不是让用户填:
 *   Key 行的位置没有模型名(模型名是逐座位填的),但请求体里必须有 model 字段,
 *   否则上游会先报「缺少 model」,那什么都验证不出来。
 *
 * 为什么按协议给不同的名字:四种协议的模型命名空间不通用 ——
 *   拿 `gpt-4o-mini` 去打 Anthropic 协议的 /v1/messages,上游会回 model_not_found,
 *   那就分不清「是这个 Key 不行」还是「名字不属于这个协议」。
 *   ⚠️ Gemini 尤其明显:它的 URL 里**含模型名**(/models/{模型}:streamGenerateContent),
 *      拿 gpt-4o-mini 去拼会得到一个 Google 侧根本不存在的路径,报错也说不清是哪一步错。
 * 顺带这也是这个按钮最有价值的输出:如果上游回的是「模型不存在」,
 * 说明**地址、Key、协议三样都通了**(请求已经被正确解析和鉴权,只是模型名不在这个分组里),
 * 要能在结果里说清这一点,否则用户会以为 Key 配错了。
 */
export const PROBE_MODEL = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  responses: 'gpt-4o-mini',
  // Gemini 侧通用的便宜型号(2.5-flash 有免费层,各家中转站基本都挂)
  gemini: 'gemini-2.5-flash',
};

/* ------------------------------------------------------------ 错误归因 */

/**
 * 「协议不对」的措辞。**判定优先级最高**。
 *
 * 为什么必须先判它:上游那句「模型 claude-sonnet-5-5 不支持 chat completions 协议」
 * 里同时含「模型」和「不支持」,先按模型名去判就会误判成「模型名错」,
 * 把用户引到完全错误的方向(去改一个本来没错的模型名)。
 * 这正是这个按钮要避免的事,所以顺序不能反。
 */
const RE_PROTOCOL = /protocol[_ \-]?not[_ \-]?supported|unsupported[_ \-]?protocol|not support[^,;{}]{0,20}(chat completions|messages api|responses api)|不支持[^,;{}]{0,20}(chat completions|协议|protocol)/i;

/** 「模型名不对」的措辞 —— 各家中转站说法不一,多认几种。刻意不含「不支持」,见上面 */
const RE_MODEL_MISSING = /model[_ \-]?not[_ \-]?found|no such model|unknown model|invalid[_ \-]?model|not found[^,;{}]{0,20}model|模型[^。;{}]{0,12}(不存在|未找到|无效)|无可用渠道|no available channel|does not exist/i;

/** 「Key / 鉴权 / 额度」类措辞 */
const RE_AUTH = /invalid[_ \-]?api[_ \-]?key|incorrect api key|unauthorized|authentication|invalid token|令牌[^。;{}]{0,10}(无效|错误|过期)|无效的(密钥|令牌|key)|余额|欠费|insufficient|quota|exceeded your current quota|forbidden|401|403/i;

/**
 * 「转发层白名单」——网页版特有的一种失败,而且要**排在鉴权之前**判。
 *
 * 为什么值得单独一条:它长得像「Key 不行」(HTTP 403),但根因和 Key 一点关系都没有 ——
 * 是用户部署的 Worker 不允许转发到这个域名。指错方向的话用户会去反复重填 Key,
 * 永远查不出问题(面板的说明文字里也专门写过这件事)。
 */
const RE_WHITELIST = /不在白名单|白名单|EXTRA_ALLOWED_HOSTS|ALLOWED_ORIGINS|目标域名|not in the allowlist/i;

/**
 * 把上游的原始错误文本归因。
 *
 * ⚠️ 这里**只做归类,绝不改写、绝不吞掉原文**。界面上必须把原文照登出来 ——
 * 用户排查靠的就是那几个英文关键词(protocol_not_supported / model_not_found),
 * 我们写多少句中文解释都替代不了它。
 * @returns {'protocol'|'model'|'whitelist'|'auth'|'other'}
 */
export function probeCause(text) {
  const t = String(text || '');
  if (RE_PROTOCOL.test(t)) return 'protocol';
  if (RE_MODEL_MISSING.test(t)) return 'model';
  // 白名单要排在鉴权前面:它也是 403,但和 Key 一点关系都没有
  if (RE_WHITELIST.test(t)) return 'whitelist';
  if (RE_AUTH.test(t)) return 'auth';
  return 'other';
}

/* ------------------------------------------------------------ 请求组装 */

/** 探活请求的公共部分(与真实调用**同一套**构造路径,只有 prompt 与额度是探活值) */
function baseSpec(part) {
  return {
    provider: part.provider,
    kind: kindForProtocol(part.protocol ?? part.kind),
    endpoint: String(part.endpoint || '').trim(),
    apiKey: String(part.apiKey || '').trim(),
    model: String(part.model || '').trim(),
    // 厂商自带的请求参数照旧带上(例如 deepseek 的 reasoning_effort: 'low')——
    // 少了它就不是「和真实调用完全一致」的测试了。注意它不是「推理通道」,
    // 恰恰相反,它是把推理压短,让正文里能挤出那一个字。
    requestExtra: part.requestExtra,
    // 推理档位固定 default:探活**一个思考参数都不发**,理由见 PROBE_REASONING_LEVEL。
    // 别改成 'low' —— 这条链没有参数降级重试,上游一旦不认就是「好配置被报成错」。
    reasoningLevel: PROBE_REASONING_LEVEL,
    scope: part.scope || 'seat',
    placeholderModel: !!part.placeholderModel,
  };
}

/**
 * 座位的测试请求。
 *
 * 入参就是 app.js 的 agentCfg(seat) 的返回值 —— 也就是说,
 * 地址 / Key / 协议 / 模型名四样和真实打牌时的调用**逐字相同**,
 * 区别只有三处:prompt(system/user)、max_tokens(探活用极小值)、
 * 以及推理档位(探活固定 default,一个思考参数都不发 —— 理由见 PROBE_REASONING_LEVEL)。
 * ⚠️ 千万不要在这里自己再解析一遍 seatProviders / seatCustomKeys / defaultProvider,
 *    那等于把「座位该用哪个厂商哪个模型」的规则写第二份,迟早和 app.js 漂移
 *    (这个仓库已经因为「两条路径各写一份」出过两次事故)。
 * @returns {{spec:object}|{error:string}}
 */
export function seatProbeSpec(a) {
  if (!a) return { error: '内部错误:没有拿到这个座位的配置' };
  if (a.providerId === 'local') return { error: '这个座位用的是本地策略,不调用模型' };
  if (a.providerId === 'custom') {
    if (!String(a.endpoint || '').trim()) return { error: '还没有填「接口地址」' };
    if (!String(a.apiKey || '').trim()) return { error: '这个座位选的中转站 Key 还没填密钥' };
  } else if (!a.enabled) {
    return { error: `还没有填 ${a.provider?.name || a.providerId} 的 Key` };
  }
  if (!String(a.model || '').trim()) {
    // 中转站没有 defaultModel,座位又留空时就会走到这里
    return { error: '这个座位没有模型名(也没跟随到默认模型)' };
  }
  return {
    spec: baseSpec({
      provider: a.providerId,
      kind: a.kind,
      endpoint: a.endpoint,
      apiKey: a.apiKey,
      model: a.model,
      requestExtra: a.provider?.requestExtra,
      scope: 'seat',
    }),
  };
}

/**
 * 单个中转站 Key 的测试请求:地址 + 协议 + 密钥 是否被接受(模型名用便宜的占位)。
 * @returns {{spec:object}|{error:string}}
 */
export function keyProbeSpec({ endpoint, apiKey, protocol } = {}) {
  const kind = kindForProtocol(normalizeProtocol(protocol));
  if (!String(endpoint || '').trim()) return { error: '还没有填「接口地址」' };
  if (!String(apiKey || '').trim()) return { error: '这个 Key 还没填密钥' };
  return {
    spec: baseSpec({
      provider: 'custom',
      kind,
      endpoint,
      apiKey,
      model: PROBE_MODEL[kind] || PROBE_MODEL.openai,
      scope: 'key',
      placeholderModel: true,
    }),
  };
}

/* ------------------------------------------------------------ 发起 + 判定 */

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 跑一次探活。
 *
 * 超时是**两层**的,缺一不可:
 *   ① 把 timeoutMs 交给调用层(llmChat → 主进程/Worker 里的 AbortController),
 *      这样请求是真的被中断,不会在后台继续烧钱;
 *   ② 本地再挂一个「硬看门狗」,到点主动 abort 并判失败。为什么要有第 ② 层:
 *      调用层是有可能不返回的(IPC 断了、Worker 挂了、某次改动把 abort 弄丢了),
 *      那样按钮就永远停在「测试中…」,用户只能重开面板 —— 这正是要避免的体感。
 *      第 ② 层比 ① 晚 500ms,正常情况下是 ① 先报,报出来的原因更准。
 *
 * @param {object} built seatProbeSpec/keyProbeSpec 的产物({spec} 或 {error}),也接受裸 spec
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean,reason:string,ms:number,status:number,text?:string,error?:string,scope?:string,placeholderModel?:boolean}>}
 */
export async function runProbe(built, opts = {}) {
  // 两个 spec 构造函数返回的是 {spec} 或 {error} 的信封,这里一并拆掉 ——
  // 调用方(界面)直接把自己拿到的那个对象丢进来就行,不用记住该拆哪一层
  const spec = built?.spec || built || {};
  const t0 = now();
  const ms = () => Math.round(now() - t0);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : PROBE_TIMEOUT_MS;
  const scope = spec?.scope || 'seat';
  const placeholderModel = !!spec?.placeholderModel;

  if (spec?.error) return { ok: false, reason: 'config', ms: 0, status: 0, error: spec.error, scope, placeholderModel };

  // 只认这一个入口:桌面版它是 IPC,网页版它是 Worker 转发
  const api = globalThis.window?.pokerAPI;
  if (!api?.llmChat) {
    return { ok: false, reason: 'config', ms: 0, status: 0, scope, placeholderModel,
      error: '当前环境没有 window.pokerAPI.llmChat,发不出测试请求' };
  }
  if (!spec.endpoint) return { ok: false, reason: 'config', ms: 0, status: 0, scope, placeholderModel, error: '没有接口地址' };

  const requestId = spec.requestId || `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let timedOut = false;
  const localAbort = new AbortController();
  let fireAbort;
  const abortPromise = new Promise((_, reject) => { fireAbort = reject; });
  // 这个 promise 可能在看门狗和正常返回的竞速里「输掉」之后才 reject,
  // 挂一个空 catch 免得变成 unhandled rejection(会在控制台里刷红字)
  abortPromise.catch(() => {});

  const onLocalAbort = () => {
    timedOut = true;
    // 请求 id 交给调用层,让它把真正在飞的请求掐掉
    try { api.llmAbort?.(requestId); } catch { /* 忽略:掐不掉也要让本地判失败 */ }
    fireAbort(new Error('probe-timeout'));
  };
  localAbort.signal.addEventListener('abort', onLocalAbort, { once: true });
  const guard = setTimeout(() => localAbort.abort(), timeoutMs + 500);

  try {
    const res = await Promise.race([
      api.llmChat({
        requestId,
        provider: spec.provider,
        kind: spec.kind,
        endpoint: spec.endpoint,
        apiKey: spec.apiKey || '',
        model: spec.model,
        system: spec.system ?? PROBE_SYSTEM,
        user: spec.user ?? PROBE_USER,
        // 不传 temperature:buildRequest 的缺省就是 1.1,与真实调用一致,
        // 而且按模型名做的修正(modelQuirks)也照旧生效 —— 探活要能暴露「这个模型不认 1.1」
        maxTokens: spec.maxTokens ?? PROBE_MAX_TOKENS,
        timeoutMs,
        requestExtra: spec.requestExtra,
        // 推理档位也要透传:漏了它 buildRequest 会按**默认最低档**发思考参数,
        // 而这条链没有降级重试 —— 等于把上面 PROBE_REASONING_LEVEL 那段说明作废。
        reasoningLevel: spec.reasoningLevel,
      }, {}),
      abortPromise,
    ]);

    if (!res || typeof res !== 'object') {
      return { ok: false, reason: 'network', ms: ms(), status: 0, scope, placeholderModel,
        error: '调用层没有返回任何结果(既没有成功也没有错误)' };
    }
    if (!res.ok) {
      const raw = String(res.error || '调用失败');
      // 「请求超时或被取消」是调用层自己的措辞(见 config.cjs / pokerApi.js),
      // 统一改成以「超时」开头,界面上一眼就能看出是哪一类问题
      const isTimeout = /超时|timeout|abort/i.test(raw);
      return {
        ok: false,
        reason: isTimeout ? 'timeout' : 'http',
        ms: ms(),
        status: Number(res.status) || 0,
        scope, placeholderModel,
        error: isTimeout ? `超时:${raw}` : raw,
      };
    }

    const text = String(res.text || '').trim();
    const chunks = Number(res.chunks) || 0;
    if (!text) {
      /**
       * 收到了响应,但没拿到可读文本 —— 要分成两种情况,不能一律判失败。
       *
       * 关键前提:**HTTP 200 就已经证明配置是对的**。上游是先校验地址、鉴权、
       * 协议、模型名,全都通过了才会开始回 200 —— 所以这时候报「❌ 失败」
       * 会把人往错误的方向引(去改一个本来正确的配置)。
       *
       * ① chunks > 0:流里真的有数据,只是都在推理通道里。
       *    输出额度被推理吃光(探活额度小),或这个模型就是只出推理。
       *    → **算通**:链路、地址、Key、协议、模型名全都没问题。
       * ② chunks === 0:200 但一个字节都没有 —— 上游的锅
       *    (实测 PackyAPI 过载时会这样:先报 503 system_memory_overloaded,
       *     恢复一点之后就回 200 空响应)。不是配置问题,重试即可。
       */
      if (chunks > 0) {
        return { ok: true, reason: 'ok-reasoning-only', ms: ms(), status: Number(res.status) || 200,
          scope, placeholderModel, text: String(res.reasoning || '').trim(),
          note: '只收到推理、没收到正文 —— 探活额度小,不影响实际使用' };
      }
      return { ok: false, reason: 'upstream-empty', ms: ms(), status: Number(res.status) || 200,
        scope, placeholderModel, text: '',
        error: '配置已通过(HTTP 200),但上游返回了空响应' };
    }
    return { ok: true, reason: 'ok', ms: ms(), status: Number(res.status) || 200, text, scope, placeholderModel };
  } catch (err) {
    if (timedOut) {
      return { ok: false, reason: 'timeout', ms: ms(), status: 0, scope, placeholderModel,
        error: `超时:${((timeoutMs + 500) / 1000).toFixed(1)} 秒没有任何响应,已中断` };
    }
    return { ok: false, reason: 'network', ms: ms(), status: 0, scope, placeholderModel,
      error: err?.message || String(err) };
  } finally {
    clearTimeout(guard);
    localAbort.signal.removeEventListener('abort', onLocalAbort);
  }
}

/* ------------------------------------------------------------ 结果文案 */

/** 压掉换行/多余空白并截断。上游错误体经常是一整段 JSON,不压会撑破窄屏布局 */
function snippet(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const HINT = {
  protocol: '上游说这个协议不对。看这个 Key 的「协议」下拉 —— 它要按**令牌分组**选'
    + '(PackyAPI 这类中转站的模型卡片上有 ANTHROPIC / OPENAI-RESPONSE / GOOGLE 标签),不是按中转站选。',
  model: '地址和 Key 都通了,上游只是不认识这个模型名 —— 去中转站控制台确认这个 Key 的分组里有它。',
  whitelist: '网页版走你部署的 Worker 转发,而这个域名不在 Worker 的 EXTRA_ALLOWED_HOSTS 里 ——'
    + '把中转站域名加进去(或改用桌面版,桌面版没有这个限制)。和 Key 没关系,别去重填 Key。',
  auth: '上游拒绝了这个 Key(密钥不对、分组没权限、或者余额/额度问题)。',
};

/**
 * 把结果翻译成界面上那一行字(以及可选的第二行解释)。
 *
 * 返回 {tone, main, detail}:
 *   tone='ok'  → ✅ 通
 *   tone='err' → ❌ 失败(原文照登)
 *   tone='run' → 测试中…(由界面自己给,不走这里)
 * 三种状态就是这三种,不额外造第四种:即使「模型名不在该分组」这种
 * 「Key 其实是好的」的情况,也照样是 ❌(它确实没调通),
 * 但主行会直接写明「地址/Key/协议已通」,并且给出对应的 hint。
 */
export function describeProbe(r) {
  const secs = `${(Math.max(Number(r?.ms) || 0, 0) / 1000).toFixed(1)}s`;
  if (!r) return { tone: 'err', main: '❌ 测试没有返回结果' };

  if (r.ok) {
    // 「只收到推理」也要说清楚,否则用户看到空白会以为没测到东西
    const extra = r.note ? `(${r.note})` : snippet(r.text, 80);
    return { tone: 'ok', main: `✅ 通 · ${secs} · ${extra}` };
  }

  if (r.reason === 'upstream-empty') {
    return {
      tone: 'err',
      main: `❌ 上游空响应 · ${secs} · 配置已通过(HTTP 200),但它没回任何内容`,
      detail: '地址 / Key / 协议 / 模型名都已经通过了 —— 上游是先校验完这些才会回 200。'
        + '所以**不要去改配置**,这是中转站侧的问题(过载、渠道异常)。'
        + '实测 PackyAPI 过载时就是这样:先报 503 system_memory_overloaded,恢复一点后回 200 空响应。等一会儿重试即可。',
    };
  }

  if (r.reason === 'config') {
    return { tone: 'err', main: `❌ 没测成 · ${snippet(r.error, 160)}`, detail: '这是配置缺项,请求还没发出去。' };
  }
  if (r.reason === 'timeout') {
    return {
      tone: 'err',
      main: `❌ 失败 · ${secs} · ${snippet(r.error, 160)}`,
      detail: '地址不可达、网络不通,或中转站/模型本身没响应。探活请求只有 16 token,不该等这么久。',
    };
  }
  if (r.reason === 'network') {
    return {
      tone: 'err',
      main: `❌ 失败 · ${secs} · ${snippet(r.error, 200)}`,
      detail: '请求根本没发出去或连接中途断了:先确认接口地址能打开,再看网页版有没有把该域名'
        + '加进 Worker 的 EXTRA_ALLOWED_HOSTS(桌面版没有这个限制)。',
    };
  }

  const cause = probeCause(r.error);
  const head = cause === 'model' && r.placeholderModel
    ? '❌ 模型名不在该分组 · 地址/Key/协议已通'
    : '❌ 失败';
  return { tone: 'err', main: `${head} · ${secs} · ${snippet(r.error, 240)}`, detail: HINT[cause] };
}
