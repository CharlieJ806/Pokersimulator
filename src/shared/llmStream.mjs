/**
 * LLM 请求构造 + 流式解析(共享,**唯一真源**)
 *
 * 为什么这份是 ESM(.mjs)而不是 CJS:
 *   浏览器不能加载 .cjs —— CommonJS 的 module.exports 浏览器不认,
 *   连 `import x from './x.cjs'` 都会报 "does not provide an export named 'default'"。
 *   所以共享代码必须以 ESM 存在。需要 CJS 的一方(Electron 主进程)
 *   通过 llmStream.cjs 用 `import()` 桥接。
 *
 * 用在哪三处:
 *   · Electron 主进程 src/main/config.cjs —— 经 llmStream.cjs 桥接;
 *   · Cloudflare Worker worker/src/index.js —— 直接 import;
 *   · 浏览器前端 web/pokerApi.js —— 直接 import。
 *   请求体怎么拼、SSE 怎么解,只在这里写一次,避免三处漂移。
 */

/* ------------------------------------------------------------ 中转站协议 */

/**
 * 自定义中转站支持的协议。
 *
 * 为什么协议要挂在**每个 Key** 上,而不是整个中转站一个:
 *   PackyAPI 这类中转站的「令牌分组」决定了这个 Key 能调哪些模型,
 *   而**分组和协议是绑定的** —— CC 分组的 Claude 模型只挂 ANTHROPIC 标签,
 *   Kimi-sale 的 kimi-k3 只挂 OPENAI-RESPONSE 标签。
 *   同一个中转站里,不同分组的 Key 就是不同协议,所以协议必须逐 Key 配置。
 *
 * 四个 id 同时也是 buildRequest 里的 `kind`,1:1 对应,不再多一层映射表
 * (多一层就多一处会漂移的地方)。
 *
 * `path` 是「把尾替换成什么」用的(见 endpointForProtocol),`hint` 只给下拉框显示。
 * gemini **没有**这个意义上的 path:它的 URL 里要插模型名和动作
 * ({base}/models/{模型}:streamGenerateContent),不是换个尾巴能表达的,
 * 所以 path 留空、由 geminiUrl() 单独拼 —— 硬塞一个 path 进来会让
 * endpointForProtocol 拼出 /chat/completions/models/... 这种必然 404 的地址。
 */
export const RELAY_PROTOCOLS = [
  { id: 'openai', name: 'OpenAI 兼容', path: 'chat/completions', hint: '/chat/completions' },
  { id: 'anthropic', name: 'Anthropic', path: 'messages', hint: '/messages' },
  { id: 'responses', name: 'OpenAI Responses', path: 'responses', hint: '/responses' },
  { id: 'gemini', name: 'Google (Gemini)', path: '', hint: '/models/{模型}:streamGenerateContent' },
];

/** 认不出的协议一律当 openai —— 这是绝大多数中转站/厂商的默认形态 */
export function normalizeProtocol(p) {
  return RELAY_PROTOCOLS.some((x) => x.id === p) ? p : 'openai';
}

/* ------------------------------------------------------------ 推理档位 */

