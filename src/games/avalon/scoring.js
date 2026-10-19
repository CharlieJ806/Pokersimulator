/**
 * 「阿瓦隆」的**局内积分** —— 只属于这一场(用户明确口径:积分是本局游戏内的)。
 *
 * ────────────────────────────────────────────────────────────────
 * 这个概念为什么容易做歪(与狼人杀/卧底同一个警告)
 *
 * 「积分」有两种完全不同的东西:
 *   ① **跨游戏、跨会话的平台积分**(长期排行榜、存盘、账号绑定);
 *   ② **一场游戏内的积分**(这一场连打 5 局,谁赢得多)。
 * 用户要的是 ②。所以这个文件里:
 *   · **不 import 任何 shared/scoring.mjs**(那个平台级框架不要建、不依赖);
 *   · **不写 localStorage / 不发存档**(积分跟着这一场走,重新开局就清空);
 *   · 只有「一局的得分」与「这一场的累计榜」两件东西。
 *
 * ────────────────────────────────────────────────────────────────
 * 分值设计(与狼人杀对齐:参与 +1、阵营胜 +3,再按这个游戏的特点给 MVP)
 *
 *   · 参与            +1  —— 每个人都拿到
 *   · 阵营胜          +3  —— 好人胜给好人,坏人胜给坏人
 *   · 任务成功        +1  —— **好人**在「成功的那一轮」上了车(上限 +3)
 *   · 成功破坏        +2  —— **坏人**在某一轮投出了失败卡(上限 +2)
 *   · 活过刺杀        +2  —— 梅林,且好人最终获胜(刺客没刺中)
 *   · 刺中梅林        +2  —— 刺客,且刺中了梅林(坏人翻盘)
 *
 * 为什么好人算「上车成功」而不是「投了几张成功卡」:
 *   好人的卡被规则钉死是成功,所以「投了几张」完全等于「上了几次车」——
 *   但**上了几次成功的车**才是真的贡献(上了一次失败的车,那一轮是白上的)。
 * 为什么坏人算「出了几次失败」而不是「赢了几轮」:
 *   破坏才是坏人的生产性动作;赢是结果,分已经拿过了(阵营胜 +3)。
 *   上限 +2 是为了防止「一局里连续破坏 3 次」把榜拉爆 ——
 *   而且那 3 次里通常有一次是白送的(见提示词里「必要时伪装成功」)。
 *
 * 分值全部**确定性**(没有随机、没有 LLM 参与)—— 同一局的结果重算永远一样。
 */

import { isEvil, roleLabel } from './engine/kernel.js';

/** 分值表(集中一份,测试逐项断言时对照它) */
export const SCORE_RULES = {
  participate: 1,
  win: 3,
  questOnTeam: 1,
  questOnTeamCap: 3,
  sabotage: 2,
  sabotageCap: 2,
  merlinSurvive: 2,
  assassinHit: 2,
};

/**
 * 把「内核 state」或一份精简 result 收敛成计分要的形状。
 * 两种都接受,是因为:界面上手边就是 kernel.state;测试与模拟器更愿意传精简对象。
 * @param {object} x
 * @returns {{winner:string|null, endReason:string|null,
 *            seats:Array<{seat:number, role:string}>,
 *            quests:object[], cards:Array<{round:number, seat:number, card:string}>}}
 */
export function normalizeResult(x) {
  if (!x || typeof x !== 'object') throw new Error('score() 需要一局的结果');
  const st = x.state && x.state.roles ? x.state : x;
  if (!Array.isArray(st.roles)) throw new Error('score() 的结果里没有 roles');
  const quests = Array.isArray(st.quests) ? st.quests : [];
  const events = Array.isArray(st.events) ? st.events : [];
  // 谁出了哪张卡:只在 secret 账本里(kernel 有意不把它写进 public)
  const cards = events
    .filter((e) => e.kind === 'card' && e.card)
    .map((e) => ({ round: e.round, seat: e.seat, card: e.card }));
  return {
    winner: st.winner || x.winner || null,
    endReason: st.endReason || x.endReason || null,
    seats: st.roles.map((role, seat) => ({ seat, role })),
    quests: quests.map((q) => ({ round: q.round, team: (q.team || []).slice(), result: q.result })),
    cards,
  };
}

/**
 * 一局的积分。
 *
 * @param {object} result 内核 state,或 {winner, roles, quests, events}
 * @param {object} [cfg] 预留(例如以后按难度加权);现在不读也能跑
 * @returns {Array<{seat:number, delta:number, label:string, items:Array<{why:string, delta:number}>}>}
 */
