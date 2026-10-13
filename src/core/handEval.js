'use strict';
/**
 * 牌型评估器。
 *
 * evaluate(cards, { shortDeck }) -> score 数组,category 在 score[0],
 * 数组之间用字典序比较即可判大小(compare 已封装)。
 *
 * ⚠️ **evaluate 返回的类别号是「对外牌力顺序」,短牌与标准牌不同。**
 *    这一点很容易踩坑,所以写清楚:
 *
 *   标准 52 张:
 *     0 高牌 1 一对 2 两对 3 三条 4 顺子 5 同花 6 葫芦 7 四条 8 同花顺
 *
 *   短牌 36 张(三条 > 顺子、同花 > 葫芦,所以 3/4 与 5/6 分别对调):
 *     0 高牌 1 一对 2 两对 **3 顺子** **4 三条** **5 葫芦** **6 同花** 7 四条 8 同花顺
 *
 *   为什么要把顺序烘进分数里:`compare(a, b)` 是纯字典序比较、**没有选项参数**
 *   (引擎分池时到处在用它),所以短牌的相对大小只能靠 evaluate 事先重排。
 *   代价就是「类别号的含义随模式而变」—— 要取名字请用 describe() / categoryKey()
 *   (它们内部会反查),不要自己拿数字去索引名字表。
 *
 *   对应的常量:CAT 是标准编号,CAT_SHORT 是短牌编号。
 *
 * 规格来源:README「短牌(36 张):A-6-7-8-9 是最小顺子;三条 > 顺子、同花 > 葫芦」。
 */

import { rankOf, suitOf, cardText } from './cards.js';

const CATEGORY_NAME_STD = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
// 短牌对外类别名:顺序必须与 evaluate 重排后的编号一致
// (3=顺子 4=三条 5=葫芦 6=同花 —— 不是 3=三条!写错会误导后面接手的人)
const CATEGORY_NAME_SHORT = ['高牌', '一对', '两对', '顺子', '三条', '葫芦', '同花', '四条', '同花顺'];

const CAT = {
  HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4, FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8,
};

/**
 * 短牌模式下的「对外类别号」。
 * 用它去索引 CATEGORY_NAME_SHORT 才是对的 —— 别拿 CAT 去比短牌的 score[0]。
 */
const CAT_SHORT = {
  HIGH: 0, PAIR: 1, TWO_PAIR: 2, STRAIGHT: 3, TRIPS: 4, FULL_HOUSE: 5, FLUSH: 6, QUADS: 7, STRAIGHT_FLUSH: 8,
};

/**
 * 短牌(36 张)的牌力顺序与标准牌有两处不同:
 *   · 三条 > 顺子
 *   · 同花 > 葫芦
 *
 * 内部类别仍是标准序号(3=三条 4=顺子 5=同花 6=葫芦),对外要重排成
 * 「一对 < 两对 < 三条 < 顺子 < 葫芦 < 同花 < 四条 < 同花顺」,也就是
 * 把「三条 ↔ 顺子」和「同花 ↔ 葫芦」这两对分别交换。
 *
 * 表按「内部类别 → 对外类别」索引:
 *   内部 0高牌→0  1一对→1  2两对→2
 *   内部 3三条→4  4顺子→3        ← 三条要排在顺子后面
 *   内部 5同花→6  6葫芦→5        ← 同花要排在葫芦后面
 *   内部 7四条→7  8同花顺→8
 *
 * 之前这里只交换了「同花↔葫芦」,漏了「三条↔顺子」,
 * 导致短牌里三条仍然小于顺子(与项目规格相反)。
 */
const SHORT_REMAP = [0, 1, 2, 4, 3, 6, 5, 7, 8];
function remapCategory(score, shortDeck) {
  if (!shortDeck) return score;
  const out = score.slice();
  out[0] = SHORT_REMAP[out[0]];
  return out;
}

/** 从 rank 出现次数表里找顺子,返回顺子最大 rank 或 0 */
function straightHigh(rankSet, shortDeck = false) {
  let run = 0;
  for (let r = 14; r >= 2; r--) {
    if (rankSet.has(r)) {
      run++;
      if (run >= 5) return r + 4;
    } else run = 0;
  }
  if (rankSet.has(14)) {
    // A-2-3-4-5(52 张模式的轮子顺)
    if (!shortDeck && [2, 3, 4, 5].every((r) => rankSet.has(r))) return 5;
    // A-6-7-8-9(短牌模式的最小顺子)
    if (shortDeck && [6, 7, 8, 9].every((r) => rankSet.has(r))) return 9;
  }
  return 0;
}

