/**
 * LLM 调用基座:重试外壳 + 两条传输路径 + 失败分类。**与具体游戏无关**。
 *
 * 为什么单独一份(2b 从 games/poker/agent.js 里抽出来的):
 *   这套东西 —— 网络重试、参数降级、截断检测、超时/取消、错误分类 —— 是
 *   「怎么可靠地问一个大模型一句话」,跟桌上玩的是扑克还是狼人杀没有关系。
 *   以前它们长在 PokerAgent 里,于是「再写一个游戏的 AI」要么复制 600 行,
 *   要么继承一个叫 PokerAgent 的类(而它另一半代码在拼扑克提示词)。
 *   抽出来之后:游戏只需要写「系统提示词 + 用户提示词 + 怎么解析回答」。
 *
 * ⚠️ 这份文件里有**两层**东西,别混:
 *    · LlmCaller —— 调用 / 重试 / 降级 / 超时。游戏继承它,只覆写提示词与解析;
 *    · 一堆纯函数(失败分类、重试策略、JSON 抽取) —— 无状态,测试可直接调。
 *
 * ⚠️ 两条传输路径必须**共用同一个重试外壳**(见 callLLM 的注释):
 *    api.llmChat(桌面/网页,主进程代理)与 callLLMDirect(纯 Node 直连)。
 *    这个仓库出过两次「只给其中一条加逻辑」的事故(参数降级、截断检测),
 *    表现都是「测试全绿、游戏里没生效」—— 别在这里再分叉。
 */

import { buildRequest, consumeSseBuffer } from './llmStream.mjs';
import { getProvider } from './providers.mjs';

/**
 * 共享模块的**懒加载句柄**。
 * 为什么懒加载:直连那条路只在纯 Node(测试 / 脚本 / 离线兜底)才走到,
 * 浏览器/桌面版走 api.llmChat —— 没必要为一次可能的调用先把协议表拉起来。
 */
let sharedProvidersMod = null;
let sharedStreamMod = null;


/**
 * 默认重试策略(**要调就调这里**,或写进配置的 llmRetry 覆盖)。
 *
 * 为什么要重试:上游的抖动是**一过性**的 —— 中转站报「无可用渠道」「overloaded」
 * 之后隔几秒同一条请求就能成。以前一失败就立刻 `return fallback()`,
 * 用户看到的就是「某个模型偶发超时 → 那一手突然变成本地策略在打」,
 * 而它下一手又好了。用户的诉求很明确:超时/失败重试 3 次,3 次都不行才用本地策略。
 *
 * ⚠️ 「失败」不止是 HTTP 失败。**HTTP 200 但内容用不了**(模型返回了一段没有
 *    可识别动作的文本、或者干脆一个字都没有)也算 —— 用户实测撞到的那条
 *    「模型没有给出可识别的动作,已改用本地策略」就是这一类,它以前在重试外壳
 *    **外面**,一次就兜底。现在它和网络失败共用同一个 times / 同一条死线:
 *    一次决策总共最多 1 + times 次尝试,不管失败是哪种、怎么混合都不变。
 *
 * ⚠️ `budgetMs` 是这套东西唯一的风险点,必须有:
 *    单次调用超时是 45s(用户定的),3 次重试机械地乘起来就是 135s。
 *    一张桌子是**轮流**调用模型的,一个人卡 135 秒全桌一起等 ——
 *    而用户此前已经因为「等了 78 秒」抱怨过一次(见 config.cjs 里 timeoutMs 的注释)。
 *    所以这里给「一次决策的累计耗时」硬上限:到点立刻兜底,绝不再发新请求。
 *    注意是**累计**:截断重试、网络重试、解析重试三者共用同一条死线
 *    (见 decide 里 retryCtx 的构造),所以它们不会各自计时、叠成两分钟。
 */
const LLM_RETRY = {
  /**
   * 失败后**额外**再试几次 → 一共最多 1 + times 次「逻辑尝试」。
   * 3 次:用户要的。再多就只是在同一个病上反复撞墙。
   *
   * ⚠️ 这一个数字同时管住**所有**失败:网络/超时、截断、空回答、
   *    「没有可识别的动作」。`times: 0` 就是「一次都不重试」——
   *    行为与加这套机制之前完全一致(失败/解析不出 → 直接本地策略),
   *    想临时关掉重试就填 0,不必改代码。
   */
  times: 3,
  /**
   * 每次重试前等多久(毫秒),用完之后沿用最后一个值。
   *
   * 为什么是这个量级:上游恢复通常就是几秒内的事,所以**短退避**即可 ——
   * 600ms 足够躲过一次连接抖动,1.5s / 3s 覆盖「过载 / 无可用渠道」的恢复窗口。
   * 刻意**不是**「先把一个完整超时等满再重试」:那等于把一次 45s 变成两次 45s,
   * 用户抱怨的就是这个。三次退避合计 5.1s,相对 90s 的预算只是零头。
   */
  backoffMs: [600, 1500, 3000],
  /**
   * 一次决策的累计耗时上限(毫秒):到点立刻回落本地策略。
   *
   * 90s 的来历:首次尝试最多跑满 45s(timeoutMs),加一次重试就是 90s ——
   * 也就是说「连续两次真的超时」就已经吃光预算,不会再出现第三次、第四次,
   * 更不会出现 3×45=135s。反过来,快速失败(503 / 无可用渠道,通常 1s 内返回)
   * 时四次尝试都能试上,这正是重试真正要救的场景。
   */
  budgetMs: 90000,
  /**
   * 是否**按错误类型**区分值不值得重试(见 classifyLlmFailure)。
   *
   * ⚠️ 这是本轮唯一一处「我替你做了选择」的地方,取舍写在这里:
   *    用户原话是「调用超时或失败重试 3 次」,并没有区分类型;
   *    但 401/403(Key 错)、协议不对、模型名错、余额不足这几种,
   *    **重试必然同样失败** —— 白等 5 秒退避、白发 3 个请求,最后照样兜底。
   *    所以默认 true(按类型分,配置性错误直接兜底),
   *    想完全照原话办(任何失败都重试 3 次)就把这里改成 false,
   *    或在配置里写 `"llmRetry": { "classifyErrors": false }`。
   *
   * ⚠️ 这个开关**管不到**「解析不出动作 / 空回答」那一类:它们没有
   *    「配置性」可言(HTTP 是成功的、配置没错),而且重发一次经常就好,
   *    所以它们无条件可重试(见 classifyLlmFailure 的 ⓪)。
   *    也就是说关掉分类不会让解析失败变成不重试;要完全不重试就用 times: 0。
   */
  classifyErrors: true,
};
/**
 * 预算只剩这么点时间就不要再发下一次了 —— 发出去也几乎必然再超时,
 * 只会让全桌多等一次超时的时间。
 */
const RETRY_MIN_HEADROOM_MS = 1500;
/** 取消(牌局重开 / 退出 / 改规则)不是「模型失败」,用这个固定说法 */
const CANCEL_MESSAGE = '调用已取消(牌局已重开或退出)';

