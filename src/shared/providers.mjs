/**
 * LLM 厂商配置(**唯一真源**)
 *
 * 为什么这份是 ESM(.mjs):
 *   浏览器不能加载 .cjs,而浏览器前端需要自己渲染厂商下拉框、
 *   决定往哪个 endpoint 发请求,所以这张表必须以 ESM 存在。
 *   Electron 主进程(CommonJS)通过 providers.cjs 用 `import()` 桥接。
 *
 * 三处共用:
 *   · 浏览器前端 web/pokerApi.js
 *   · Cloudflare Worker worker/src/index.js(用它生成转发白名单)
 *   · Electron 主进程 src/main/config.cjs(经 providers.cjs 桥接)
 *
 * 设计:统一走「OpenAI 兼容」为主,非兼容的用 kind 标记单独适配。
 *   kind: 'openai'    —— POST {endpoint},Authorization: Bearer,SSE choices[].delta.content
 *         'anthropic' —— POST {endpoint},x-api-key + anthropic-version,SSE content_block_delta
 *         'gemini'    —— POST {endpoint}/models/{model}:streamGenerateContent?alt=sse&key=,SSE candidates[].content.parts[].text
 *
 * 免费额度相关的备注写在 note 里,界面上会显示,方便按需选用。
 */

export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    endpoint: 'https://api.deepseek.com/chat/completions',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-flash',
    keyHint: 'sk-...',
    note: 'deepseek-flash = DeepSeek-V4.1-Flash(1M 上下文,便宜);deepseek-v4-pro 更强但更贵。按量计费,无免费额度。',
    signup: 'https://platform.deepseek.com',
    /**
     * 思考模式**保持默认**(开启,effort=high)—— 不去干预它。
     *
     * 这里记录一段认识上的弯路,免得以后再绕:
     *   reasoning_content(思维链)是模型**给自己**看的草稿,是什么语言、
     *   多长、有没有格式指令,全都无所谓 —— 因为它**根本不显示给玩家**。
     *   我们要显示的是**正式输出里那段中文 thinking 字段**,它和动作一起到达。
     *
     * 所以「推理是英文的」根本不是问题,也就不需要:
     *   ✗ 把思考模式关掉(有过一次,那是拿手段当目的,还削弱了决策质量)
     *   ✗ 去限制 reasoning_effort(推理语言无所谓,没必要干预)
     *   ✗ 在显示层费劲识别并过滤英文推理
     *
     * 正确做法只有一条:**只渲染 JSON 里的 thinking 字段**(见 app.js 的
     *   takeTurn() 与场景层的思考气泡),思维链压根不进 UI。
     *
     * 这里特意**不设 requestExtra** —— 请求体里不多带任何非标准参数,
     * 对各家 OpenAI 兼容服务最安全。
     */
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    models: [
      'deepseek/deepseek-chat-v3.1:free',
      'deepseek/deepseek-r1:free',
      'qwen/qwen3-235b-a22b-thinking-2507',
      'z-ai/glm-4.6',
      'moonshotai/kimi-k2-thinking',
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemini-2.5-flash',
    ],
    defaultModel: 'deepseek/deepseek-chat-v3.1:free',
    keyHint: 'sk-or-...',
    note: '一个 key 通吃各家模型,带 :free 的有免费额度(20 RPM / 50 RPD;充 $10 后 1,000 RPD)。想体验强推理可以选带 thinking 的型号。',
    signup: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    models: [
      'openai/gpt-oss-120b',
      'moonshotai/kimi-k2-instruct-0905',
      'qwen/qwen3-32b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
    defaultModel: 'openai/gpt-oss-120b',
    keyHint: 'gsk_...',
    note: '有免费层,速度极快(适合一局几十次调用)。gpt-oss-120b 会给出推理过程。',
    signup: 'https://console.groq.com/keys',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    keyHint: 'AIza...',
    note: 'AI Studio 有免费层(有速率限制)。2.5 系列自带思考过程。请求会拼成 /models/{model}:streamGenerateContent。',
    signup: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-5-mini', 'gpt-5', 'o4-mini', 'gpt-4.1-mini'],
    defaultModel: 'gpt-5-mini',
    keyHint: 'sk-...',
    note: '按量计费。带推理的型号(o 系列 / gpt-5)会先想再答,思考文本更充分。',
    signup: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    kind: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
    defaultModel: 'claude-sonnet-4-5',
    keyHint: 'sk-ant-...',
    note: 'Messages API,鉴权用 x-api-key。Sonnet 4.5 在策略类博弈上表现很好。',
    signup: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    kind: 'openai',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    models: [
      'deepseek-ai/DeepSeek-V3.2-Exp',
      'Qwen/Qwen3-235B-A22B-Thinking-2507',
      'zai-org/GLM-4.6',
      'moonshotai/Kimi-K2-Thinking',
      'Qwen/Qwen2.5-7B-Instruct',
    ],
    defaultModel: 'deepseek-ai/DeepSeek-V3.2-Exp',
    keyHint: 'sk-...',
    note: '国内可直连,实名认证后有免费模型(额度固定)。想体验强推理可选 Qwen3-Thinking / GLM-4.6 / Kimi-K2-Thinking。',
    signup: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'ollama',
    name: '本地模型 (Ollama)',
    kind: 'openai',
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    models: ['qwen3:8b', 'qwen3:14b', 'qwen3:30b-a3b', 'deepseek-r1:8b', 'llama3.1:8b-instruct'],
    defaultModel: 'qwen3:8b',
    keyHint: '(本地不需要 Key)',
    note: '完全免费、离线可用,不需要 API Key。需要本机装了 Ollama 并 pull 过模型;qwen3 系列默认带思考。浏览器版要从网页访问 127.0.0.1,Ollama 需设置 OLLAMA_ORIGINS 允许跨域(见 README)。',
    signup: 'https://ollama.com/download',
    noKey: true,
    localOnly: true,
  },
  {
    id: 'lmstudio',
    name: '本地模型 (LM Studio)',
    kind: 'openai',
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    models: ['local-model'],
    defaultModel: 'local-model',
    keyHint: '(本地不需要 Key)',
    note: '完全免费、离线可用。在 LM Studio 里启动 Local Server 并开启 CORS 即可。',
    signup: 'https://lmstudio.ai',
    noKey: true,
    localOnly: true,
  },
  {
    id: 'custom',
    name: '自定义(OpenAI 兼容)',
    kind: 'openai',
    endpoint: '',
    models: [],
    defaultModel: '',
    keyHint: '按需填写',
    note: '任何 OpenAI 兼容服务:填 base_url 的 /chat/completions 完整地址即可。用云端 Worker 转发时,需要把该域名加到 Worker 的 EXTRA_ALLOWED_HOSTS。',
    signup: '',
  },
];

export const PROVIDER_MAP = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id) {
  return PROVIDER_MAP[id] || PROVIDER_MAP.deepseek;
}

/** 给界面用的精简列表(浅拷贝,避免调用方改到真源) */
export function providerList() {
  return PROVIDERS.map((p) => ({ ...p }));
}

/** 校验一个厂商 + key 是否可用(本地模型不需要 key) */
export function isUsable(providerId, apiKey) {
  const p = getProvider(providerId);
  if (!p.endpoint) return false;
  if (p.noKey) return true;
  return !!(apiKey && apiKey.trim());
}