/**
 * 推理档位 —— **四家协议的统一开关**(唯一真源,界面/配置只填这一个值)。
 *
 * 为什么要有「最低档」这个中间选项,而不是简单的开/关:
 *   关了推理,难题上模型会**降智**(它连草稿都不打就得直接给结论);
 *   开着默认档,它又会**想很久**——推理 token 和正式回答**共用同一个额度**,
 *   牌桌上的表现就是「等 78 秒 → 超时」或者「推理把额度吃光、正式 JSON 一个字没吐出来」。
 *   我们要的从来不是「不要思考」,而是「别啰嗦」:想一两句就出决策。
 *   所以默认档 = low:保留推理通道,压到各家允许的最小值。
 *
 * 每个协议的字段名都不一样(这是这张表存在的全部理由,**不要**在调用方再拼一遍):
 *   · openai    → 顶层 reasoning_effort: 'low'
 *   · gemini    → generationConfig.thinkingConfig.thinkingBudget(嵌套一层)
 *   · anthropic → 顶层 thinking: { type:'enabled', budget_tokens }
 *   · responses → 顶层 reasoning: { effort:'low' }
 *
 * 三档的语义:
 *   'low'     **默认**。最低但保留(见上)。openai 只有在调用方**显式**要 low 时才发
 *             reasoning_effort —— 这个字段不是所有 OpenAI 兼容服务都认(不认的直接 400),
 *             老路径(内置厂商)靠 provider.requestExtra 自己声明,这里不擅自加。
 *   'off'     完全关闭:Gemini thinkingBudget:0、Anthropic 不发 thinking、
 *             openai/responses 不发对应字段。**不推荐**,除非确定这个模型不需要推理。
 *   'default' 什么都不发,走厂商默认(等于「我不管,你自己看着办」)。
 *
 * ⚠️ 'off' 有一个**改不掉的限制**:它在 Gemini 上就是 `thinkingBudget: 0`
 *    (Google 定义的关闭值),而 0 在 2.5 Pro 这类型号上会被上游拒 —— 这是 Google 侧的规则。
 *    能做的只有两层兜底:① 默认档用非零小值(512),哪家都收,所以正常路径根本走不到 0;
 *    ② 真被拒了,agent.js 的嵌套降级会摘掉整个 thinkingConfig 退回厂商默认,牌局不会崩。
 */
export const REASONING_LEVELS = ['off', 'low', 'default'];

/**
 * 默认档位:'low' —— 保留推理但压到各家允许的最低档。
 *
 * ⚠️ 曾经试过把默认改成 'default'(什么都不发),**实测证明那是错的**,已回滚:
 *    在**游戏实际使用的 deepseek-flash** 上,同一个牌局问题:
 *      · 'low'              → reasoning  686 字 / 211 token / 2.0s
 *      · 'default'(什么都不发) → reasoning 3769 字 / 1156 token / 8.0s  ← 最差
 *      · 'off'(thinking:disabled) → reasoning 0 字 / 69 token / 1.0s   ← 最优
 *    也就是说 flash 这类模型**默认是重度思考的**,不传参数等于放任它长考
 *    (8 秒 + 5.5 倍 token),而 'low' 是真的把它压下来了。
 *    (教训:别拿 deepseek-chat 的测量结果推断 deepseek-flash —— chat 默认不思考,
 *     两者的默认行为正交,见 tools/ 里那次对比实验。)
 *    'off' 在这组测量里更快更省,但会连真的需要推理的模型一起按死,
 *    所以不设为默认;想要极致速度的人可以在面板里选它。
 */
export const DEFAULT_REASONING_LEVEL = 'low';

/**
 * Gemini 的最低思考预算。
 *
 * ⚠️ 512 这个数**单独钉死在测试里**(tools/relayprotocol.mjs)。
 *    0 = 完全关闭,是上一个版本的做法 —— 用户明确要求「保留推理但压到最低」,
 *    而且 0 在 2.5 Pro 上会被上游拒绝(见上面 REASONING_LEVELS 的说明)。
 *    512 是「非零的小值」:Flash / Pro 都收,足够它想一两句,又远小于牌桌耐心。
 */
export const GEMINI_THINKING_BUDGET = 512;

/** Anthropic 思考预算的最小值 —— 官方文档规定不得小于 1024,再小上游直接 400 */
export const ANTHROPIC_THINKING_BUDGET = 1024;

/**
 * 认不出的档位一律当默认档(low) —— 老配置里没有这个字段,不能因此变成「不设防」。
 * ⚠️ 回落成 'default'(什么都不发) 曾经试过并**实测证伪**:deepseek-flash 默认会
 *    长考(3769 字 / 8 秒),不传参数等于放任它,详见 DEFAULT_REASONING_LEVEL 的注释。
 */
export function normalizeReasoningLevel(v) {
  return REASONING_LEVELS.includes(v) ? v : DEFAULT_REASONING_LEVEL;
}

/** 协议 → buildRequest 的 kind。目前 1:1,保留成函数是为了将来不必改所有调用点 */
export function kindForProtocol(p) {
  return normalizeProtocol(p);
}