/**
 * 厂商 id。
 * ⚠️ app.js 传进来的 cfg.provider 是**整个厂商对象**(界面要用它的 name),
 *    而 getProvider() 只认字符串 id —— 把对象直接传下去会查不到、静默退回 deepseek:
 *    结果 OpenAI / Claude / Gemini 的请求体里都被塞进 deepseek 的 reasoning_effort,
 *    本地模型(不需要 Key)也会被当成「缺 Key」拒掉。所以统一从这里取 id。
 */
function providerIdOf(cfg) {
  if (cfg?.providerId) return cfg.providerId;
  if (typeof cfg?.provider === 'string') return cfg.provider;
  return cfg?.provider?.id || 'deepseek';
}
/**
 * 从厂商/中转站的报错里认出「哪个参数它不认」。
 *
 * 为什么需要:不同模型对**可选参数**的容忍度差别极大。
 * 最典型的是 OpenAI 的 o 系列 / gpt-5 系列,它们会直接拒绝:
 *   "Unsupported value: 'temperature' does not support 1.1 with this model.
 *    Only the default (1) is supported."
 * 还有些模型只认 max_completion_tokens、不认 max_tokens。
 *
 * 中转站把几十家模型挂在**同一个地址**后面,所以我们发的那套统一参数
 * 必然有一部分模型不认 —— 用户看到的就是「大部分模型都调用失败」。
 *
 * 与其维护一张「哪些模型支持 temperature」的白名单(永远追不上新模型),
 * 不如**按报错自适应降级**:它说哪个字段不认,就摘掉哪个再发一次。
 * 只摘可选参数,模型名/消息体这些必需的绝不摘 —— 摘了就变成另一种错。
 */
