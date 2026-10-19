/**
 * 「狼人杀」的**代码级发言过滤** —— 说出口的话不许自带答案。
 *
 * ────────────────────────────────────────────────────────────────
 * ⚠️ 先说这条规则**为什么不照抄卧底**(这是本游戏最容易抄错的一处)
 *
 * 卧底的 filter 会把「我是平民 / 我是卧底」一律拦掉 —— 因为那个游戏的灵魂就是
 * 「连你自己都不知道自己是不是卧底」,报阵营等于开了天眼。
 *
 * **狼人杀正好相反**:「我是预言家」是**声明**(claim),不是泄漏。狼人悍跳预言家
 * 是这个游戏最重要的一种打法(研究文档「狼人策略菜单」第 2 条),真预言家跳身份
 * 也是常规操作;好人诈身份一样合法。所以下面**不许**出现「看到『我是预言家』就拦」
 * 这条规则 —— 那会把整个游戏最能看的部分(对跳、悍跳、真假预言家)全部按死。
 *
 * 真正要拦的是**只有那个角色才说得出口的事实**:
 *
 *   1. 「我们狼队 / 我的队友是 7 号」—— 真狼才会这么说(而且直接点名了同伴);
 *   2. 「昨晚我们刀了 5 号 / 我们的刀口是…」—— 狼队的夜间私有信息;
 *   3. 提示词 / JSON 字段名残留、跳出角色(「作为一个 AI」「根据规则第 X 条」)——
 *      模型掉出牌桌的典型形态(研究文档「坑 13」);
 *   4. 用座位号自指(「我是 3 号」)—— 真人在桌上不会这么说话。
 *
 * 换句话说:**允许骗人,不允许把只有自己知道的事实当公共事实讲**
 * (研究文档「撒谎的边界」:你可以骗人,但不能编造这个世界发生过什么)。
 *
 * ⚠️ 已知缺口(如实写在这里,不假装没有):
 *    · 「引用了一条不存在的发言」这类**幻觉**不在这里拦 —— 它需要把引号里的内容
 *      拿回账本里查(研究文档「引用校验」),第一版没做,靠提示词的【引用纪律】约束;
 *    · 「狼人隐瞒身份后提到同伴座位号」拦不住 —— 只要不写成「我队友」,一句
 *      「7 号说得对」在语义上和好人拍马屁毫无区别,代码层无从判断。
 *
 * 命中之后的处理策略在 agent.js(先带违规说明重试一次 → 仍命中用确定性中性句),
 * 与卧底同一套;这里只负责判「这句话能不能公开说」,不判句子好不好。
 */

/** 狼队自曝:只要和「我」连在一起就判泄漏 */
const FACTION_RE = [
  /(?:我|俺|咱|自己)\s*(?:就|真|其实|确实|当然)?\s*是\s*(?:一个|一名|个|只)?\s*(?:狼人|狼|狼队|大灰狼)/,
  /(?:我们|咱们|俺们)\s*(?:这边|那边|狼队|狼窝|阵营|这一队)/,
  /我的\s*(?:狼)?(?:队友|同伴|同伙|狼同伴|狼队友)/,
  /(?:我|俺)\s*(?:和|跟)\s*\d+\s*号\s*(?:都|一起)?\s*是\s*(?:狼|狼人)/,
];

/** 夜间私有信息:真实刀口(狼队自己说的那种「我们刀了谁」) */
const NIGHT_RE = [
  /(?:我们|咱们|我)\s*(?:昨晚|今夜|今晚|夜里)?\s*刀(?:了|掉|死|的|口)/,
  /(?:我们|咱们)的?\s*(?:刀口|刀法|第一刀)/,
  /(?:我们|咱们)\s*(?:昨晚|今晚)\s*(?:杀|刀)\s*(?:的|了)/,
];

/** 跳出角色 / JSON 残留 */
const CODE_RE = /\b(?:thinking|say|vote|reason|json|markdown|prompt|system|action|target|werewolf|seer|witch|villager)\b/i;
const META_RE = [
  /作为一个?\s*(?:AI|人工智能|语言模型|助手)/,
  /(?:根据|按照)\s*(?:规则|提示词|设定)\s*第?\s*\d*\s*条?/,
  /我的\s*(?:提示词|系统设定|指令)/,
];

/** 座位号自指:只拦「我是/我坐 X 号」,「X 号说得不对」是正常点名 */
const SELF_SEAT_RE = [
  /我\s*(?:就|是|坐|在)\s*(?:第\s*)?\d+\s*号/,
  /\d+\s*号\s*(?:就)?是我/,
];

/**
 * 中性兜底发言(**成对的 2 条气泡**)。
 *
 * 三个要求:
 *   ① 不含任何具体信息(不点名、不表态投谁、不提身份)—— 换成任何局面都成立;
 *   ② 确定性(由座位 + 天数决定用哪一对),同一局面重跑永远同一句 ——
 *      研究文档「坑 8:随机兜底毁一致性」;
 *   ③ 读起来像真人敷衍的一句,而不是报错文案。
 */