/**
 * 去掉地址尾巴上「别的协议留下的路径」,只留 base。
 *
 * 为什么要单独一步:界面教用户把地址填到 `/v1` 为止,**也**允许填完整路径
 * (默认占位符就是 `https://中转站/v1/chat/completions`)。换协议时那截尾巴
 * 必须扔掉 —— 否则会拼出 `.../v1/chat/completions/messages` 这种谁也不认的地址,
 * 而用户会以为「地址一个字都没改,怎么就不通了」。
 */
function stripProtocolTail(url) {
  const known = RELAY_PROTOCOLS.map((x) => x.path).filter(Boolean);
  const hit = known.find((p) => url.endsWith('/' + p));
  // ⚠️ 切掉尾巴之后**还要再削一次结尾斜杠**:`.../v1/chat/completions` 切完是
  //    `.../v1/`,再拼 `/${path}` 就成了 `.../v1//chat/completions`(双斜杠)。
  //    实测有的中转站按字面匹配路径,双斜杠直接 404 —— 拼 URL 时最容易漏的一步。
  const cut = hit ? url.slice(0, url.length - hit.length) : url;
  return cut.replace(/\/+$/, '');
}

/**
 * 把用户填的接口地址改写成**该协议真正的路径**。
 *
 * 为什么需要:用户只填一个地址(通常是以 `/chat/completions` 结尾的),
 * 但换了协议之后要打的路径完全不同(`/v1/messages`、`/v1/responses`)。
 * 如果这里不改写,用户把 Key 的协议切成 Anthropic 之后,请求还是会打到
 * `/chat/completions` —— 于是又回到 `protocol_not_supported`,
 * 而用户完全看不出哪里错了(地址一个字都没改过)。
 *
 * 只替换**已知的尾巴**;认不出的地址按协议追加。gemini 不走这里
 * (它的 URL 要拼 /models/{model}:streamGenerateContent,见 geminiUrl)。
 */
export function endpointForProtocol(endpoint, kind) {
  const url = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!url) return url;
  const proto = RELAY_PROTOCOLS.find((x) => x.id === kind);
  if (!proto) return url;
  // gemini 的 path 是空的(见 RELAY_PROTOCOLS 的注释):它的 URL 形态表达不了
  // 「换个尾巴」,原样返回,由 geminiUrl() 负责。这里不抛错也不猜,
  // 免得调用方以为已经改好了。
  if (!proto.path) return url;
  return `${stripProtocolTail(url)}/${proto.path}`;
}

/**
 * Google 原生格式的请求地址(**用户只填一个 base 就能用**,规则都写在这儿)。
 *
 * 形态和另外三种协议完全不同 —— 版本段、模型名、动作三样都嵌在路径里,
 * 还要带查询串:
 *   {base}/models/{模型}:streamGenerateContent?alt=sse&key={Key}
 * 认证走 query 里的 `key`,**不是** Authorization 也不是 x-api-key。
 *
 * 推导规则(每一步后面都写了为什么;第 4 条是这一版顺手修掉的老 bug):
 *   1. 砍掉 `?query` / `#hash` 和结尾斜杠 —— 有人会把整条 gemini URL 连
 *      `?alt=sse&key=...` 一起贴进来,不砍的话会拼出双查询串。
 *   2. 已经带 `:streamGenerateContent` 的整条 URL:削回 base 再重拼,
 *      免得出现 `...:streamGenerateContent/models/...`。
 *   3. 去掉**别的协议**的尾巴(/chat/completions、/messages、/responses):
 *      界面推荐的填法就是 `{域名}/v1/chat/completions`,协议改选 Gemini 时
 *      那截必须扔掉(不扔 = `.../v1/chat/completions/models/...`,永远 404)。
 *   4. 已经以 `/models` 结尾的不再重复拼 —— 内置 Gemini 厂商的地址就是
 *      `https://generativelanguage.googleapis.com/v1beta/models`,
 *      以前无脑 `${base}/models/...` 会变成 `/models/models/...`,必然 404。
 *   5. 没有版本段(v1 / v1beta / v1alpha)时补 `/v1beta`:Google 原生接口
 *      必须带版本段,而用户填中转站时通常只写域名。填了 `/v1` 的原样保留
 *      (那是中转站自己的版本段,不替用户改),于是
 *      `https://cf.api.fan` → `.../v1beta/models/...`、
 *      `https://cf.api.fan/v1` → `.../v1/models/...`,两种填法都能用。
 *   6. 模型名只取最后一段并做 URL 编码:中转站常写成 `vendor/model`,
 *      而它是拼进路径的,不能让它带斜杠或 `..` 之类的字符进去。
 */
