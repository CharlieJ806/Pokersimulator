/**
 * 「谁是卧底」的**代码级发言过滤** —— 说出口的话不许自带答案。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么必须有这一层(而不是只写在提示词里)
 *
 * 研究文档反复强调同一件事:提示词是**请求**,过滤器才是**保证**。
 * 这个仓库在扑克那边已经有一套同类东西(agent.js 的 detectSayLeak:不能说出
 * 自己的底牌),而卧底的利害关系更直接 —— 一句话命中下面任意一条,这一局就结束了:
 *
 *   1. 说出**自己的词**(最硬的规则:卧底词/平民词一露面,全场立刻知道该投谁);
 *   2. 说出**阵营**("我是卧底""我是平民""我们平民这边")——
 *      「不知道自己是不是卧底」是这个游戏的灵魂,报阵营等于开了天眼;
 *   3. 说**元信息**("这个词三个字""这是个名词""谐音……")——
 *      现实里没人这么说话,一出口就会被当成卧底;
 *   4. 用**座位号自指**("我是 3 号")—— 真人在桌上不会这么说话;
 *   5. 吐出 **JSON 字段名 / 提示词残留**("self_read""vote""thinking")——
 *      模型跳出角色的典型形态。
 *
 * 这一层只判「这句话能不能公开说」,**不判**句子好不好(那是 agent 的事)。
 * 所以它是纯函数、可以单独测:tools/undercovertest.mjs 里每一条规则各有一例。
 *
 * ⚠️ 命中之后**不是**丢掉一句就完了(扑克那边 say 是可选的,说漏嘴丢掉就行;
 *    卧底这里描述是**游戏必需品**,少一句就等于少一个人的发言)。处理策略在
 *    agent.js 的 describe():先带着「你违反了什么」重试一次,仍不行 → 用
 *    下面 NEUTRAL_SAY 里的**确定性中性句**兜底(标注 quality:'low')。
 *    确定性很重要:随机挑一句兜底会让同一局前后矛盾(研究文档「坑 8」)。
 */

/** 阵营词:只要和「我」连在一起出现就判泄漏(别人是卧底/平民不在这条里) */
const FACTION_RE = [
  /(?:我|俺|咱|自己)\s*(?:就|其实|应该|大概|可能|肯定|绝对)?\s*(?:是|属于|算)\s*(?:一个|一名|个)?\s*(?:卧底|平民|白板|坏人|好人|间谍)/,
  /(?:我们|咱们|俺们)\s*(?:这边|那边|阵营|这队|那队)/,
  /我的\s*(?:阵营|身份|角色)/,
  /(?:卧底|平民)\s*(?:阵营|这边|那边)/,
];

/**
 * 元信息:谈论「词」本身,而不是它指的东西。
 * ⚠️ 只收**明确的**元信息说法,不要一见到「词」字就拦 —— 真人会说
 *    「不好形容」「一句话说不清」,那些是正常发言。
 */
const META_RE = [
  /这个词|这词|这俩字|这两个字|这几个字|两个字|三个字|几个字/,
  /拼音|谐音|同音|首字母|字面意思|拆开|偏旁|英文|字母/,
  /(?:名词|动词|形容词|量词|成语|专有名词|一类词)/,
  /提示词|标签|题目|题库|出题|答案|关键词/,
];

/** 座位号自指:只拦「我是/我坐 X 号」,「X 号说得不对」是正常点名 */
const SELF_SEAT_RE = [
  /我\s*(?:就|是|坐|在)\s*(?:第\s*)?\d+\s*号/,
  /\d+\s*号\s*(?:就)?是我/,
];

/**
 * 白板自曝:白板手里没有词,但它**不能说出来**。
 *
 * 为什么这条和「报阵营」一样重:白板属于平民阵营,而场上没人知道自己属于哪一边。
 * 一个玩家公开说「我没拿到词」,等于告诉全场「我不是普通平民、也不是卧底」——
 * 平民立刻知道该留谁,卧底立刻知道谁可以拿来当挡箭牌。这条规则只在
 * 「这句话的作者本来是白板」时才查(blank:true),否则「我没听清这个词」
 * 这类正常发言会被误杀(真人真的会这么说)。
 */
const NO_WORD_RE = [
  /我\s*(?:这次|这一局|这轮|本局)?\s*(?:没有|没|未)\s*(?:拿到|有|抽到|分到)?\s*(?:词|题目|说法)/,
  /我(?:的)?\s*词\s*(?:是)?\s*(?:空|空着|空的|没有)/,
  /我是\s*(?:白板|空白)/,
  /(?:白板|空白)\s*(?:阵营|这边|那边)/,
];

/** 模型跳出角色 / JSON 残留(英文现场与字段名) */
const META_CODE_RE = /\b(?:self_read|thinking|vote|reason|say|json|markdown|prompt|system)\b/i;

/**
 * 中性兜底句。
 *
 * 三个要求:① 不含任何具体属性(换成任何词都说得通);② 不重复(轮次/座位
 * 决定用哪一句,同一局面永远同一句);③ 读起来像真人敷衍的一句,不像报错。
 */