export function score(result, cfg = {}) {
  const r = normalizeResult(result);
  const rows = r.seats.map((s) => ({ seat: s.seat, delta: 0, label: '', items: [] }));
  const add = (seat, why, delta) => {
    if (!delta) return;
    const row = rows[seat];
    if (!row) return;
    row.delta += delta;
    row.items.push({ why, delta });
  };

  // ① 参与
  for (const s of r.seats) add(s.seat, '参与', SCORE_RULES.participate);

  if (!r.winner) {
    // 没打完(被中断 / 存档丢掉):只保留参与分,不要凭空发胜负分
    return finalize(rows);
  }

  const evilWin = r.winner === 'evil';
  // ② 阵营胜
  for (const s of r.seats) {
    if (isEvil(s.role) === evilWin) add(s.seat, '阵营胜', SCORE_RULES.win);
  }

  // ③ 好人:上了「成功的那一轮」的车
  const goodHits = new Map();
  for (const q of r.quests) {
    if (q.result !== 'success') continue;
    for (const seat of q.team) {
      const s = r.seats[seat];
      if (!s || isEvil(s.role)) continue;
      const n = goodHits.get(seat) || 0;
      if (n >= SCORE_RULES.questOnTeamCap) continue;
      goodHits.set(seat, n + 1);
      add(seat, '任务成功', SCORE_RULES.questOnTeam);
    }
  }

  // ④ 坏人:出过几次失败卡
  const sabotage = new Map();
  for (const c of r.cards) {
    if (c.card !== 'fail') continue;
    const s = r.seats[c.seat];
    if (!s || !isEvil(s.role)) continue;
    const n = sabotage.get(c.seat) || 0;
    if (n >= SCORE_RULES.sabotageCap) continue;
    sabotage.set(c.seat, n + 1);
    add(c.seat, '成功破坏', SCORE_RULES.sabotage);
  }

  // ⑤ 梅林活过刺杀 / ⑥ 刺客刺中梅林
  for (const s of r.seats) {
    if (s.role === 'merlin' && !evilWin) add(s.seat, '活过刺杀', SCORE_RULES.merlinSurvive);
    if (s.role === 'assassin' && evilWin && r.endReason === 'assassin-hit') {
      add(s.seat, '刺中梅林', SCORE_RULES.assassinHit);
    }
  }

  void cfg;
  return finalize(rows);
}

/** 把 items 拼成一句能显示的中文 */
function finalize(rows) {
  return rows.map((r) => ({
    seat: r.seat,
    delta: r.delta,
    label: r.items.map((i) => `${i.why}+${i.delta}`).join(' · '),
    items: r.items,
  }));
}

/**
 * 一场游戏的累计榜(同一场连打多局,结束时给排名)。
 *
 * 「一场」的生命周期由界面控制:进大厅/重开就 reset()。
 * ⚠️ 这里**不存盘**:用户口径是「本局游戏内」,关掉就没了。
 */
export class MatchStandings {
  /** @param {number} seats 座位数 */
  constructor(seats = 0) {
    this.seats = Math.max(0, Math.round(Number(seats) || 0));
    this.reset();
  }

  /** 清空这一场的积分(重新开局时调) */
  reset() {
    this.rounds = 0;
    /** 座位 → { seat, total, wins, lastDelta, history:[] } */
    this.bySeat = new Map();
    for (let s = 0; s < this.seats; s++) {
      this.bySeat.set(s, { seat: s, total: 0, wins: 0, lastDelta: 0, history: [] });
    }
    return this;
  }

  /** 座位数变了(换人数开局)—— 按新座位数重建,旧分不跨局保留 */
  resize(seats) {
    this.seats = Math.max(0, Math.round(Number(seats) || 0));
    return this.reset();
  }

  /**
   * 记一局。
   * @param {object} result 内核 state 或精简 result(见 normalizeResult)
   * @param {Array} [rows] 已经算好的 score() 结果(省一次计算)
   * @returns {{rows:Array, ranking:Array}}
   */
  addRound(result, rows = null) {
    const list = rows || score(result, {});
    const r = normalizeResult(result);
    const evilWin = r.winner === 'evil';
    this.rounds += 1;
    for (const row of list) {
      const rec = this.bySeat.get(row.seat);
      if (!rec) continue;
      rec.total += row.delta;
      rec.lastDelta = row.delta;
      rec.history.push(row.delta);
      const s = r.seats[row.seat];
      if (r.winner && s) {
        if (isEvil(s.role) === evilWin) rec.wins += 1;
      }
    }
    return { rows: list, ranking: this.ranking() };
  }

  /**
   * 当前排名:总分降序,同分按座位号升序(确定性 —— 同分不能每帧换顺序)。
   */
  ranking() {
    return [...this.bySeat.values()]
      .sort((a, b) => (b.total - a.total) || (a.seat - b.seat))
      .map((r, i) => ({ ...r, rank: i + 1, history: r.history.slice() }));
  }

  /** 给界面用的一句话(「本场第 3 局 · 领先:阿川 12 分」) */
  summary(nameOf = null) {
    if (!this.rounds) return '本场还没有打完的局';
    const top = this.ranking()[0];
    const name = nameOf && top ? (nameOf(top.seat) || `${top.seat + 1}号`) : (top ? `${top.seat + 1}号` : '');
    return `本场第 ${this.rounds} 局 · 领先:${name} ${top ? top.total : 0} 分`;
  }
}

/** 角色 → 中文(界面截图/日志用) */
export { roleLabel };
