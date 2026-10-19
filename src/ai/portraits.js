/**
 * 「模型 → 角色立绘」映射。
 *
 * 规则来源(用户定的):
 *   · 立绘由**该座位用的模型**决定,而不是由性格决定;
 *   · 同一个模型被多个座位用到时,用不同 accent 色调 + 保留性格名来区分;
 *   · 认不出来的模型先用通用占位立绘。
 *
 * crosspet 那批 5 套(claude / deepseek / gemini / glm / gpt)+ 手工加的 qwen / grok / kimi / mimo,
 * 而应用支持 10 家厂商、每家又有任意多个模型,所以这里必须做**两层猜测**:
 *   1. 先看模型名里的关键词(最准:同一个厂商下可能挂着别家的模型,比如
 *      OpenRouter / 硅基流动 / Ollama 上什么都可能有);
 *   2. 再看厂商 id(型号名没线索时,厂商就是最好的兜底)。
 * 两层都没中 → generic(通用占位)。
 *
 * 这个文件是纯逻辑、不碰 DOM,所以能直接在 Node 里测。
 */

/** 有立绘的角色 id(与 assets/portraits/ 下的目录名一致) */
export const PORTRAIT_CHARS = [
  'claude', 'deepseek', 'gemini', 'glm', 'gpt',
  // 手工加进来的:每个只有一张 idle,缺的状态自动复用(见 sceneCore/portraits2d.js)
  'qwen', 'grok', 'kimi', 'mimo',
];

/** 没有对应立绘时用的占位角色 */
export const GENERIC_CHAR = 'generic';

/**
 * 模型名关键词 → 角色。
 *
 * 分两类匹配,因为短名字很容易误伤:
 *   · subs:整串包含即算(这些词足够独特,不会出现在别的模型名里);
 *   · toks:按分隔符切成词之后**整词**相等才算(
 *       例如 'o1'/'o3' 不能拿整串包含去匹配,否则 'pro1'、'v1o1' 都会被命中)。
 *
 * ⚠️ **groq ≠ grok**。`groq` 是跑开源模型的推理平台(Groq),
 *    `grok` 才是 xAI 的模型。两者只差一个字母,但绝不能混 ——
 *    所以这里只按**模型名**里的 'grok'/'xai' 匹配,
 *    并且下面 PROVIDER_RULES 里**故意不写 groq**。
 */
const MODEL_RULES = [
  { char: 'claude', subs: ['claude', 'anthropic'], toks: ['opus', 'sonnet', 'haiku'] },
  { char: 'deepseek', subs: ['deepseek'], toks: [] },
  { char: 'gemini', subs: ['gemini', 'palm', 'learnlm'], toks: ['bison'] },
  { char: 'glm', subs: ['glm', 'chatglm', 'zhipu', 'cogvlm'], toks: [] },
  { char: 'gpt', subs: ['gpt', 'chatgpt', 'codex', 'davinci'], toks: ['o1', 'o3', 'o4'] },
  { char: 'qwen', subs: ['qwen', 'tongyi', 'qianwen'], toks: [] },
  { char: 'grok', subs: ['grok', 'xai'], toks: [] },
  // Kimi(月之暗面):型号有 kimi-k2 / moonshot-v1-* 两种写法
  { char: 'kimi', subs: ['kimi', 'moonshot'], toks: [] },
  // 小米 MiMo:'mimo' 这串很短,按整词匹配,免得误伤带 mimo 字母的别家型号
  { char: 'mimo', subs: ['xiaomi'], toks: ['mimo'] },
];

/** 厂商 id → 角色(模型名没给出线索时的兜底)。
 *  注意这里**没有** groq:它只是个推理平台,上面挂什么模型都有可能,
 *  按平台给立绘会张冠李戴。 */
const PROVIDER_RULES = {
  anthropic: 'claude',
  openai: 'gpt',
  gemini: 'gemini',
  deepseek: 'deepseek',
};

const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * 判断某个座位该用哪套立绘。
 *
 * @param {string} providerId 厂商 id(deepseek / openai / anthropic / groq / …)
 * @param {string} model      模型名(可为空,例如本地模型)
 * @returns {string} 角色 id,认不出来时返回 'generic'
 */
export function characterForModel(providerId, model) {
  const lower = String(model || '').toLowerCase();
  const toks = tokenize(lower);

  for (const rule of MODEL_RULES) {
    if (rule.subs.some((s) => lower.includes(s))) return rule.char;
    if (rule.toks.some((t) => toks.includes(t))) return rule.char;
  }
  return PROVIDER_RULES[String(providerId || '').toLowerCase()] || GENERIC_CHAR;
}

