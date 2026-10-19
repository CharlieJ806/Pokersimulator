/**
 * 牌与牌堆 —— 纯逻辑,无依赖,渲染进程与测试工具共用。
 *
 * 牌用一个 0..51 的整数表示:rank = (id >> 2) + 2,suit = id & 3。
 * rank: 2..14 (14 = A);suit: 0=♠ 1=♥ 2=♦ 3=♣
 */

export const SUITS = ['s', 'h', 'd', 'c'];
export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const RANK_LABEL = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export const rankOf = (c) => (c >> 2) + 2;
export const suitOf = (c) => c & 3;
export const cardId = (rank, suit) => ((rank - 2) << 2) | suit;
export const cardText = (c) => RANK_LABEL[rankOf(c)] + SUIT_SYMBOL[SUITS[suitOf(c)]];
export const isRed = (c) => suitOf(c) === 1 || suitOf(c) === 2;

/** 短牌模式去掉 2~5,剩 36 张 */
export function buildDeck({ shortDeck = false } = {}) {
  const minRank = shortDeck ? 6 : 2;
  const cards = [];
  for (let r = minRank; r <= 14; r++) for (let s = 0; s < 4; s++) cards.push(cardId(r, s));
  return cards;
}

/**
 * Fisher-Yates 洗牌(不改动入参)。
 *
 * 这里对 rand 的返回值做了夹取:契约要求 [0,1),但万一传进来的 rand 返回 1
 * (或负数),`Math.floor(rand*(i+1))` 会算出 i+1 这种越界下标,
 * 读到 undefined 并把一张牌静默丢掉。夹一次成本可以忽略,但能避免这种事。
 */
export function shuffle(cards, rand = cryptoRandom) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    let r = Number(rand());
    if (!Number.isFinite(r)) r = 0;
    if (r < 0) r = 0;
    if (r >= 1) r = 1 - Number.EPSILON;
    const j = Math.floor(r * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 纯随机源:优先 crypto,退化到 Math.random */
export function cryptoRandom() {
  try {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const u = new Uint32Array(1);
      globalThis.crypto.getRandomValues(u);
      return u[0] / 4294967296;
    }
  } catch { /* ignore */ }
  return Math.random();
}