export function geminiUrl(endpoint, model, apiKey) {
  let base = String(endpoint || '').trim();
  base = base.split('#')[0].split('?')[0].replace(/\/+$/, '');
  if (!base) return base;
  // 整条 gemini URL 贴进来(带动作)也能认:先削回 /models 之前
  base = base.replace(/\/models\/[^/]*:(?:streamGenerateContent|generateContent)$/, '');
  base = stripProtocolTail(base);
  if (!/\/models$/.test(base)) {
    if (!/\/v\d+[a-z]*$/i.test(base)) base += '/v1beta';
    base += '/models';
  }
  const name = String(model || '').trim().split('/').pop();
  return `${base}/${encodeURIComponent(name)}:streamGenerateContent`
    + `?alt=sse&key=${encodeURIComponent(apiKey)}`;
}

/**
 * 按**模型名**修正请求参数 —— 不看厂商,只看模型。
 *
 * 为什么按模型名:自定义中转站后面挂的可能是任何一家,厂商 id 永远是 'custom',
 * 只有模型名能说明「这其实是 Claude / Kimi / GPT-5」。而各家对参数的容忍度差别很大,
 * 我们默认发的 temperature 1.1 只有 DeepSeek / Gemini / Qwen / Grok 这类(0~2)收,
 * 其余直接 400 —— 这正是「中转站只有 deepseek / gemini / mimo 能用」的根因。
 *
 *   · Claude / Kimi(Moonshot)/ GLM / MiniMax:temperature 上限 1;
 *   · o1/o3/o4 推理系列与 gpt-5 系列:只接受默认 temperature,
 *     而且不认 max_tokens,要改成 max_completion_tokens;
 *   · Anthropic 原生接口:temperature 上限同样是 1。
 *
 * 这里是**预防**;万一还有漏网的,agent.js 会按报错文字摘掉对应参数再重试(兜底)。
 * @returns {{tempMax?:number, noTemperature?:boolean, maxCompletionTokens?:boolean}}
 */
export function modelQuirks(model, kind = 'openai') {
  const m = String(model || '').toLowerCase().split('/').pop();   // openrouter 风格 vendor/model 只看后半
  const q = {};
  if (kind === 'anthropic') q.tempMax = 1;
  if (/(^|[^a-z])(claude|kimi|moonshot|glm|chatglm|zhipu|minimax|abab)/.test(m)) q.tempMax = 1;
  // Responses 协议里额度字段本来就叫 max_output_tokens(不叫 max_tokens),
  // 所以不需要「改名」这一步 —— 只需要处理 temperature。
  if (/^(o\d|gpt-5)/.test(m)) {
    q.noTemperature = true;
    if (kind !== 'responses') q.maxCompletionTokens = true;
  }
  return q;
}

