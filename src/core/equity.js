'use strict';
/**
 * 摊牌胜率(equity)——「**如果此刻全部亮牌**,每个人赢下这一手的概率」。
 *
 * 这是给**荷官**看的数据(荷官模式下的手牌一览里,每个人名字旁边那个百分比)。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么自己写、不引第三方库(pokersolver / phe / poker-evaluator):
 *   · 仓库里已经有**自己的牌力评估器** src/core/handEval.js,而且它是被审计过的
 *     (tools/audit_eval.mjs 199 项断言 + tools/audit_eval_brute.mjs 暴力对照);
 *   · 它还处理了**短牌**(36 张、三条 > 顺子、同花 > 葫芦 —— CAT_SHORT / SHORT_REMAP),
 *     第三方库基本不管短牌,引进来还得自己适配;
 *   · 引库 = 多一个依赖 + 多一套规则口径。两套规则一旦不一致,
 *     「胜率说的赢家」和「引擎结算的赢家」就会打架,这种 bug 极难查。
 *   所以这里只做「发牌 + 判大小」的模拟,判大小一律交给 handEval 的 evaluate/compare。
 *
 * ────────────────────────────────────────────────────────────
 * 算法:
 *   1. 把**已知的牌**全部从牌堆里去掉:公共牌 + 所有已知底牌 + 烧牌 + 已弃牌者的底牌;
 *   2. 从剩下的牌里补完公共牌(以及个别未知底牌),按当前模式构造牌堆(52 / 36 张);
 *   3. 用 evaluate + compare 判出最大的一方;**同分的人均分**这份胜率(N 人同分每人 1/N);
 *   4. 统计每个人在样本里的份额。
 *
 * 两个取舍(都是实测出来的,见 tools/equitytest.mjs 的性能数据):
 *   · **能在预算内穷举就穷举**:河牌只剩 0 张、转牌 1 张、翻牌 2 张要补,
 *     组合数分别是 1 / n / C(n,2),一个都不大 —— 那就把每一种补牌都算一遍,
 *     得到的是**精确解**(没有采样误差)。组合数超过 exactMax 才退回蒙特卡洛。
 *     ⚠️ 有个前提:未知底牌最多 1 张。2 张以上未知时,「抽到哪两张」和
 *        「哪张给谁」是两回事 —— 只穷举组合会漏掉一半的分配方式,结果会偏。
 *        那种情况直接走蒙特卡洛(随机分配本来就覆盖了所有分配)。
 *        荷官模式下所有底牌都知道,所以正常路径永远是 exact=false 之外的穷举。
 *   · **蒙特卡洛必须分片**:一次 7 张牌评估 ≈ 40µs(桌面实测),
 *     翻牌前 9 人桌 1500 样本 ≈ 0.55s —— 一口气算完会卡住渲染。
 *     所以 createEquityRun() 只提供 step(budgetMs),由调用方按时间片推进
 *     (app.js 用 requestIdleCallback 喂它,见 pumpEquity)。
 *
 * ────────────────────────────────────────────────────────────
 * ⚠️ 口径(别误读,界面上也写着「摊牌胜率」):
 *   · 这是「此刻全部摊牌」的手牌胜率,**不是**「打到摊牌的概率」;
 *   · **没有**按底池/筹码加权:边池里短筹码只能赢主池,这里不管,
 *     同分就是按人数平分;
 *   · 它是**纯显示层**数据 —— 绝对不能喂给 AI(那会改变牌局平衡)。
 */

import { buildDeck, cardText } from './cards.js';
import { evaluate, compare } from './handEval.js';

/** 默认采样数:兼顾准确度(≈±1.3% 标准差)与速度 */
export const DEFAULT_SAMPLES = 1500;
/** 组合数不超过这个值就穷举(≈9 人桌翻牌 C(31,2)=465,绰绰有余) */
export const EXACT_MAX_COMBOS = 20000;