function unsupportedParamIn(text) {
  const t = String(text || '');
  // 先确认这确实是「参数不支持 / 参数超出范围」类报错,而不是「模型不存在」「余额不足」。
  // 范围类的措辞也要认:Claude 走 OpenAI 兼容口时报的是
  // "temperature: Input should be less than or equal to 1",GLM 报「取值范围是 (0, 1]」——
  // 只认 unsupported/invalid 的话这两种都漏掉。
  if (!/unsupported|not supported|does not support|invalid|unrecognized|unknown|不支持|额外|extra|range|less than|greater than|must be|should be|between|exceed|out of|only .*allowed|取值|范围|超出/i.test(t)) return null;

  /**
   * 我们可能会发出去的可选参数。报错里提到哪个就摘哪个。
   *
   * ⚠️ thinking / reasoning_effort 必须在这里。它们原本是给 DeepSeek 用的,
   *    但**截断重试**会把 `thinking: {type:'disabled'}` 塞进请求体
   *    (见 decide 里的重试分支),而中转站后面绝大多数模型不认这个字段。
   *    于是现象就是「第一次调用成功(但被截断)→ 重试带着 thinking → 400 失败」。
   *    只覆盖 temperature/max_tokens 的时候,这一条会被漏掉。
   *
   * ⚠️ **嵌套字段**也必须能认出来(canonical 名统一成 'thinking' / 'reasoning'):
   *    推理档位这套参数不止顶层有 —— Gemini 的 thinkingConfig 嵌在
   *    generationConfig 里,字段名在报错文本里长这样:
   *      "thinking_budget is out of range"、"thinkingConfig.thinkingBudget: invalid"
   *      "thinking.budget_tokens must be less than max_tokens"
   *      "Unsupported parameter: 'reasoning.effort'"
   *    只按 'thinking' 一个字去匹配虽然能碰对大半,但漏掉
   *    thinkingBudget / thinking_budget / budget_tokens 这几个写法就会「降级不了、
   *    直接失败」—— 而这一版刚把 Gemini 的预算从 0 改成 512、给 Anthropic 加了
   *    1024,正是新参数最可能被某个型号拒掉的时候,兜底必须真的兜得住。
   *    摘掉整块的实现见 shared/llmStream.mjs 的 omit 处理(顶层 delete 摘不到嵌套)。
   *
   *    顺序要紧,分两轮扫,而且**思考类必须排在额度类前面**:
   *      · 'reasoning_effort' 要排在 'reasoning' 前面 —— 后者是前者的子串,
   *        反了的话一个本该按顶层字段摘的报错会被当成 responses 的 reasoning 对象,
   *        openai 协议上就摘了个不存在的东西(降级了但报错照旧)。
   *      · 思考类排在 max_tokens 前面,因为这类报错**经常同时提到额度**:
   *        Anthropic 的 "thinking.budget_tokens: Input should be less than max_tokens"
   *        里两个词都有。先命中 max_tokens 就会去摘额度 ——
   *        而 max_tokens 对 Anthropic 是**必需字段**,摘掉直接变成另一种 400,
   *        降级反而把请求弄坏了。真正的病因是思考预算,摘它才对。
   */
  const OPTIONAL = [
    // —— 第一轮:思考 / 推理块(含各自的嵌套写法)——
    ['reasoning_effort', 'reasoning_effort'],
    ['thinkingconfig', 'thinking'],           // Gemini:generationConfig.thinkingConfig
    ['thinkingbudget', 'thinking'],
    ['thinking_budget', 'thinking'],
    ['thinking budget', 'thinking'],
    ['budget_tokens', 'thinking'],            // Anthropic:thinking.budget_tokens
    ['thinking', 'thinking'],
    ['reasoning.effort', 'reasoning'],        // Responses:reasoning.effort
    ['reasoning', 'reasoning'],
    // —— 第二轮:其余可选参数 ——
    ['temperature', 'temperature'],
    // 同义字段:不同协议/世代叫法不同,但都是「输出额度」这一个东西。
    // 报错里出现哪个都归到 canonical 名 'max_tokens',
    // 由 buildRequest 的 omit 把这几个同义字段一起删掉。
    ['max_completion_tokens', 'max_tokens'],
    ['max_output_tokens', 'max_tokens'],      // Responses 协议的叫法
    ['max_tokens', 'max_tokens'],
    ['top_p', 'top_p'],
  ];
  for (const [needle, field] of OPTIONAL) {
    if (t.toLowerCase().includes(needle)) return field;
  }
  return null;
}
/** 从模型输出里抠出 JSON(容错:代码块、前后废话、单引号) */
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = t.slice(start, end + 1);
  const tries = [slice, slice.replace(/'/g, '"').replace(/,\s*}/g, '}')];
  for (const s of tries) {
    try { return JSON.parse(s); } catch { /* 继续尝试 */ }
  }
  return null;
}
/**
 * 这次失败值不值得重试:返回 'retryable'(临时性)或 'fatal'(配置性)。
 *
 * 判定顺序是**刻意**的,每一条都有踩过的坑:
 *   ① 余额/欠费排在 429 前面 —— OpenAI 的 insufficient_quota 回的就是 429,
 *      先按 429 归到「限流」会白白重试三次,而它重试一万次也不会变有钱。
 *   ② 协议不对排在模型名不对前面 —— 上游那句「模型 X 不支持 chat completions 协议」
 *      里两个词都有,先按模型名判会把用户引到错误方向(与 llmProbe 的 probeCause 同序)。
 *   ③ 「无可用渠道」**刻意不归到模型名不对**:探活(llmProbe)把它当「令牌分组不对」,
 *      因为那时要告诉用户去改哪个开关;但打牌时它是上游渠道的一过性状态
 *      (用户实测隔几秒就好),所以这里归可重试。
 *   ④ 参数不认(400 Unsupported parameter)不重试 —— 参数降级重试已经试过摘字段了,
 *      再发一次还是同样的 400,只会白花一次调用。
 *   ⑤ 兜底看状态码:其它 4xx 当配置性(不重试),没有线索的当临时性(重试)。
 */
function classifyLlmFailure(err) {
  const t = String(err?.message ?? err ?? '');
  if (err?.llmFatal) return 'fatal';
  // ⓪ 解析失败(见 parseFailureError):这一条**必须排在最前面**。
  //    HTTP 其实是成功的 —— 拿状态码/措辞去分类只会把它误判成「配置性错误/
  //    什么线索都没有」那一类,而它恰恰是最该重试的一类(模型是随机的,
  //    同一条 prompt 重发一次经常就正常了)。所以不给后面的规则任何机会。
  if (err?.llmParseFail) return 'retryable';
  const code = Number(err?.llmStatus) || statusFromText(t);

  // ① 余额 / 欠费:重试再多次也没用(且它经常和 429 一起出现)
  if (/insufficient[_ -]?(quota|balance|funds)|exceeded your current quota|余额|欠费|欠款|no credit|credit balance|充值/.test(t)) return 'fatal';
  // ② 鉴权 / 权限:Key 错、被禁、Worker 白名单不含目标域名 —— 都改配置才有用
  if (code === 401 || code === 403
    || /unauthorized|forbidden|invalid[_ -]?api[_ -]?key|incorrect api key|authentication|invalid token|令牌.{0,8}(无效|错误|过期)|密钥.{0,8}(无效|错误|过期)|不在白名单|白名单/.test(t)) return 'fatal';
  // ③ 协议不对 / 模型名不对 —— 配置性的
  if (/protocol[_ -]?not[_ -]?supported|unsupported[_ -]?protocol|不支持.{0,16}(协议|chat completions|messages api)/.test(t)) return 'fatal';
  if (/model[_ -]?not[_ -]?found|no such model|unknown model|invalid[_ -]?model|模型.{0,12}(不存在|未找到|无效|没有权限)|does not exist|没有配置接口地址|缺少.{0,12}(API Key|密钥)/.test(t)) return 'fatal';
  // ④ 参数不认(降级重试已经摘到不能再摘了)
  if (/unsupported (value|parameter)|does not support|不支持.{0,12}(参数|temperature|max_tokens)/.test(t)) return 'fatal';
  // ⑤ 临时性:5xx / 408 / 429 / 超时 / 网络 / 过载 / 限流 / 渠道暂时不可用
  if (code >= 500 || code === 408 || code === 425 || code === 429) return 'retryable';
  if (/timeout|timed out|超时|abort|socket hang up|econnreset|econnrefused|enotfound|etimedout|eai_again|fetch failed|network|networkerror|connection (reset|closed|error|refused)|bad gateway|service unavailable|gateway time|temporarily|过载|overload|system_memory_overloaded|rate[_ -]?limit|too many requests|限流|请求过于频繁|请求过快|无可用渠道|no available channel|渠道|try again|稍后|一会儿/.test(t)) return 'retryable';
  // ⑥ 其它明确的 4xx:多半是请求本身错了,别浪费三次重试
  if (code >= 400 && code < 500) return 'fatal';
  // ⑦ 什么线索都没有 → 当临时性。用户的诉求就是「失败就重试 3 次」,
  //    而明确的配置错在前面几条已经拦住了。
  return 'retryable';
}
/**
 * 把配置里的 llmRetry 与默认值合并。
 * 单个字段缺省 / 非法都退回 LLM_RETRY 里的值,别让一个手误把重试整个关掉或开成无限。
 */
function resolveRetryPolicy(cfg) {
  const raw = cfg?.llmRetry || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const arr = Array.isArray(raw.backoffMs)
    ? raw.backoffMs.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    : null;
  return {
    times: Math.min(num(raw.times, LLM_RETRY.times), 8),
    backoffMs: arr && arr.length ? arr : LLM_RETRY.backoffMs,
    budgetMs: num(raw.budgetMs, LLM_RETRY.budgetMs),
    classifyErrors: raw.classifyErrors === undefined ? LLM_RETRY.classifyErrors : !!raw.classifyErrors,
  };
}
/** 带「已取消」标记的错误:上层据此**不再重试、也不弹失败提示** */
function canceledError() {
  const e = new Error(CANCEL_MESSAGE);
  e.canceled = true;
  return e;
}
/**
 * 带 HTTP 状态码的错误。
 * 状态码是判断「值不值得重试」最硬的信号(5xx/429 重试,401/403 不重试),
 * 而两条调用路径把状态码写在各自的错误文本里,统一在这里挂到 error 上。
 */
function llmFail(message, status) {
  const e = new Error(message);
  const n = Number(status);
  if (Number.isFinite(n) && n > 0) e.llmStatus = n;
  return e;
}
/** 从错误原文里捞状态码(两条路径的措辞:接口返回 / 厂商返回 / 转发失败 / "code":503) */
function statusFromText(text) {
  const m = /(?:接口返回|厂商返回|转发失败|status|HTTP|code)\D{0,8}(\d{3})/i.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}
/**
 * 「HTTP 成功、但内容用不了」—— 打上专用标记,交给重试外壳。
 *
 * 为什么要专门一个错误类型,而不是让 decide() 自己 return fallback():
 *   那样就发生在**重试外壳外面**了,一次就兜底 —— 用户实测撞到的
 *   「Grok(grok-4.7) 调用失败:模型没有给出可识别的动作」就是这么来的。
 *   打上 llmParseFail 之后:
 *     · classifyLlmFailure 无条件判它可重试(见那里的 ⓪);
 *     · retryReason 能把它压成用户看得懂的一句话;
 *     · 尝试次数仍由外层**唯一**那条计数管着,不另起循环、不与网络重试相乘。
 */
function parseFailureError(reason, raw) {
  const e = new Error(parseFailureMessage(reason));
  e.llmParseFail = true;
  e.parseReason = reason;
  e.raw = String(raw || '').slice(0, 400);
  return e;
}
/** reason: 'truncated'(截断)/ 'empty'(空回答)/ 'action'(有内容但没有可识别的动作) */
function parseFailureMessage(reason) {
  if (reason === 'empty') return '模型返回了空内容(HTTP 200 但一个字都没有)';
  if (reason === 'truncated') return '模型只给了推理过程,没有给出正式回答(截断)';
  return '模型没有给出可识别的动作';
}
/** 把失败原因压成几个字,写进「第 N 次重试」的提示里(用户要看懂在等什么) */
function retryReason(err) {
  const t = String(err?.message || err || '');
  // 解析失败没有状态码、也没有网络措辞,直接按标记给准确的说法
  if (err?.llmParseFail) return parseFailureMessage(err.parseReason);
  const code = Number(err?.llmStatus) || statusFromText(t);
  if (/超时|timeout|timed out/.test(t)) return '超时';
  if (/无可用渠道|no available channel/.test(t)) return '上游无可用渠道';
  if (/overload|过载|system_memory_overloaded/.test(t)) return '上游过载';
  if (code === 429 || /rate[_ -]?limit|too many requests|限流|请求过于频繁/.test(t)) return '限流';
  if (code >= 500) return `上游 ${code}`;
  if (/fetch failed|network|econnreset|econnrefused|enotfound|etimedout|socket/.test(t)) return '网络错误';
  return `错误 ${t.replace(/\s+/g, ' ').slice(0, 40)}`;
}
/** 第 attempt 次重试(从 0 数)前等多久 */
function backoffFor(policy, attempt) {
  const list = policy.backoffMs;
  return list[Math.min(attempt, list.length - 1)] ?? 0;
}
/**
 * 可取消的等待。
 * 退避的这几秒里牌局完全可能被重开 / 退出 —— 那样必须**立刻**停,
 * 不能"睡完再发现已经取消了",那会多发一次请求(旧决策被 act 到新引擎上就是这个链条)。
 */
function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(canceledError()); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(canceledError()); };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 一次「调用模型」的基类。
 *
 * 子类只需要提供:cfg(厂商/模型/Key/超时/重试策略)、hooks(流式与错误回调),
 * 以及 decide() 那种「我该怎么问、怎么解析」的业务逻辑。
 * 重试、降级、超时、截断检测全在这里 —— 它们与业务无关,写一次就够了。
 */