/** 把 modelQuirks 套到已经拼好的 OpenAI 兼容请求体上(Node 直连那条路径也用它) */
export function applyModelQuirks(body, model, kind = 'openai') {
  const q = modelQuirks(model, kind);
  if (q.noTemperature) delete body.temperature;
  else if (q.tempMax !== undefined && typeof body.temperature === 'number') {
    body.temperature = Math.min(body.temperature, q.tempMax);
  }
  if (q.maxCompletionTokens && body.max_tokens !== undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  return body;
}

/**
 * 把「推理档位」落到各协议各自的字段上(见 REASONING_LEVELS 的说明)。
 *
 * 为什么单独抽成一个函数、而且在**最后**才调用:
 *   四个协议的字段名、嵌套层级都不一样(Gemini 那个还藏在 generationConfig 里),
 *   分散到四条分支里写必然漂移。集中一处的另一个好处是
 *   **参数降级重试能摘得掉它**(见下面 omit 的处理)。
 *
 * @param {object} body 已经拼好的请求体(会被就地修改)
 * @param {string} kind 'openai' | 'anthropic' | 'gemini' | 'responses'
 * @param {string} level 'off' | 'low' | 'default'(已 normalize)
 * @param {{maxTokens?:number, explicit?:boolean}} opts
 *   explicit=true 表示调用方(配置)显式给了档位 —— openai 协议据此决定要不要发
 *   reasoning_effort(理由见 REASONING_LEVELS 的说明)。
 */
function applyReasoningLevel(body, kind, level, opts = {}) {
  const maxTokens = Number(opts.maxTokens) || 0;

  if (kind === 'gemini') {
    // Gemini 只有「嵌套在 generationConfig 里」这一种写法。
    // 'default' 必须**删掉整个 thinkingConfig**(不是设 0)——设 0 是「关闭」,语义相反。
    if (!body.generationConfig) return body;
    if (level === 'off') body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    else if (level === 'default') delete body.generationConfig.thinkingConfig;
    else body.generationConfig.thinkingConfig = { thinkingBudget: GEMINI_THINKING_BUDGET };
    return body;
  }

  if (kind === 'anthropic') {
    /**
     * Anthropic 的硬约束:`budget_tokens` **必须小于** `max_tokens`,否则上游直接 400。
     * 所以额度装不下这个预算时,宁可不发 thinking(退回厂商默认)——
     * 发了必然失败,而且失败信息是参数错,和「额度不够」看起来一点关系都没有。
     * 默认额度 2000 > 1024,正常配置走不到这个分支。
     */
    if (level === 'low' && maxTokens > ANTHROPIC_THINKING_BUDGET) {
      body.thinking = { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET };
    } else {
      delete body.thinking;
    }
    return body;
  }

  if (kind === 'responses') {
    if (level === 'low') body.reasoning = { effort: 'low' };
    else delete body.reasoning;
    return body;
  }

  // openai 兼容口
  if (level === 'low') {
    // 只有调用方显式要了才发:这个字段不是所有 OpenAI 兼容服务都认,
    // 内置厂商里只有实测过的(deepseek)由 provider.requestExtra 自己声明。
    if (opts.explicit) body.reasoning_effort = 'low';
  } else {
    delete body.reasoning_effort;
  }
  return body;
}

/** 把 spec 规范化成「请求 URL + headers + body」 */
export function buildRequest(spec, provider = {}) {
  const kind = spec.kind || provider.kind || 'openai';
  const apiKey = String(spec.apiKey || '').trim();
  let url = String(spec.endpoint || provider.endpoint || '').trim();
  if (!url) return { error: '没有配置接口地址' };
  if (!apiKey && !provider.noKey) return { error: `缺少 ${provider.name || '该厂商'} 的 API Key` };

  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (kind === 'anthropic') {
    // 协议决定路径:用户可能填的是 /chat/completions 结尾的同一个地址
    url = endpointForProtocol(url, 'anthropic');
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // Anthropic 默认禁止浏览器直连,这个头是官方给的开关;
    // 走 Worker 转发时其实用不到,但直连本地代理时有用,留着无害。
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = {
      model: spec.model,
      max_tokens: spec.maxTokens || 300,
      temperature: spec.temperature ?? 1.1,
      system: spec.system,
      messages: [{ role: 'user', content: spec.user }],
      stream: true,
    };
  } else if (kind === 'gemini') {
    /**
     * Google 原生格式(generateContent / streamGenerateContent)。
     *
     * ⚠️ 思考预算(thinkingConfig.thinkingBudget)由 applyReasoningLevel 统一发,
     *    这里**不要**再写一份 —— 档位是可配置的,两处各写一遍必然漂移。
     *    档位说明见 REASONING_LEVELS:默认是 512(最低但保留),不是 0。
     *    0 是「完全关闭」:会被 2.5 Pro 这类型号拒掉,而且关掉推理在难题上会降智。
     *
     * 认证走 URL 里的 ?key=(见 geminiUrl),所以这里不设 Authorization / x-api-key。
     * system 走**顶层 systemInstruction**,不是 messages 里的一条 ——
     * Gemini 没有 system role,塞进 contents 会变成用户消息,约束力变弱。
     */
    url = geminiUrl(url, spec.model, apiKey);
    body = {
      systemInstruction: { parts: [{ text: spec.system }] },
      contents: [{ role: 'user', parts: [{ text: spec.user }] }],
      generationConfig: {
        temperature: spec.temperature ?? 1.1,
        maxOutputTokens: spec.maxTokens || 300,
        // 提示词要求「只输出 JSON」,原生接口可以顺手把 MIME 也钉死;
        // 它和 SSE 流不冲突,增量照样是 candidates[].content.parts[].text。
        responseMimeType: 'application/json',
      },
    };
  } else if (kind === 'responses') {
    /**
     * OpenAI Responses API(/v1/responses)。
     *
     * 与 chat completions 的三处硬差别(照抄官方文档,别自己发明):
     *   1. system 提示词走**顶层 `instructions`**,不是 messages 里的一条。
     *      塞进 input 里虽然某些实现也收,但混在对话历史里容易被当成用户消息,
     *      指令约束力变弱 —— 而我们这套提示词全靠约束(只输出 JSON)。
     *   2. 输入叫 `input`,元素形如 {role, content}。
     *   3. 输出额度叫 **`max_output_tokens`**,不叫 max_tokens。
     */
    url = endpointForProtocol(url, 'responses');
    headers.Authorization = `Bearer ${apiKey}`;
    body = {
      model: spec.model,
      instructions: spec.system,
      input: [{ role: 'user', content: spec.user }],
      max_output_tokens: spec.maxTokens || 300,
      temperature: spec.temperature ?? 1.1,
      stream: true,
    };
  } else {
    url = endpointForProtocol(url, 'openai');
    headers.Authorization = `Bearer ${apiKey}`;
    if (provider.id === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/local/poker-dealer-sim';
      headers['X-Title'] = 'Poker Dealer Sim';
    }
    body = {
      model: spec.model,
      messages: [
        { role: 'system', content: spec.system },
        { role: 'user', content: spec.user },
      ],
      temperature: spec.temperature ?? 1.1,
      max_tokens: spec.maxTokens || 300,
      stream: true,
    };
  }

  // 厂商特有的请求参数(例如 deepseek 关掉思维链通道)。
  // 放在最后合并,这样厂商配置说了算;调用方想覆盖也可以自己传 requestExtra。
  const extra = spec.requestExtra || provider.requestExtra;
  if (extra && typeof extra === 'object') Object.assign(body, extra);

  // 按模型名修正参数(见 modelQuirks)。Gemini 的参数在 generationConfig 里,范围 0~2,不用修。
  if (kind !== 'gemini') applyModelQuirks(body, spec.model, kind);

  /**
   * 推理档位放在 requestExtra **之后** —— 它必须能覆盖厂商/调用方塞进来的同名字段,
   * 否则用户在界面上选「关闭」也关不掉,那个开关就是个骗人的摆设。
   * 未显式配置时(explicit=false)仍然按默认档走:'off'/'default' 一样会摘掉字段,
   * 'low' 只在显式配置时才给 openai 补 reasoning_effort(理由见 applyReasoningLevel)。
   */
  const rawLevel = spec.reasoningLevel ?? provider.reasoningLevel;
  applyReasoningLevel(body, kind, normalizeReasoningLevel(rawLevel), {
    maxTokens: spec.maxTokens,
    explicit: rawLevel !== undefined,
  });

  /**
   * 调用方要求摘掉的字段(agent.js 按报错文字降级重试时传进来)。
   *
   * 写 max_tokens 时把三个同义字段一起摘:不同协议/不同世代叫法不同
   * (max_tokens / max_completion_tokens / max_output_tokens),
   * 漏掉一个就会「降级了但报错照旧」——最难查的那种。
   *
   * ⚠️ 'thinking' 要摘的是**整个思考块**,不能只 delete 顶层:
   *    Anthropic 的 thinking、openai 的 thinking 确实在顶层,但 Gemini 的
   *    thinkingConfig **嵌在 generationConfig 里**,顶层 delete 一个字都摘不掉 ——
   *    现象就是「降级重试了,报错照旧」,而这一次连日志都看不出问题(请求确实重建过)。
   *    摘掉整块 = 退回厂商默认档,这正是降级想要的结果。
   */
  for (const k of spec.omit || []) {
    delete body[k];
    if (k === 'max_tokens') {
      delete body.max_completion_tokens;
      delete body.max_output_tokens;
    }
    if (k === 'thinking' && body.generationConfig) delete body.generationConfig.thinkingConfig;
  }

  return { url, headers, body, kind, apiKey };
}

/**
 * 从一行 SSE `data:` 载荷里抽出增量。
 * @returns {{phase:'reasoning'|'answer'|'finish', text?:string, reasoning?:string, finish?:string}|null}
 */
export function parseSsePayload(payload, kind) {
  if (!payload || payload === '[DONE]') return null;
  let json;
  try { json = JSON.parse(payload); } catch { return null; }

  if (kind === 'anthropic') {
    if (json.type === 'content_block_delta') {
      const d = json.delta || {};
      if (d.type === 'text_delta' && d.text) return { phase: 'answer', text: d.text };
      if (d.type === 'thinking_delta' && d.thinking) return { phase: 'reasoning', reasoning: d.thinking };
    }
    // 结束原因另发一个 message_delta 事件(stop_reason: end_turn / max_tokens)
    if (json.type === 'message_delta' && json.delta?.stop_reason) {
      return { phase: 'finish', finish: String(json.delta.stop_reason) };
    }
    return null;
  }

  if (kind === 'gemini') {
    /**
     * 流里报错也要认(和下面 openai 那条同理,只是帧的形状不同)。
     *
     * 为什么:Google 的 streamGenerateContent 在 HTTP 200 之后仍可能发一帧
     * `{"error":{"code":503,"message":"The model is overloaded…"}}`(过载、渠道异常)。
     * 不认它的话,这一帧没有 candidates,整条流会被当成「成功的空回答」——
     * 界面上只剩「模型没给出可识别动作」,真正的死因一个字都不露。
     * 必须放在解析 candidates **之前**:真出错时不该再去读一个不存在的正文。
     */
    if (json.error) {
      const msg = json.error?.message || json.error?.code || json.error;
      return { phase: 'finish', finish: 'error', error: String(msg) };
    }
    /**
     * 把「思考」和「正文」分开 —— Gemini 用 part.thought=true 标记这一段是思考。
     *
     * ⚠️ 以前这里把所有 parts 的文字无条件拼成正文。思考预算为 0(关闭)时看不出问题,
     *    但档位改成 512(保留最低档)之后,思考一定会出现 —— 那时若不分流:
     *      · 牌桌上会把模型的内部思考当"正式回答"渲染出来(而 thinking 字段另有其人);
     *      · 更糟的是 agent 的截断判据「只来了推理、正文一个字都没有」永远不会成立,
     *        于是「正式 JSON 没吐出来」被当成一次成功,决策是从思考散文里猜的。
     *    同一帧里既有思考又有正文时按正文优先(与 openai 那条 delta 的取舍一致)。
     */
    let text = '';
    let think = '';
    const parts = json.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (!p.text) continue;
      if (p.thought) think += p.text; else text += p.text;
    }
    if (text) return { phase: 'answer', text };
    if (think) return { phase: 'reasoning', reasoning: think };
    const fr = json.candidates?.[0]?.finishReason;
    return fr ? { phase: 'finish', finish: String(fr) } : null;
  }

  /**
   * OpenAI Responses(/v1/responses)—— 事件名与 chat completions 完全不同。
   *
   * 它的 SSE 每帧是 `event: xxx` + `data: {type:"xxx", ...}`。
   * consumeSseBuffer 只认 `data:` 行,而 data 里的 `type` 和 event 名一致,
   * 所以只按 `json.type` 分派就够了,不必去读 event 行。
   *
   * 增量字段一律叫 `delta`(字符串),不是 chat completions 那种
   * choices[0].delta.content 嵌套 —— 照抄那一套会一个字都取不到。
   */
  if (kind === 'responses') {
    switch (json.type) {
      case 'response.output_text.delta':
        return json.delta ? { phase: 'answer', text: json.delta } : null;
      // 推理摘要:gpt-5 这类默认只给摘要(reasoning summary),给的是人话,
      // 正好和我们界面上「显示思考」的需求一致。
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return json.delta ? { phase: 'reasoning', reasoning: json.delta } : null;
      case 'response.completed':
        return { phase: 'finish', finish: String(json.response?.status || 'completed') };
      case 'response.incomplete':
        return { phase: 'finish', finish: String(json.response?.incomplete_details?.reason || 'incomplete') };
      case 'response.failed':
      case 'error': {
        const msg = json.response?.error?.message || json.error?.message || json.message || '模型返回了失败事件';
        // 走 finish 通道把错误带上去,让调用方把「响应体里报错」和「HTTP 报错」一起处理
        return { phase: 'finish', finish: 'error', error: String(msg) };
      }
      default:
        return null;
    }
  }

  /**
   * OpenAI 兼容实现也常在**流里**报错(HTTP 已经 200 了):
   *   data: {"error":{"message":"上游渠道不可用","code":"channel_error"}}
   * 这种帧里没有 choices,不认它的话整条流会被当成「成功的空回答」——
   * 调用方只看到「模型没给出可识别动作」,真正的死因一个字都不露。
   * 放在 choices 解析**之前**:真出错时不该再去读一个不存在的 delta。
   */
  if (json.error) {
    const msg = json.error?.message || json.error?.code || json.error;
    return { phase: 'finish', finish: 'error', error: String(msg) };
  }

  const delta = json.choices?.[0]?.delta || {};
  // 同一条 delta 里可能同时带 reasoning 和 content(阶段交界处),
  // 这种时候按「content 优先」处理,否则会把已经开始的回答又清掉。
  if (delta.content) return { phase: 'answer', text: delta.content };
  if (delta.reasoning_content) return { phase: 'reasoning', reasoning: delta.reasoning_content };
  const fr = json.choices?.[0]?.finish_reason;
  return fr ? { phase: 'finish', finish: String(fr) } : null;
}