/** 二项式系数 C(n,k)。只在「值很小」的场合用来判断穷举划不划算,浮点误差无所谓。 */
export function combos(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/** rand 的返回值夹取到 [0,1) —— 契约之外的值会算出越界下标,悄悄丢一张牌(同 cards.shuffle) */
function clamp01(r) {
  let x = Number(r());
  if (!Number.isFinite(x) || x < 0) x = 0;
  if (x >= 1) x = 1 - Number.EPSILON;
  return x;
}

/**
 * 把一次模拟需要的上下文全部算好。
 *
 * @param {object} opts
 * @param {Array<{seat:number, hole:Array<number|null>}>} opts.contenders
 *        参与摊牌的座位(弃牌的人**不要**放进来 —— 他们不参与,但他们的底牌要作为
 *        「已知的牌」传进 dead,否则会被重复发出去)
 * @param {number[]} [opts.board] 已知公共牌(0 / 3 / 4 / 5 张)
 * @param {number[]} [opts.dead]  其它已知但不在场的牌(烧牌、已弃牌者的底牌)
 * @param {boolean} [opts.shortDeck] 短牌 36 张
 * @param {number} [opts.exactMax] 穷举阈值
 */
export function prepareEquity(opts = {}) {
  const contenders = (opts.contenders || []).map((c) => ({
    seat: c.seat,
    hole: (c.hole || []).slice(0, 2),
  }));
  const board = (opts.board || []).slice();
  const dead = (opts.dead || []).slice();
  const shortDeck = !!opts.shortDeck;
  const exactMax = opts.exactMax ?? EXACT_MAX_COMBOS;

  if (contenders.length < 1) throw new Error('equity: 至少要有一个参与者');
  if (board.length > 5) throw new Error(`equity: 公共牌最多 5 张,收到 ${board.length}`);

  /**
   * 同一张牌不能出现在两处。
   *
   * 出现了就是**上游数据错了**(比如把弃牌者的底牌又当成参与者传进来),
   * 这时模拟会把同一张牌发给两个人,算出一手根本不存在的假牌 ——
   * 结果全错却不报错,是最难查的一类 bug。所以宁可在这里直接抛。
   */
  const seen = new Set();
  const addKnown = (c, where) => {
    if (c === null || c === undefined) return;
    if (seen.has(c)) {
      throw new Error(`equity: 牌 ${cardText(c)} 重复出现(${where})—— 上游把同一张牌用了两次`);
    }
    seen.add(c);
  };
  board.forEach((c, i) => addKnown(c, `公共牌第 ${i + 1} 张`));
  dead.forEach((c, i) => addKnown(c, `死牌第 ${i + 1} 张`));
  contenders.forEach((c) => c.hole.forEach((h, j) => addKnown(h, `座位 ${c.seat} 的第 ${j + 1} 张底牌`)));

  // 剩余牌堆:牌型/大小一律交给 handEval,这里只负责「哪些牌还在」
  const pool = buildDeck({ shortDeck }).filter((c) => !seen.has(c));

  const needBoard = Math.max(0, 5 - board.length);
  /** 未知底牌的位置(荷官模式下为空;玩家模式我们根本不算,留在这里是为了测试与复用) */
  const unknownSlots = [];
  contenders.forEach((c, i) => c.hole.forEach((h, j) => {
    if (h === null || h === undefined) unknownSlots.push([i, j]);
  }));
  const drawCount = needBoard + unknownSlots.length;
  if (drawCount > pool.length) {
    throw new Error(`equity: 还要发 ${drawCount} 张,剩余牌堆只有 ${pool.length} 张`);
  }

  const totalCombos = combos(pool.length, drawCount);
  // 未知底牌 >= 2 时不能只穷举组合(还得穷举「哪张给谁」的分配),直接退回蒙特卡洛
  const exact = unknownSlots.length <= 1 && totalCombos <= exactMax;

  // —— 预分配缓冲:每次试验都要用,循环里绝不新建数组 ——
  const boardBuf = new Array(5);
  for (let i = 0; i < board.length; i++) boardBuf[i] = board[i];
  const handBufs = contenders.map((c) => {
    const b = new Array(7);
    b[0] = c.hole[0] ?? null;
    b[1] = c.hole[1] ?? null;
    return b;
  });

  const sim = {
    seats: contenders.map((c) => c.seat),
    holes: contenders.map((c) => c.hole.slice()),
    board, dead, shortDeck,
    pool, needBoard, unknownSlots, drawCount, totalCombos, exact,
    boardBuf, handBufs,
    /** 还剩多少张没见过 —— 测试里用它钉「牌堆按模式构造」 */
    deckRemaining: pool.length,
    knownCount: seen.size,
    opts: { shortDeck },
    scores: new Array(contenders.length).fill(null),
    /** 每个人累计的胜率份额(0..1) */
    shares: new Array(contenders.length).fill(0),
    trials: 0,
    /** 平局(>=2 人同分)的试验数 —— 用来核对「平局按人数分摊」确实生效了 */
    tieTrials: 0,
    _drawBuf: new Array(drawCount),
    _poolBuf: pool.slice(),
  };
  // 先把「已知的部分」同步进缓冲。
  // ⚠️ 这行不能省:河牌(公共牌 5 张)时 drawCount=0,整场模拟一次都不抽牌,
  //    applyDraw 永远不会被调用 —— 少了它 handBufs 里的公共牌位是空的,
  //    evaluate 会拿一堆 undefined 去判大小,算出「高牌赢同花顺」这种鬼结果。
  //    (踩过:皇家同花顺就在牌面上,却只有一个人赢。)
  applyDraw(sim, sim._drawBuf);
  return sim;
}

/**
 * 把抽到的牌填进空位(公共牌 + 未知底牌),并刷新每个人的 7 张缓冲。
 *
 * 抽到的牌按顺序用:前 needBoard 张补公共牌,剩下的按顺序补未知底牌。
 * 顺序不影响结果(公共牌是个集合,底牌每个人只有两张),只是为了让穷举可复现。
 */
function applyDraw(sim, drawn) {
  const { boardBuf, handBufs, board, needBoard, unknownSlots } = sim;
  for (let i = 0; i < needBoard; i++) boardBuf[board.length + i] = drawn[i];
  for (let k = 0; k < unknownSlots.length; k++) {
    const [ci, hj] = unknownSlots[k];
    handBufs[ci][hj] = drawn[needBoard + k];
  }
  for (let i = 0; i < handBufs.length; i++) {
    const b = handBufs[i];
    b[2] = boardBuf[0]; b[3] = boardBuf[1]; b[4] = boardBuf[2]; b[5] = boardBuf[3]; b[6] = boardBuf[4];
  }
}

/** 判一次大小,把份额记进 shares。同分的人各得 1/N。 */
function settle(sim) {
  const { handBufs, scores, shares, opts } = sim;
  let best = null;
  let ties = 0;
  for (let i = 0; i < handBufs.length; i++) {
    const sc = evaluate(handBufs[i], opts);
    scores[i] = sc;
    if (best === null) { best = sc; ties = 1; continue; }
    const c = compare(sc, best);
    if (c > 0) { best = sc; ties = 1; } else if (c === 0) ties++;
  }
  // 平局按人数分摊 —— 不能简单算成「某人赢」
  const share = 1 / ties;
  for (let i = 0; i < scores.length; i++) {
    if (compare(scores[i], best) === 0) shares[i] += share;
  }
  sim.trials += 1;
  if (ties > 1) sim.tieTrials += 1;
  return ties;
}

/**
 * 蒙特卡洛:抽一次(部分 Fisher-Yates)并评估。
 *
 * 为什么不用「每次重新拷贝牌堆再洗」:那样每次试验都要拷 40 多个元素 + 分配数组。
 * 部分 Fisher-Yates 只要从**任意排列**出发,取前 k 个就是均匀随机的样本 ——
 * 所以同一个数组反复用就行(这正是洗牌算法的性质,不是偷懒)。
 *
 * @returns {number[]} 这次抽到的牌(前 drawCount 个有效)—— 给测试核对「不重复」用
 */
export function randomTrial(sim, rand = Math.random) {
  const { _poolBuf: a, pool, drawCount, _drawBuf: out } = sim;
  const m = pool.length;
  for (let k = 0; k < drawCount; k++) {
    const j = k + Math.floor(clamp01(rand) * (m - k));
    const t = a[k]; a[k] = a[j]; a[j] = t;
    out[k] = a[k];
  }
  applyDraw(sim, out);
  settle(sim);
  return out.slice(0, drawCount);
}

/**
 * 创建一个**可分片推进**的模拟。
 *
 * 用法(app.js):run.step(6) 在空闲时间片里反复调用,返回 true 表示算完了,
 * 然后 run.result() 取结果。不要指望一次 step 就结束 —— 它的全部意义就是
 * 「不阻塞渲染」。
 */
export function createEquityRun(opts = {}) {
  const sim = prepareEquity(opts);
  const samples = Math.max(1, Math.round(opts.samples ?? DEFAULT_SAMPLES));
  const rand = opts.rand || Math.random;
  const now = opts.now || (() => performance.now());

  // —— 穷举用的组合下标(字典序推进:最后一个下标先动)——
  const idx = sim.exact && sim.drawCount > 0 ? new Int32Array(sim.drawCount) : null;
  if (idx) for (let i = 0; i < idx.length; i++) idx[i] = i;
  let exactDone = 0;          // 已经穷举过的组合数
  let exactExhausted = false;

  /** 组合下标往后推一位;返回 false 表示穷举完了 */
  function advance() {
    const n = sim.pool.length;
    let i = sim.drawCount - 1;
    while (i >= 0 && idx[i] === n - sim.drawCount + i) i--;
    if (i < 0) return false;
    idx[i] += 1;
    for (let j = i + 1; j < sim.drawCount; j++) idx[j] = idx[j - 1] + 1;
    return true;
  }

  function stepExact(deadline) {
    if (sim.drawCount === 0) {
      // 河牌:一张都不用补,唯一的答案就是现在这个 —— 精确解一步到位
      if (exactDone === 0) { settle(sim); exactDone = 1; }
      exactExhausted = true;
      return true;
    }
    do {
      for (let i = 0; i < sim.drawCount; i++) sim._drawBuf[i] = sim.pool[idx[i]];
      applyDraw(sim, sim._drawBuf);
      settle(sim);
      exactDone += 1;
      if (!advance()) { exactExhausted = true; return true; }
    } while (now() < deadline);
    return false;
  }

  function stepRandom(deadline) {
    while (sim.trials < samples) {
      randomTrial(sim, rand);
      if (now() >= deadline) break;
    }
    return sim.trials >= samples;
  }

  const run = {
    sim,
    samples,
    get exact() { return sim.exact; },
    get total() { return sim.exact ? sim.totalCombos : samples; },
    /** 进度 0..1(界面显示「计算中」时可以拿它做进度条) */
    progress() {
      if (sim.exact) return sim.totalCombos ? Math.min(1, exactDone / sim.totalCombos) : 1;
      return Math.min(1, sim.trials / samples);
    },
    /**
     * 推进一个时间片。
     * @param {number} budgetMs 这一片最多占用的毫秒数
     * @returns {boolean} 是否已经算完
     */
    step(budgetMs = 6) {
      const deadline = now() + Math.max(1, budgetMs);
      if (sim.exact) {
        if (exactExhausted) return true;
        return stepExact(deadline);
      }
      return stepRandom(deadline);
    },
    done() {
      return sim.exact ? exactExhausted : sim.trials >= samples;
    },
    /**
     * 取结果。
     * @returns {{seats:number[], shares:number[], ties:number, trials:number, exact:boolean,
     *            samples:number, deckRemaining:number, pool:number, board:number[]}}
     */
    result() {
      const n = sim.trials || 1;
      return {
        seats: sim.seats.slice(),
        // 份额 → 0..1 的胜率(同分已按人数分摊)
        shares: sim.shares.map((s) => s / n),
        ties: sim.tieTrials / n,
        trials: sim.trials,
        exact: sim.exact,
        samples: sim.exact ? sim.totalCombos : samples,
        deckRemaining: sim.deckRemaining,
        boardLength: sim.board.length,
        shortDeck: sim.shortDeck,
      };
    },
  };
  return run;
}

/**
 * 一次性算完(测试 / 非界面场合用)。
 * ⚠️ 界面里**不要**用它:它会占满主线程直到算完(见文件头「蒙特卡洛必须分片」)。
 */
export function computeEquity(opts = {}) {
  const run = createEquityRun(opts);
  let guard = 0;
  while (!run.step(1e9)) {
    if (++guard > 1e6) throw new Error('equity: 模拟没能结束');
  }
  return run.result();
}