export class LlmCaller {
  /**
   * @param {object} opts
   *   seat   座位号(只用于日志/调试前缀,别的游戏可以不用)
   *   cfg    调用配置 { providerId, endpoint, apiKey, model, kind, timeoutMs,
   *                    maxTokens, temperature, reasoningLevel, requestExtra, llmRetry }
   *   hooks  { onThink(delta, full, thinking), onError(err), onDebug(msg),
   *            onTruncated(info) }
   */
  constructor({ seat = 0, cfg = {}, hooks = {} } = {}) {
    this.seat = seat;
    this.cfg = cfg;
    this.hooks = hooks;
    /** 上一次调用「只来了推理、没来正式回答」的详情(截断重试用) */
    this.lastTruncated = null;
    /** 上一次拿到的原始文本(解析失败时给重试外壳看) */
    this._lastRaw = '';
  }

  setConfig(cfg) { this.cfg = { ...this.cfg, ...cfg }; }

  /**
   * 发起请求。
   * 优先走 Electron 主进程代理(绕开 CORS、Key 不进页面、天然支持各家流式格式);
   * 在没有 window(纯 Node 测试/脚本)时退回直连 fetch。
   *
   * ⚠️ **重试外壳套在两条路径之外**(见下面的 sendOnce 与 _callWithRetry)。
   *    这个仓库出过两次「只在 callLLMDirect(纯 Node 测试走的那条路)里加逻辑,
   *    真实游戏走的 api.llmChat 那条没有」的事故(参数降级、截断检测),
   *    表现都是「测试全绿、游戏里没生效」。所以重试只写一份,两条路径都必须经过它。
   *
   * @param {object} [overrides] 覆盖 cfg 的字段(maxTokens / requestExtra / timeoutMs …)。
   *   这里还接受两个**不会传给调用层**的东西(拆出来是为了别把它们混进 cfg):
   *     · retryCtx  —— decide() 建好的「一次决策的重试上下文」(死线 + 次数 + 已摘参数);
   *     · validator —— 每次拿到文本后问一句「这次能用吗」(见 _validateDecision)。
   *       它让「解析不出动作 / 空回答」也走这同一条重试,而不是另起一个循环。
   */
  async callLLM(system, user, externalSignal, hookCtx, overrides) {
    const { retryCtx, validator, ...over } = overrides || {};
    const cfg = { ...this.cfg, ...over };
    const providerId = providerIdOf(cfg);
    // hookCtx 用来把「写笔记」这类**非决策**调用的流式回调引开 ——
    // 否则笔记的流式片段会被当成思考喂进牌桌上的气泡(串台)。
    const hooks = hookCtx || this.hooks;
    const api = globalThis.window?.pokerAPI;

    /**
     * 「一次逻辑尝试」。
     *
     * 它内部还可能因为**参数降级**多发 1~3 个 HTTP 请求 —— 那是另一套机制
     * (unsupportedParamIn + omit),与网络重试**正交**:
     *   · 参数降级解决的是「这次请求的报文不对,摘掉那个字段就能成」;
     *   · 网络重试解决的是「这次尝试整体失败了(超时/5xx/过载),值不值得再来一次」。
     * 所以这里只做一次尝试,重试在外层。**不要**在这里面再套一层重试,
     * 否则「参数降级 × 网络重试」会相乘成十几次调用。
     */
    const sendOnce = async (attemptTimeoutMs, attemptNo, session, attemptCfg) => {
      // `attemptCfg` 是外壳按这一趟的语义算好的请求参数(见 _callWithRetry):
      // 平时就是 cfg;截断重试那一趟会带**翻倍后的 maxTokens**(以及 deepseek 的
      // thinking=disabled)。用 cfg 会让翻倍在真实路径上悄悄失效 ——
      // 「截断重试没治住病因」正是这么来的。
      const cfg2 = attemptCfg || cfg;
      if (api?.llmChat) {
        // requestId 每次都不同(t{尝试序号}):上一次尝试超时/被中断后,
        // 主进程那边的 abort 记录已经删掉了,复用同一个 id 万一撞上新的请求,
        // llmAbort 会误杀一个新请求。
        const requestId = `${this.seat}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          + (attemptNo ? `-t${attemptNo}` : '');
        const onAbort = () => { try { api.llmAbort(requestId); } catch { /* ignore */ } };
        if (externalSignal) {
          if (externalSignal.aborted) throw canceledError();
          externalSignal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          /**
           * 参数降级重试 —— **真实游戏走的就是这条路**。
           *
           * ⚠️ 以前降级只写在下面的 callLLMDirect(纯 Node 测试用)里,
           *    这条网页版 / 桌面版真正走的路径没有:测试里模型不认 temperature 会自动摘掉重试、
           *    测试全绿;游戏里同样的报错直接 400、退回本地策略。
           *    这就是「中转站大部分模型调用失败」一直查不出来的原因。
           */
          // 已摘掉的字段从 session 里带过来(不是空数组):模型不认某个参数是
          // **这个模型的属性**,不是这一次请求的属性 —— 每次重试都从零再踩一遍
          // 那个 400,「参数降级 × 网络重试」就叠成两倍的请求了(见 session.omit 的说明)。
          const seeded = (session?.omit || []).length;
          const omit = [...(session?.omit || [])];
          /**
           * 本次尝试的额度。外壳决定「截断后翻倍重发」时会把 session.doubled
           * 置上,所以这里要取**外壳算好的值**,不能写死 cfg.maxTokens ——
           * 写死的话翻倍在真实路径上根本不生效(截断重试又变成没治住病因)。
           */
          const maxTokens = Math.max(Number(cfg2.maxTokens) || 300, 1);
          let res;
          /**
           * 截断检测所需的两个计数。
           *
           * ⚠️ this.lastTruncated 以前**只有** callLLMDirect(Node 测试路径)会写,
           *    这条真实路径从来不写 —— 于是 decide() 里的「截断就重试一次」
           *    在游戏里永远不会触发(只有测试能触发),又是一处
           *    「测试全绿、游戏里没生效」。所以这里也把它算出来。
           *    判据与直连路径一致:只来了推理、正式回答一个字都没有。
           */
          let sawReasoning = false;
          let sawAnswer = false;
          for (let attempt = 0; ; attempt++) {
            res = await api.llmChat({
              requestId: attempt ? `${requestId}-r${attempt}` : requestId,
              provider: providerId,
              kind: cfg.kind,
              endpoint: cfg.endpoint,
              apiKey: cfg.apiKey || '',
              model: cfg.model,
              system,
              user,
              temperature: cfg.temperature ?? 1.1,
              maxTokens,
              // 本次尝试的超时由重试外壳算(不会超过剩余预算,见 _callWithRetry)——
              // 写死 cfg.timeoutMs 的话,第一次超时 45s 之后第二次还能再等 45s,
              // 总时长就冲破上限了。
              timeoutMs: attemptTimeoutMs,
              // 推理档位(off/low/default)。必须透传:这个值决定四条协议各自发什么
              // 思考参数(见 shared/llmStream.mjs 的 REASONING_LEVELS)。
              // ⚠️ timeoutMs / maxTokens 当年就是因为 agentCfg 没传而变成死字段 ——
              //    新加配置项时一定要顺着「界面 → 配置 → agentCfg → 这里」走一遍。
              reasoningLevel: cfg.reasoningLevel,
              // 厂商特有的请求参数(例如 reasoning_effort)。
              // 透传下去之后由 buildRequest 合并进请求体 —— 它放在最后合并,
              // 所以既覆盖厂商默认,又不用为每个厂商写分支。
              requestExtra: cfg2.requestExtra,
              omit: omit.length ? [...omit] : undefined,
            }, {
              // 第三个参数 thinking:true 表示这是「推理阶段」的增量(界面可弱化显示)
              onDelta: (delta, full, thinking) => {
                if (thinking) sawReasoning = true; else sawAnswer = true;
                hooks.onThink?.(delta, full, thinking);
              },
            });
            if (res?.ok) break;
            const bad = unsupportedParamIn(res?.error);
            if (bad && !omit.includes(bad) && omit.length < 3 && !externalSignal?.aborted) {
              omit.push(bad);
              if (session) session.omit = [...omit];   // 记给本次决策的后续尝试
              continue;
            }
            // 带上状态码:重试外壳靠它判断值不值得再试(401/403 直接兜底,5xx/429 重试)
            throw llmFail(res?.error || '请求失败', res?.status);
          }
          // 只有**这一次尝试新摘掉**了字段才提示:同一句提示在每次重试后重复刷
          // 只会让人以为出了新问题。
          if (omit.length > seeded) {
            this.hooks.onError?.({
              seat: this.seat,
              message: `这个模型不认 ${omit.join(' / ')},已自动去掉后重试成功`,
              level: 'info',
            });
          }
          // 与 callLLMDirect 的判据保持一致(见那边的注释)
          this.lastTruncated = (!sawAnswer && sawReasoning)
            ? {
              seat: this.seat, reason: 'length',
              note: `模型把 ${maxTokens} 个 token 全用在推理上了,正式回答被截断`,
              reasoningChars: (res.reasoning || '').length,
              suggestedMaxTokens: Math.max(1200, maxTokens * 3),
            }
            : null;
          if (this.lastTruncated) this.hooks.onDebug?.(`[座位${this.seat + 1}] ${this.lastTruncated.note}`);
          return res.text || '';
        } finally {
          if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
        }
      }
      // 纯 Node(测试 / 脚本):直连 fetch。超时按**本次尝试**的预算传下去 ——
      // 与上面那条路同一个来源,否则两条路的重试时长会不一样。
      // session 也传下去(dropped 的续用规则必须两条路一致,见 callLLMDirect)。
      // ⚠️ 这里必须用 attemptCfg(而不是 cfg):截断重试那一趟的翻倍额度与
      //    thinking=disabled 全靠它带下去 —— 漏掉就又变成「测试全绿、游戏里没生效」。
      return this.callLLMDirect(system, user, externalSignal, { ...cfg2, timeoutMs: attemptTimeoutMs }, session);
    };

    return this._callWithRetry(sendOnce, { cfg, externalSignal, hooks, retryCtx, validator });
  }
  /**
   * 重试外壳 —— **两条调用路径共用同一份**。
   *
   * 为什么单独抽出来:参数降级和截断检测都曾经只加在一条路上(测试走的那条),
   * 于是「测试全绿、游戏里照样失败」。重试是新加的一层,绝不能再犯第三次,
   * 所以它只有这一个实现,api.llmChat 与 callLLMDirect 都必须从它下面过。
   *
   * 三条约束按优先级:
   *   ① 取消 > 一切:牌局重开 / 退出 / 改规则后**立刻**停,不再发新请求,
   *      也绝不把结果交给调用方去 act(那正是「旧决策被 act 到新引擎上」的链条)。
   *   ② 总时长上限(deadline):一次决策累计到点就兜底,不允许全桌停等两分钟。
   *   ③ 次数上限(attempts):**一次决策**一共最多 1 + policy.times 次尝试。
   *
   * ⚠️ ③ 是按**决策**算的,不是按每次 callLLM 算的 —— 这是刻意的:
   *    一次决策里现在有三种「失败」都要重试(网络失败 / 截断 / 解析不出动作),
   *    如果各写一条循环、各自计数,就是 4 × 4 = 16 个请求。所以它们全部从
   *    同一个 session.attempts 里扣次数、共用同一条死线。
   *    「一次决策最多 1 + times 次尝试(默认 4)」这句话就是靠这里成立的。
   *
   * @param {(timeoutMs:number, attemptNo:number, session:object)=>Promise<string>} sendOnce
   * @param {{cfg:object, externalSignal?:AbortSignal, hooks:object, retryCtx?:object,
   *          validator?:()=>({verdict:string}|null)}} ctx
   *   retryCtx 由 decide() 建好并透传:{ startedAt, deadline }。
   *   validator 每次**成功**拿到文本后调用(见 decide 里给的那个):
   *     返回 null 表示这次回答能用,直接交给调用方;
   *     返回 { verdict } 表示 HTTP 成功但内容不可用 —— 也当成一次失败来重试。
   */
  async _callWithRetry(sendOnce, { cfg, externalSignal, hooks, retryCtx, validator }) {
    const policy = resolveRetryPolicy(cfg);
    const session = retryCtx || { startedAt: Date.now(), deadline: 0, attempts: 0, omit: [] };
    if (!session.startedAt) session.startedAt = Date.now();
    if (!session.deadline) session.deadline = session.startedAt + policy.budgetMs;
    if (!session.omit) session.omit = [];
    if (!Number.isFinite(session.attempts)) session.attempts = 0;
    /**
     * 「额度翻倍 + 关掉推理通道」这一趟最多只发一次(见下面截断那条分支)。
     * 记在 session 上而不是本函数的局部变量:session 是本次决策的共享状态,
     * 万一将来有别的入口带着同一个 session 再进来一次,也不会翻倍两次。
     */
    if (session.doubled === undefined) session.doubled = false;
    const startedAt = session.startedAt;
    const deadline = session.deadline;
    const maxAttempts = policy.times + 1;
    const timeoutDefault = Number(cfg?.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 45000;
    let lastErr = null;

    for (;;) {
      if (externalSignal?.aborted) throw canceledError();

      const remaining = deadline - Date.now();
      if (session.attempts > 0 && remaining <= RETRY_MIN_HEADROOM_MS) {
        // 预算见底:发出去也几乎必然再超时,只剩"让全桌多等一次"——
        // 用户宁可这一手用本地策略(见 config.cjs 里 timeoutMs 的注释)。
        hooks.onDebug?.(`[座位${this.seat + 1}] 重试预算用尽(已等 ${Math.round((Date.now() - startedAt) / 1000)}s),不再重试`);
        break;
      }
      if (session.attempts >= maxAttempts) {
        // 这一次决策的尝试次数已经用完 —— 兜底,不再烧调用
        hooks.onDebug?.(`[座位${this.seat + 1}] 本次决策已试 ${session.attempts} 次(上限 ${maxAttempts}),不再重试`);
        break;
      }
      const attemptNo = session.attempts;
      session.attempts += 1;
      /**
       * 截断重试与网络重试的分工(重要,别做坏):
       *
       *   截断是**唯一有病因疗法**的失败 —— 病因是 reasoning_content 和正式回答
       *   共用 max_tokens,所以治法就是「额度翻倍 +(DeepSeek 系)关掉推理通道」。
       *   这个治法**只试一次**:连续两次都截断说明这个局面/模型真的给不出正式回答,
       *   再翻倍也只是继续烧调用,那就老实兜底(与本次改动前的行为一致)。
       *
       *   而「没有可识别的动作 / 空回答」**不是**截断病因,原样重发就可能好,
       *   所以它们按普通失败重试,次数同样从这个 session.attempts 里扣。
       *
       *   两条路都只是本循环里的不同**发法**,不是第二个循环 —— 所以
       *   「网络失败 × 截断 × 解析失败」怎么混合也还是 1 + times 次上限。
       *
       * `thinking: {type:'disabled'}` 只有 DeepSeek 系认。自定义中转站后面
       * 挂的是哪家模型完全不确定 —— 发了大概率被拒(现象就是「第一次成功、
       * 第二次失败」),所以对它**不发这个字段**,只靠额度翻倍达成同样的目的:
       * 把额度全留给正式回答。真遇到不认的厂商,参数降级还会兜一层。
       */
      const useDoubled = !!session.doubled;
      // 关掉推理通道只有 DeepSeek 系认,别的厂商发了大概率被 400 拒掉
      const canSkipThinking = providerIdOf(this.cfg) === 'deepseek';
      const mergeExtra = useDoubled && canSkipThinking
        ? { ...(cfg.requestExtra || {}), thinking: { type: 'disabled' } }
        : (cfg.requestExtra || null);
      const attemptCfg = useDoubled
        // 推理型模型(gpt-5 / Claude thinking / kimi-thinking)的草稿很长,额度要真的翻倍。
        // 默认额度 2000 → 这里 4000,仍然高于 2400 的地板(小额度配置下地板兜底)。
        ? { ...cfg, maxTokens: Math.max(2400, (cfg.maxTokens || 2000) * 2), requestExtra: mergeExtra }
        : cfg;
      // 单次尝试的超时**不超过剩余预算**,否则总时长一定会冲破上限
      //(「3 × 45s = 135s」就是这么来的)。
      const attemptTimeoutMs = Math.max(500, Math.min(timeoutDefault, remaining));
      try {
        this._lastRaw = await sendOnce(attemptTimeoutMs, attemptNo, session, attemptCfg);
        /**
         * HTTP 成功了,但「成功」不等于「能用」—— 内容还得过一遍 validator。
         * 这一层是本次改动的核心:以前判「有没有可识别的动作」在重试外壳**外面**,
         * 所以模型返回一段没动作的文本时一次就兜底了(用户实测撞到的那条)。
         * 现在它也在这里数次数、走退避、给用户提示,与网络失败共享同一个上限。
         */
        const bad = validator ? validator() : null;
        if (bad?.verdict) {
          lastErr = parseFailureError(bad.verdict, this._lastRaw);
          // 「翻倍额度」这一趟也救不回截断 → 立刻兜底,不再换发法、不再等退避
          //(与本次改动前的「截断只重试一次」一致:连续两次都截断是根本性问题)
          if (bad.verdict === 'truncated' && session.doubled) {
            hooks.onDebug?.(`[座位${this.seat + 1}] 额度翻倍之后仍然被截断,不再重试`);
            break;
          }
          // 截断且还没换过发法 → 下一趟用「额度翻倍 + 关掉推理通道」(见循环开头)
          if (bad.verdict === 'truncated' && !session.doubled) {
            session.doubled = true;
            hooks.onDebug?.(`[座位${this.seat + 1}] 截断,改用「额度翻倍${canSkipThinking ? ' + 关掉推理通道' : ''}」再发一次(第 ${session.attempts}/${policy.times} 次重试)`);
          }
        } else {
          if (attemptNo > 0) {
            hooks.onDebug?.(`[座位${this.seat + 1}] 第 ${attemptNo} 次重试成功(累计 ${Math.round((Date.now() - startedAt) / 1000)}s)`);
          }
          return this._lastRaw;
        }
      } catch (err) {
        lastErr = err;
      }

      /**
       * 取消要**先判**,而且不能只看错误文本。
       * api 那条路把「超时」和「用户取消」写成同一句「请求超时或被取消」——
       * 只看文本就会把「用户已经退出了」当成一次超时,然后继续重试,
       * 多发请求、还可能把旧决策交给新牌局。
       */
      const err = lastErr;
      if (err?.canceled || externalSignal?.aborted) throw canceledError();

      /**
       * 解析失败(HTTP 成功、内容不可用)是**无条件可重试**的:模型是随机的,
       * 同一条 prompt 重发一次经常就正常了。所以它不参与 classifyErrors
       * (那个开关的意思是「配置性错误别白试」,而对它没有「配置性」可言)。
       * fatal 与否只由 classifyLlmFailure 决定;解析失败那条路会返回 retryable。
       */
      const verdict = policy.classifyErrors ? classifyLlmFailure(err) : 'retryable';
      const left = deadline - Date.now();
      if (verdict === 'fatal' || session.attempts >= maxAttempts || left <= RETRY_MIN_HEADROOM_MS) break;

      // 第几次重试按**本次决策**数(不是本函数的循环序号):截断/解析重试接着往下数,
      // 用户看到的「第 2/3 次」和实际发了几个请求才对得上。
      const retryNo = session.attempts;
      const delay = Math.min(backoffFor(policy, retryNo - 1), left);
      /**
       * 让用户**看得见**在重试。
       * 重试期间界面上只有「思考中」,不说一声的话,一段静默和卡死没有区别 ——
       * 用户对「等了很久没反应」非常敏感(这条提示同时进 toast 与牌局记录,
       * 见 app.js 的 onError 处理:带 retry 标记的会写成 `↻ 名字(模型):…`)。
       */
      const note = `${retryReason(err)},${(delay / 1000).toFixed(1)}s 后重试(第 ${retryNo}/${policy.times} 次)`;
      hooks.onError?.({ seat: this.seat, level: 'info', retry: { attempt: retryNo, times: policy.times }, message: note });
      hooks.onDebug?.(`[座位${this.seat + 1}] ${note}`);
      // 退避这几秒里牌局完全可能被重开 —— sleepWithSignal 会被取消打断并抛出
      await sleepWithSignal(delay, externalSignal);
    }
    // 走到这里只有两种情况:尝试次数用完,或者预算见底。
    // 没有 lastErr 说明是「刚进来就发现预算不够」——给一句能看懂的说明,
    // 不要甩一个「模型调用失败」让用户以为模型自己坏了。
    throw lastErr || new Error('重试预算已用尽,不再等待模型');
  }
  /**
   * 纯 Node 环境下的直连实现(测试与脚本用)。
   *
   * @param {object} [session] 本次决策的重试上下文(见 _callWithRetry)。
   *   这里**只**用它的 omit:模型不认某个参数是模型自己的属性,一次决策里
   *   没必要每次重试都重新踩一遍那个 400(踩两次 = 参数降级 × 网络重试叠加)。
   *   与 api.llmChat 那条路用的是同一个 session,行为也就不会分叉。
   *   (额度翻倍 / 关掉推理通道不在这里判 —— 那是外壳按「这一趟是不是截断重试」
   *    算好之后通过 overrides 传进来的,两条路必须用同一份判断。)
   */
  async callLLMDirect(system, user, externalSignal, overrides, session) {
    const cfg = { ...this.cfg, ...(overrides || {}) };
    const controller = new AbortController();
    const timeoutMs = cfg.timeoutMs || 45000;
    /**
     * 这个请求是**我们自己的看门狗**掐断的,还是用户取消的?
     * 两种都是 AbortError,但含义完全相反:
     *   · 看门狗 → 一次「超时」,上层可以重试(上游抖动就是一过性的);
     *   · 用户取消 → 不许重试,必须立刻停。
     * 外部信号自己会 abort(见下),上层先查 externalSignal.aborted,
     * 所以这里只需要老实标出「是我掐的」。
     */
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    /**
     * ⚠️ 请求体和 SSE 解析**必须**走 shared/llmStream.mjs,不要在这里手写。
     *
     * 这里原来是一份手工复制的 buildRequest + parseSsePayload。后果很严重:
     * 参数降级/协议支持只加到其中一条路径上时,另一条路径静默不变 ——
     * 于是「Node 测试全绿、游戏里照样失败」(真的发生过:降级只加在了这份
     * 只有测试才走的代码里,而网页版/桌面版走 api.llmChat)。
     * 现在两条路径共用同一份构造与解析,只有「谁去发这个请求」不同。
     */
    sharedStreamMod = sharedStreamMod || await import('./llmStream.mjs');
    sharedProvidersMod = sharedProvidersMod || await import('./providers.mjs');
    const provider = sharedProvidersMod.getProvider(providerIdOf(cfg)) || {};
    const built = sharedStreamMod.buildRequest({
      kind: cfg.kind,
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      model: cfg.model,
      system,
      user,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      // 推理档位与网页版/桌面版走同一个字段(见 callLLM 里那段说明)。
      // 这里漏掉的话,Node 路径(测试、脚本)与线上就不是同一份报文了。
      reasoningLevel: cfg.reasoningLevel,
      requestExtra: cfg.requestExtra,
    }, provider);
    if (built.error) {
      // 请求体都拼不出来(缺地址 / 缺 Key / 缺模型名)= 配置问题,
      // 标记成 fatal:重试三次只是白等 5 秒退避,配置不会自己变好。
      const e = llmFail(built.error);
      e.llmFatal = true;
      throw e;
    }
    const { url, headers, body: baseBody, kind } = built;

    /**
     * 发送 —— 带**参数降级重试**。
     *
     * 有些模型(尤其中转站后面的 o 系列 / gpt-5 系列)不认 temperature / max_tokens,
     * 会直接回 400。摘掉那个字段再发一次通常就通了,而且不影响别的模型。
     * 最多降级两次,避免拿坏请求死循环。
     *
     * ⚠️ 摘参数用的是 buildRequest 的 omit(而不是在这里 delete),
     *    这样「同义字段一起摘」的规则也只有一份 —— 手写 delete 时漏掉
     *    max_completion_tokens / max_output_tokens 是踩过的坑。
     *
     * ⚠️ `dropped` 的初值来自 session(本次决策已经摘过的字段),不是空数组:
     *    重试一次就重踩一遍同样的 400 = 把「参数降级」和「网络重试」叠起来,
     *    白白多发一半请求。api.llmChat 那条路用的是同一个 session.omit。
     *
     * ⚠️ 「发送 + 解析」整段都在下面这个 try 里(以前发送那段在 finally 外面):
     *    请求一失败(超时 / 5xx / 参数摘到不能再摘)就直接 throw 出去,
     *    **看门狗定时器和 abort 监听不会被清掉** —— 一个已经没用的 timer
     *    继续挂在事件循环上(最多 timeoutMs),测试里用 process.exit 收尾时
     *    还会撞上 libuv 的 UV_HANDLE_CLOSING 断言(退出码变成崩溃码,
     *    而汇总行明明写着 0 失败 —— 这种"看着全绿其实崩了"最难查)。
     *    重试让失败次数变多,这个坑会更容易踩到,所以顺手修掉。
     */
    const cleanup = () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    };
    try {
      const seeded = (session?.omit || []).length;
      const dropped = [...(session?.omit || [])];
      let res;
      for (let attempt = 0; ; attempt++) {
        const spec = {
          kind: cfg.kind, endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model,
          system, user, temperature: cfg.temperature, maxTokens: cfg.maxTokens,
          // ⚠️ 降级重试这条路也要带上档位,否则「重试时报文与首次不同」——
          //    推理块会因为漏传档位而凭空消失,测试看起来「降级成功」,
          //    实际测的是另一份报文(这个仓库已经栽过两次「两条路径各写一份」)。
          reasoningLevel: cfg.reasoningLevel,
          requestExtra: cfg.requestExtra, omit: dropped.length ? [...dropped] : undefined,
        };
        const sent = dropped.length ? sharedStreamMod.buildRequest(spec, provider) : built;
        try {
          res = await fetch(sent.url || url, {
            method: 'POST', headers: sent.headers || headers,
            body: JSON.stringify(sent.body || baseBody), signal: controller.signal,
          });
        } catch (err) {
          /**
           * 超时要给上层一个能认出来的说法:Node 的 AbortError 文本是
           * 「This operation was aborted」,靠它根本分不清是超时、是我们自己取消,
           * 还是别的什么被中断了 —— 而重试判据必须认得「超时」。
           * (用户取消不用在这里区分:上层先查 externalSignal.aborted。)
           */
          if (timedOut && !externalSignal?.aborted) {
            throw llmFail(`请求超时(${Math.round(timeoutMs / 1000)}s 没有响应)`);
          }
          throw err;
        }
        if (res.ok) {
          // 只有**这一次尝试新摘掉**了字段才提示(理由同 api 那条路:
          // 同一句提示在每次重试后重复刷,会让人以为又出了新问题)
          if (dropped.length > seeded) {
            this.hooks.onError?.({
              seat: this.seat,
              message: `这个模型不认 ${dropped.join(' / ')},已自动去掉后重试成功`,
              raw: '',
              level: 'info',
            });
          }
          break;
        }
        const errText = await res.text().catch(() => '');
        const bad = unsupportedParamIn(errText);
        if (bad && !dropped.includes(bad) && dropped.length < 2 && attempt < 2) {
          dropped.push(bad);
          if (session) session.omit = [...dropped];   // 记给本次决策的后续尝试
          continue;
        }
        throw llmFail(`接口返回 ${res.status}: ${errText.slice(0, 180)}`, res.status);
      }
      if (!res.body) throw llmFail('接口没有返回流式内容', res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';
      let reasoning = '';
      let finishReason = '';
      // 流里报出来的错误(共享解析器在 finish 事件上带出来的 error 字段)。
      // 这里以前只取 c.finish、把 c.error 丢了 —— 「HTTP 200 + 流里报错」于是变成
      // 「成功的空回答」,再经下面的 `full || reasoning` 兜底,最后表现成
      // 「模型没给出可识别动作」这种完全不指向病因的结论。原文必须带上去。
      let streamError = '';

      /**
       * 思考阶段的增量也要推给界面。
       *
       * 以 deepseek-flash 为例,一次请求的流是:
       *   先 137 字的 reasoning_content,再 23 字的 content(正式回答)。
       * 早期实现只对 content 调 onThink,于是**整个推理阶段界面一片空白**,
       * 用户看到的是「等很久 → 答案突然蹦出来」,完全不是「看着他想」。
       *
       * 现在:推理先流式显示(标记 thinking=true,界面可以显示得淡一些),
       * 正式回答到达时再接上,界面据此切换成最终文本。
       */
      const emitThink = (chunk, isReasoning) => {
        if (!chunk) return;
        if (isReasoning) reasoningChunks += 1; else answerChunks += 1;
        try { this.hooks.onThink?.(chunk, full, !!isReasoning); } catch { /* 界面出错不影响主流程 */ }
      };

      let reasoningChunks = 0;
      let answerChunks = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // 解析交给共享实现 —— 它与网页版/桌面版走的是同一个函数,
        // 新增协议(responses 等)只要改那一处,三条路径同时生效。
        buffer = sharedStreamMod.consumeSseBuffer(buffer, kind, (c) => {
          if (c.error) { streamError = String(c.error); return; }
          if (c.phase === 'finish') { if (c.finish) finishReason = c.finish; return; }
          if (c.phase === 'reasoning') { reasoning += c.reasoning; emitThink(c.reasoning, true); return; }
          if (c.phase === 'answer') { full += c.text; emitThink(c.text, false); }
        });
      }

      /**
       * 截断检测:推理把 max_tokens 吃光,正式回答一个字都没来。
       *
       * 这一条很容易被忽略 —— 界面上看是「思考了很久」,实际上模型根本
       * 没来得及给决策,后面的动作是从残缺的推理文本里硬猜出来的。
       * 实测 deepseek-flash 在默认 effort=high 下,复杂局面有 33% 的请求
       * 会这样(推理吃光 1200 token,finish_reason=length,回答 0 字)。
       *
       * 记在实例上,重试外壳靠它决定「这次算不算截断、要不要换发法重试」
       * (见 _callWithRetry 里读 lastTruncated 的那条分支;判据与 api 那条路一致)。
       * ⚠️ 用 cfg.maxTokens(本次尝试**实际**发出去的额度),不是 this.cfg ——
       *    截断重试那一趟额度是翻倍的,写 this.cfg 会把 4000 说成 2000。
       */
      this.lastTruncated = null;
      if (answerChunks === 0 && reasoningChunks > 0) {
        const cur = Number(cfg.maxTokens) || 300;
        const note = finishReason === 'length'
          ? `模型把 ${cur} 个 token 全用在推理上了,正式回答被截断`
          : '模型只输出了推理过程,没有给出正式回答';
        this.lastTruncated = {
          seat: this.seat, reason: finishReason, note,
          reasoningChars: reasoning.length, suggestedMaxTokens: Math.max(1200, cur * 3),
        };
        this.hooks.onTruncated?.(this.lastTruncated);
        this.hooks.onDebug?.(`[座位${this.seat + 1}] ${note}`);
      }
      // 流里报错就当失败抛出(原文带上),不能让下面那条兜底把错误吞成「有回答」。
      // 状态码从原文里捞(HTTP 200 的流里报错通常带着 "code":503 这类东西):
      // 重试外壳要靠它判断值不值得再试。
      if (streamError) throw llmFail(`上游流里报错:${streamError}`);
      // ⚠️ 这里 `|| reasoning` 是**有争议的兜底**:正式回答为空时把推理原文
      //    当答案交出去,调用方会拿英文散文去解析 JSON、失败后还可能从散文里
      //    猜出一个动作(实测猜出过 allin)。保留是为了还能抢救出一点信息,
      //    但外壳会先看 lastTruncated 并重试 —— 不要依赖这条兜底做决策。
      return full || reasoning;
    } finally {
      cleanup();
    }
  }
}


/**
 * 这些纯函数/常量也导出:测试要直接验证它们的行为
 * (tools/retrytest.mjs、tools/parseretrytest.mjs 就是这么用的),
 * 游戏模块也可以按需再转发。
 */
export {
  LLM_RETRY, RETRY_MIN_HEADROOM_MS, CANCEL_MESSAGE,
  providerIdOf, unsupportedParamIn, extractJson,
  classifyLlmFailure, resolveRetryPolicy, canceledError, llmFail, statusFromText,
  parseFailureError, parseFailureMessage, retryReason, backoffFor, sleepWithSignal,
};