/**
 * 解析一整段 SSE 文本(可能有不完整的最后一行)。
 *
 * onChunk 收到的对象(phase 表示这段增量属于哪个阶段):
 *   { phase:'reasoning', reasoning } —— 推理阶段(deepseek 的 reasoning_content、
 *                                       anthropic 的 thinking_delta、
 *                                       responses 的 reasoning_summary_text.delta)
 *   { phase:'answer',    text }      —— 正式回答
 *   { phase:'finish',    finish }    —— 这一轮结束了,finish 是结束原因
 *                                       (length / max_tokens 都表示被额度截断)
 *                                       调用方不认识这个 phase 可以忽略它。
 *
 * ⚠️ reasoning 必须处理。以 deepseek-flash 为例,一次请求先流 137 字 reasoning,
 *    再流 23 字 content;只处理 content 的话整个推理阶段界面是空白的,
 *    体验退化成「等很久 → 答案突然蹦出来」。
 *
 * @param {string} buffer 累积缓冲
 * @param {string} kind 'openai' | 'anthropic' | 'gemini' | 'responses'
 * @param {(chunk:{phase:'reasoning'|'answer'|'reset', text?:string, reasoning?:string})=>void} onChunk
 * @returns {string} 剩余的、还没成行的尾部
 */
export function consumeSseBuffer(buffer, kind, onChunk) {
  const lines = buffer.split('\n');
  const rest = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const parsed = parseSsePayload(trimmed.slice(5).trim(), kind);
    if (parsed) onChunk(parsed);
  }
  return rest;
}