export const NEUTRAL_SAY = [
  '挺常见的东西,具体什么样我一时说不上来。',
  '跟前面几位说的差不多吧,我没什么补充。',
  '这个我说不太准,但肯定不是什么冷门玩意儿。',
  '大家应该都接触过,我这轮先说得含糊点。',
];

/**
 * 确定性地挑一句中性描述。
 *
 * 为什么用 (seat, round) 做哈希而不是 Math.random:同一局重跑、或者模型
 * 连续失败时,兜底句必须**固定** —— 否则被拦了两次的两句话自相矛盾,
 * 观众立刻出戏(研究文档「坑 8:随机兜底毁一致性」)。
 * @param {number} seat
 * @param {number} round
 */
export function neutralSay(seat = 0, round = 1) {
  const i = Math.abs((Number(seat) || 0) * 7 + (Number(round) || 0) * 13) % NEUTRAL_SAY.length;
  return NEUTRAL_SAY[i];
}

/** 把字符串里的空白/引号压干净(过滤器与显示都用同一份清洗) */
export function cleanSay(raw, maxLen = 30) {
  let s = String(raw ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, '');
  s = s.replace(/\s{2,}/g, ' ');
  // 超过上限就截到最后一个标点,别把词切一半(扑克那边 cleanSay 同一套思路)
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
 * @param {string} say 已经 cleanSay 过的那句话
 * @param {{word?:string, blank?:boolean}} opts word = **这句话的作者自己的词**
 *   ⚠️ 只传作者自己的词:平民不能说出平民词,卧底不能说出卧底词 ——
 *   两边的规则完全一样(谁说出自己的词都是自曝),所以这里不需要区分阵营,
 *   也就不需要知道阵营(这一点让过滤器可以在不知道身份的模块里工作)。
 *   blank = 作者是**白板**(没有词):它不许公开说「我没有词」,理由见 NO_WORD_RE。
 * @returns {null|{kind:string, hit:string, why:string}}
 */
export function checkSayLeak(say, { word = '', blank = false } = {}) {
  const s = String(say ?? '');
  if (!s) return null;

  // ① 自己的词:整词出现即命中。
  //    只判整词,不按单字判 —— 「牛奶」拦「牛」会把「牛油果」这类正常描述全误杀,
  //    而模型真正的自曝形态是直接说出那个词(测试里覆盖的就是这个)。
  //    ⚠️ 白板的 word 是空串:空串是 falsy,这里不会误命中(否则每句话都会被拦)。
  if (word && s.includes(word)) {
    return { kind: 'ownWord', hit: word, why: `说出了自己的词「${word}」` };
  }
  for (const re of FACTION_RE) {
    const m = re.exec(s);
    if (m) return { kind: 'faction', hit: m[0], why: `提到了自己的阵营/身份(${m[0]})` };
  }
  if (blank) {
    for (const re of NO_WORD_RE) {
      const m = re.exec(s);
      if (m) return { kind: 'noWord', hit: m[0], why: `把「自己没有词」这件事说出来了(${m[0]})` };
    }
  }
  for (const re of META_RE) {
    const m = re.exec(s);
    if (m) return { kind: 'meta', hit: m[0], why: `谈到了「词」本身的元信息(${m[0]})` };
  }
  for (const re of SELF_SEAT_RE) {
    const m = re.exec(s);
    if (m) return { kind: 'selfSeat', hit: m[0], why: `用座位号指自己(${m[0]})` };
  }
  const code = META_CODE_RE.exec(s);
  if (code) return { kind: 'code', hit: code[0], why: `出现了提示词/JSON 字段名(${code[0]})` };

  return null;
}

/**
 * 投票理由的过滤:规则与描述完全一样(也是公开可见的一句话)。
 * 单独一个名字只是为了调用处读起来清楚 —— 实现**必须**共用 checkSayLeak,
 * 否则描述与理由两套规则迟早漂移(这个仓库「两条路径各写一份」栽过两次)。
 */
export function checkReasonLeak(reason, opts) {
  return checkSayLeak(reason, opts);
}

/** 被拦掉之后给模型的修复要求(重试那一次拼进 user 消息) */
export function repairHint(leak, word) {
  if (!leak) return '';
  const map = {
    ownWord: `你直接说出了自己拿到的词「${word}」—— 这是这个游戏最严重的犯规。换一个角度形容它,不要出现这个词本身,也不要出现它的同音字。`,
    faction: '你说出了自己的阵营/身份。你**并不知道**自己是哪一边,也不许猜一个说出来。删掉这类话。',
    meta: '你谈论了「这个词」本身(几个字/词性/谐音之类)。现实里没人这样说,请改成描述它指的那个**东西**。',
    selfSeat: '你用座位号指了自己。请用「我」,不要报座位号。',
    code: '你的话里混进了 JSON 字段名/提示词。请只输出一句像真人在桌边说的话。',
    noWord: '你把「自己手里没有词」这件事说出去了 —— 这是最硬的自曝,比报阵营还糟。请改成顺着别人描述的方向,编一个说法。',
  };
  return map[leak.kind] || '这句话不能公开说,请重写。';
}