/**
 * 评估一手牌(5~7 张),返回可比较的 score 数组,category 在 score[0]。
 *
 * ⚠️ 这里的「谁更大」是**按游戏内(对外)牌力顺序**判定的,
 * 而不是按真实世界的稀有度。多数变体两者一致,但短牌不是:
 *   · 真实稀有度:三条比顺子稀有 → 三条更大
 *   · 短牌规则:  三条 > 顺子   → 一致
 *   · 但短牌又要求 同花 > 葫芦,而葫芦比同花稀有 —— 这里就反了
 * 所以不能拿「真实稀有度」当通用顺序。
 *
 * 更关键的是:从 7 张里评估,等价于「遍历所有 5 张子集,取对外牌力最强的那个」。
 * 7 张里可能同时存在三条和顺子,而这两者在短牌里的相对大小与 5 张子集里
 * 一致 —— 所以直接挑子集,结果一定是自洽的。
 * (早期实现是「把 7 张当一手牌直接判」,那会得到一副三条+顺子的混合怪牌,
 *  与 best5 的结果对不上。)
 *
 * @param {number[]} cards 5~7 张
 * @param {{shortDeck?: boolean}} opts
 * @returns {number[]} score(已按对外类别号排好,可直接用 compare 比较)
 */
function evaluate(cards, opts = {}) {
  const shortDeck = !!opts.shortDeck;
  const n = cards.length;
  if (n < 5) throw new Error('至少需要 5 张牌才能评估,收到 ' + n);
  if (n === 5) return remapCategory(evaluateFive(cards, shortDeck), shortDeck);
  // 6~7 张:逐一比较所有 5 张子集,按对外牌力取最强
  let best = null;
  for (const combo of kSubsets(cards.map((_, i) => i), 5)) {
    const sc = remapCategory(evaluateFive(combo.map((i) => cards[i]), shortDeck), shortDeck);
    if (!best || compare(sc, best) > 0) best = sc;
  }
  return best;
}

/** 只处理 5 张牌,返回**内部(标准)类别号**的分数 */
function evaluateFive(cards, shortDeck) {
  const bySuit = [[], [], [], []];
  const byRank = new Map();
  for (const c of cards) {
    const r = rankOf(c), s = suitOf(c);
    bySuit[s].push(r);
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(c);
  }

  const rankSet = new Set(byRank.keys());
  const sHigh = straightHigh(rankSet, shortDeck);

  // 同花 / 同花顺:只看 >=5 张的那门花色
  let flushRanks = null;
  for (let s = 0; s < 4; s++) {
    if (bySuit[s].length >= 5) {
      flushRanks = bySuit[s].slice().sort((a, b) => b - a).slice(0, 5);
      const fSet = new Set(bySuit[s]);
      const fHigh = straightHigh(fSet, shortDeck);
      if (fHigh) return [CAT.STRAIGHT_FLUSH, fHigh];
      break;
    }
  }

  // 按 (张数, rank) 分组降序
  const groups = [...byRank.entries()]
    .map(([r, cs]) => ({ r, n: cs.length }))
    .sort((a, b) => (b.n - a.n) || (b.r - a.r));

  const quad = groups.find((g) => g.n === 4);
  const trips = groups.filter((g) => g.n === 3);
  const pairs = groups.filter((g) => g.n === 2);

  // 判断顺序必须按「真实牌力」来(谁更稀有谁更大):
  //   四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌
  // 标准牌与短牌都是这个强度顺序 —— 三条比顺子稀有,所以三条更大。
  // 短牌的「三条 > 顺子」是**对外类别号**的重排(见 SHORT_REMAP),
  // 不是判定顺序的改变。所以这里顺子在三条之前,是正确的。
  if (quad) {
    const kicker = Math.max(...groups.filter((g) => g.r !== quad.r).map((g) => g.r));
    return [CAT.QUADS, quad.r, kicker];
  }

  if (trips.length >= 2) return [CAT.FULL_HOUSE, trips[0].r, trips[1].r];
  if (trips.length === 1 && pairs.length >= 1) return [CAT.FULL_HOUSE, trips[0].r, pairs[0].r];

  if (flushRanks) return [CAT.FLUSH, ...flushRanks];

  if (sHigh) return [CAT.STRAIGHT, sHigh];

  if (trips.length === 1) {
    const kick = groups.filter((g) => g.r !== trips[0].r).map((g) => g.r).sort((a, b) => b - a).slice(0, 2);
    return [CAT.TRIPS, trips[0].r, ...kick];
  }

  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    const kicker = Math.max(...groups.filter((g) => g.r !== p1.r && g.r !== p2.r).map((g) => g.r));
    return [CAT.TWO_PAIR, p1.r, p2.r, kicker];
  }

  if (pairs.length === 1) {
    const kick = groups.filter((g) => g.r !== pairs[0].r).map((g) => g.r).sort((a, b) => b - a).slice(0, 3);
    return [CAT.PAIR, pairs[0].r, ...kick];
  }

  return [CAT.HIGH, ...[...byRank.keys()].sort((a, b) => b - a).slice(0, 5)];
}