export const NEUTRAL_SPEECH = [
  ['这一轮我先听大家的。', '我暂时没有更多要补充的,等票型出来再说。'],
  ['我这边还没有想清楚。', '先过,后面谁跳身份我再表态。'],
  ['信息太少了,我不急着下结论。', '这一轮我多看少说。'],
  ['我先记一下大家的说法。', '等我理清楚再给判断。'],
];

/**
 * 确定性地挑一对中性发言。
 * 为什么用 (seat, day) 的哈希而不是 Math.random:同一局重放必须得到同一句话,
 * 否则被拦两次的两段发言会自相矛盾,观众立刻出戏。
 */
export function neutralSpeech(seat = 0, day = 1) {
  const i = Math.abs((Number(seat) || 0) * 7 + (Number(day) || 0) * 13) % NEUTRAL_SPEECH.length;
  return NEUTRAL_SPEECH[i].slice();
}

/** 一条气泡的清洗:压空白、去引号、超长截到最后一个标点(与卧底 cleanSay 同一套) */
export function cleanBubble(raw, maxLen = 60) {
  let s = String(raw ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, '');
  s = s.replace(/\s{2,}/g, ' ');
  if (s.length > maxLen) {
    const head = s.slice(0, maxLen);
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('，'),
      head.lastIndexOf('、'), head.lastIndexOf('；'), head.lastIndexOf(' '));
    s = cut > maxLen * 0.5 ? head.slice(0, cut) : head;
  }
  return s.trim();
}

/**
 * 判一句公开发言有没有越界。返回 null(干净)或一条命中记录。
 *
 * @param {string} text 已经 cleanBubble 过的那句话
 * @returns {null|{kind:string, hit:string, why:string}}
 */
export function checkSayLeak(text) {
  const s = String(text ?? '');
  if (!s) return null;

  for (const re of FACTION_RE) {
    const m = re.exec(s);
    if (m) return { kind: 'faction', hit: m[0], why: `说出了自己是狼/提了自己的狼队友(${m[0]})` };
  }
  for (const re of NIGHT_RE) {
    const m = re.exec(s);
    if (m) return { kind: 'night', hit: m[0], why: `说出了夜里的真实刀口(${m[0]})` };
  }
  for (const re of META_RE) {
    const m = re.exec(s);
    if (m) return { kind: 'meta', hit: m[0], why: `跳出了角色(${m[0]})` };
  }
  for (const re of SELF_SEAT_RE) {
    const m = re.exec(s);
    if (m) return { kind: 'selfSeat', hit: m[0], why: `用座位号指自己(${m[0]})` };
  }
  const code = CODE_RE.exec(s);
  if (code) return { kind: 'code', hit: code[0], why: `出现了提示词/JSON 字段名(${code[0]})` };
  return null;
}

/**
 * 投票理由的过滤:规则与发言完全一样(也是公开可见的一句话)。
 * 单独一个名字只是为了调用处读起来清楚 —— 实现**必须**共用 checkSayLeak,
 * 否则发言与理由两套规则迟早漂移(这个仓库「两条路径各写一份」栽过两次)。
 */
export function checkReasonLeak(reason) {
  return checkSayLeak(reason);
}

/** 整段发言(多条气泡)一起判:任何一条命中就算命中 */
export function checkSpeechLeak(bubbles) {
  for (const b of (Array.isArray(bubbles) ? bubbles : [bubbles])) {
    const leak = checkSayLeak(b);
    if (leak) return { ...leak, bubble: String(b) };
  }
  return null;
}

/** 被拦掉之后给模型的修复要求(重试那一次拼进 user 消息) */
export function repairHint(leak) {
  if (!leak) return '';
  const map = {
    faction: '你说出了自己是狼、或者点了自己的狼队友 —— 这是自曝,不是声明。'
      + '你要么彻底不提「我们/队友」这类说法,要么把自己当成好人来发言。'
      + '(注意:跳预言家、跳女巫都是允许的**声明**,只有「我是狼」「我队友」这类才是犯规。)',
    night: '你说出了夜里的真实刀口。夜间信息只有狼队知道,公开说出来等于把牌摊开。'
      + '如果你要解释某个人的死,只能说「他被刀了」这种**已经公布过**的事。',
    meta: '你跳出了角色。你在牌桌上,不是裁判、不是解说、不是 AI 助手。删掉这类话。',
    selfSeat: '你用座位号指了自己。请用「我」,不要报座位号。',
    code: '你的话里混进了 JSON 字段名 / 英文标识。请只输出像真人在桌边说的话。',
  };
  return map[leak.kind] || '这句话不能公开说,请重写。';
}