/**
 * 给全桌座位分配 accent 色调。
 *
 * 目的(用户的要求):同一个模型被多个座位用到时,光看立绘分不清谁是谁 ——
 * 所以同款的座位要拿到**明显不同**的颜色,并且各自的性格名照旧显示。
 *
 * 规则:
 *   · 某套立绘只被一个座位用到 → 用它自己的 accent(尊重原设定);
 *   · 被 N>1 个座位用到 → 这几个座位按顺序取一组高区分度的颜色,
 *     第一个仍是它自己的 accent,后面的从调色板取。
 *
 * @param {Array<{seat:number, char:string, baseAccent?:string}>} entries
 * @returns {Record<number, string>} seat -> css 颜色
 */
const DISTINCT = ['#e9c46a', '#6ab0e9', '#e2574c', '#7fd18a', '#c98fe0', '#f0a35e'];
const GENERIC_ACCENT = '#8b98ab';

export function assignAccents(entries) {
  const byChar = new Map();
  for (const e of entries) {
    if (!byChar.has(e.char)) byChar.set(e.char, []);
    byChar.get(e.char).push(e);
  }
  const out = {};
  for (const [char, list] of byChar) {
    const sorted = [...list].sort((a, b) => a.seat - b.seat);
    if (sorted.length === 1) {
      out[sorted[0].seat] = sorted[0].baseAccent || (char === GENERIC_CHAR ? GENERIC_ACCENT : DISTINCT[0]);
      continue;
    }
    // 同款多个座位:第一个用原色,其余的挑一个和已用过的都不相同的颜色
    const used = new Set();
    sorted.forEach((e, i) => {
      if (i === 0) {
        const base = e.baseAccent || DISTINCT[0];
        used.add(base.toLowerCase());
        out[e.seat] = base;
        return;
      }
      const pick = DISTINCT.find((c) => !used.has(c.toLowerCase()))
        || DISTINCT[i % DISTINCT.length];
      used.add(pick.toLowerCase());
      out[e.seat] = pick;
    });
  }
  return out;
}

/** 给界面/AI 提示用的中文名(也是座位显示名的基础) */
export const CHAR_LABEL = {
  claude: 'Claude',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  glm: 'GLM',
  gpt: 'GPT',
  qwen: 'Qwen',
  grok: 'Grok',
  kimi: 'Kimi',
  mimo: 'MiMo',
  generic: '未知模型',
};

/** 厂商 id 的大写展示名(模型名也没线索时用) */
const PROVIDER_LABEL = {
  deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini',
  openrouter: 'OpenRouter', groq: 'Groq', siliconflow: 'SiliconFlow',
  ollama: 'Ollama', lmstudio: 'LM Studio', local: '本地策略', custom: '自定义',
};

/**
 * 座位显示名的**基础名** —— 由模型决定,不由性格决定。
 *
 * 认得出是哪家模型就用那家的名字(和立绘一致,一眼能对上);
 * 认不出就尽量从模型名里抠一个短词('llama-3.1-70b' → 'Llama');
 * 连模型名都没有才退回厂商名。
 */
export function displayNameForModel(providerId, model) {
  const char = characterForModel(providerId, model);
  if (char !== GENERIC_CHAR) return CHAR_LABEL[char] || char;

  const m = String(model || '').trim();
  if (m) {
    // 取第一段并去掉版本尾巴:'llama-3.1-70b-instruct' → 'Llama'
    const head = m.split(/[-_/:. ]+/).filter(Boolean)[0] || m;
    if (/^[a-z]/i.test(head)) {
      // 全大写的型号(qwen2.5 → qwen2.5)保留原样更好认,其余首字母大写
      return /[A-Z]/.test(head.slice(1)) ? head : head.charAt(0).toUpperCase() + head.slice(1);
    }
    return m;
  }
  const pid = String(providerId || '').toLowerCase();
  return PROVIDER_LABEL[pid] || pid || '牌手';
}

/**
 * 按「基础名」给全桌分配**互不相同**的显示名。
 *
 * 用户的要求:名字跟着模型走;同一个模型被多个座位用到时加序号区分。
 * 这里按基础名分组 —— 即**看起来会一样的人才会被编号**,这样:
 *   · 两个座位都跑 Claude        → 「Claude 1」「Claude 2」
 *   · 一个跑 deepseek-flash、另一个跑 deepseek-v4-pro
 *                              → 立绘和基础名都是 DeepSeek,同样编号
 *   · 只有一个座位用 GLM          → 就叫「GLM」,不加多余的序号
 *
 * @param {Array<{seat:number, name:string}>} entries
 * @returns {Record<number,string>} seat -> 最终显示名
 */
export function assignDisplayNames(entries) {
  const byName = new Map();
  for (const e of entries) {
    const base = String(e.name || '牌手').trim() || '牌手';
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(e);
  }
  const out = {};
  for (const [base, list] of byName) {
    // 按座位号排序,保证编号稳定(与建座位的顺序一致,不会每次刷新乱跳)
    const sorted = [...list].sort((a, b) => a.seat - b.seat);
    if (sorted.length === 1) { out[sorted[0].seat] = base; continue; }
    sorted.forEach((e, i) => { out[e.seat] = `${base} ${i + 1}`; });
  }
  return out;
}