function compare(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? -1, y = b[i] ?? -1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

const RANK_WORD = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rw = (r) => RANK_WORD[r] || String(r);

/**
 * 把 score 翻译成中文牌型名。
 *
 * 注意:evaluate 在短牌模式下返回的是「重映射后」的类别号(同花=6、葫芦=5),
 * 所以这里必须先按短牌规则反查回标准类别,再取名字。
 * 直接把重映射后的号丢进标准名字数组,会把葫芦说成同花、同花说成顺子。
 */
const SHORT_TO_STANDARD_CATEGORY = (() => {
  const back = new Array(9);
  SHORT_REMAP.forEach((shortCat, standardCat) => { back[shortCat] = standardCat; });
  return back;
})();

function describe(score, opts = {}) {
  const cat = opts.shortDeck ? SHORT_TO_STANDARD_CATEGORY[score[0]] : score[0];
  switch (cat) {
    case CAT.STRAIGHT_FLUSH: return score[1] === 14 ? '皇家同花顺' : `同花顺(${rw(score[1])} 高)`;
    case CAT.QUADS: return `四条 ${rw(score[1])}`;
    case CAT.FULL_HOUSE: return `葫芦 ${rw(score[1])} 带 ${rw(score[2])}`;
    case CAT.FLUSH: return `同花(${rw(score[1])} 高)`;
    case CAT.STRAIGHT: return `顺子(${rw(score[1])} 高)`;
    case CAT.TRIPS: return `三条 ${rw(score[1])}`;
    case CAT.TWO_PAIR: return `两对 ${rw(score[1])} 与 ${rw(score[2])}`;
    case CAT.PAIR: return `一对 ${rw(score[1])}`;
    default: return `高牌 ${rw(score[1])}`;
  }
}

/** 便于 AI prompt 使用的英文牌型名 */
function categoryKey(score, opts = {}) {
  const names = ['high_card', 'one_pair', 'two_pair', 'three_of_a_kind', 'straight', 'flush', 'full_house', 'four_of_a_kind', 'straight_flush'];
  // 短牌用同一张表,但**索引是短牌的对外编号**:
  //   3=straight 4=three_of_a_kind 5=full_house 6=flush
  const short = ['high_card', 'one_pair', 'two_pair', 'straight', 'three_of_a_kind', 'full_house', 'flush', 'four_of_a_kind', 'straight_flush'];
  // ⚠️ 不能先把 score[0] 反查回标准类别、再索引短牌表 —— 那是转了两次。
  //    实测这个 bug 会把短牌的「同花」报成 full_house、「葫芦」报成 flush
  //    (describe 用反查 + 标准表,所以它是对的;categoryKey 当初照抄了反查却没换成标准表)。
  return (opts.shortDeck ? short : names)[score[0]];
}

/**
 * 从 7 张(或 5/6 张)里挑出最强的 5 张,返回 { score, cards }。
 *
 * 直接复用 evaluate 的结果:它内部就是「遍历 5 张子集取对外最强」,
 * 所以这里只要把那一组牌也留下来就行。
 */
function best5(cards, opts = {}) {
  const n = cards.length;
  if (n <= 5) {
    return { score: evaluate(cards, opts), cards: cards.slice() };
  }
  let best = null, bestCards = null;
  for (const combo of kSubsets(cards.map((_, i) => i), 5)) {
    const hand = combo.map((i) => cards[i]);
    const sc = evaluate(hand, opts);
    if (!best || compare(sc, best) > 0) { best = sc; bestCards = hand; }
  }
  return { score: best, cards: bestCards };
}

function kSubsets(arr, k) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1); cur.pop(); }
  })(0);
  return out;
}

export { evaluate, compare, describe, categoryKey, best5, CAT, CAT_SHORT, CATEGORY_NAME_STD, CATEGORY_NAME_SHORT, straightHigh, cardText };
