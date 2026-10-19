/**
 * 「狼人杀」的**局内积分** —— 只属于这一场(用户明确口径:积分是本局游戏内的)。
 *
 * ────────────────────────────────────────────────────────────────
 * 这个概念为什么容易做歪(先写清楚,免得后来人加错东西)
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
 * 分值设计(与卧底对齐:参与 +1、阵营胜 +3、存活 +1、MVP +1~2)
 *
 *   · 参与            +1  —— 每个人都拿到,包括第一晚就被刀的
 *   · 阵营胜          +3  —— 狼胜给狼,好人胜给好人
 *   · 存活到最后      +1  —— 终局时还没出局
 *   · MVP(按角色,最多 +2):
 *       - 预言家:每验出一只狼 +1(上限 +2)
 *       - 女巫  :毒到狼 +2 / 救下一个好人 +1
 *       - 狼人  :每刀死一个神职 +1(上限 +2)
 *       - 平民  :放逐票投中狼(且他真的被放逐)+1(上限 +2)
 *
 * 为什么要按角色给不同的 MVP 而不是「谁赢谁 MVP」:这个游戏里好人赢大多是
 * 「狼自己失误」,只奖励赢家会让每一局的榜长得一样,看不出谁真的干了活。
 * 分值全部**确定性**(没有随机、没有 LLM 参与)—— 同一局的结果重算永远一样。
 */

import { roleLabel, isGod } from './engine/kernel.js';

/** 分值表(集中一份,测试逐项断言时对照它) */
export const SCORE_RULES = {
  participate: 1,
  win: 3,
  survive: 1,
  seerFoundWolf: 1,
  seerFoundWolfCap: 2,
  witchPoisonWolf: 2,
  witchSavedGood: 1,
  wolfKilledGod: 1,
  wolfKilledGodCap: 2,
  villagerVotedWolf: 1,
  villagerVotedWolfCap: 2,
};

/**
 * 把「内核 state」或一份精简 result 收敛成计分要的形状。
 * 两种都接受,是因为:界面上手边就是 kernel.state;测试与模拟器更愿意传精简对象。
 * @param {object} x
 * @returns {{winner:string, seats:Array<{seat:number,role:string,alive:boolean}>,
 *            events:object[], winnerReason:string|null}}
 */
export function normalizeResult(x) {
  if (!x || typeof x !== 'object') throw new Error('score() 需要一局的结果');
  const st = x.state && x.state.roles ? x.state : x;
  if (!Array.isArray(st.roles)) throw new Error('score() 的结果里没有 roles');
  const alive = Array.isArray(st.alive) ? st.alive : new Array(st.roles.length).fill(true);
  const events = Array.isArray(st.events) ? st.events : [];
  return {
    winner: st.winner || x.winner || null,
    winnerReason: st.endReason || x.endReason || null,
    seats: st.roles.map((role, seat) => ({ seat, role, alive: !!alive[seat] })),
    events,
  };
}

/** 某座位是否属于胜方 */
function sideOf(role) {
  return role === 'werewolf' ? 'werewolf' : 'good';
}

/**
 * 一局的积分。
 *
 * @param {object} result 内核 state,或 {winner, roles, alive, events}
 * @param {object} [cfg] 预留(例如以后按难度加权);现在不读也能跑
 * @returns {Array<{seat:number, delta:number, label:string, items:Array<{why:string, delta:number}>}>}
 */
export function score(result, cfg = {}) {
  const r = normalizeResult(result);
  const rows = r.seats.map((s) => ({ seat: s.seat, delta: 0, label: '', items: [] }));
  const add = (seat, why, delta) => {
    if (!delta) return;
    const row = rows[seat];
    row.delta += delta;
    row.items.push({ why, delta });
  };

  // ① 参与
  for (const s of r.seats) add(s.seat, '参与', SCORE_RULES.participate);

  if (!r.winner) {
    // 没打完(被中断 / 存档丢掉):只保留参与分,不要凭空发胜负分
    return finalize(rows);
  }

  const wolfWin = r.winner === 'werewolf';
  // ② 阵营胜 + ③ 存活到最后
  for (const s of r.seats) {
    const won = (sideOf(s.role) === 'werewolf') === wolfWin;
    if (won) add(s.seat, '阵营胜', SCORE_RULES.win);
    if (s.alive) add(s.seat, '存活到最后', SCORE_RULES.survive);
  }

  // ④ MVP —— 从账本里数,不猜
  const exileByDay = new Map();      // day → 被放逐座位
  const votesByDay = new Map();      // day → [{seat, target}]
  const wolfKills = [];              // {day, target}
  const savedDays = [];              // 女巫救人的天
  const poisons = [];                // {day, seat(女巫), target}
  const checks = [];                 // {day, by, target, result}
  for (const e of r.events) {
    if (e.kind === 'exile') exileByDay.set(e.day, e.seat);
    if (e.kind === 'vote') {
      if (!votesByDay.has(e.day)) votesByDay.set(e.day, []);
      votesByDay.get(e.day).push({ seat: e.seat, target: e.target });
    }
    if (e.kind === 'wolfKill' && e.target !== null && e.target !== undefined) {
      wolfKills.push({ day: e.day, target: e.target });
    }
    if (e.kind === 'seerCheck' && e.target !== undefined && e.target !== null) {
      checks.push({ day: e.day, by: e.seat, target: e.target, result: e.result || null });
    }
    if (e.kind === 'witchAction') {
      if (/解药/.test(String(e.text || ''))) savedDays.push({ day: e.day, seat: e.seat, target: e.target });
      if (/毒药/.test(String(e.text || ''))) poisons.push({ day: e.day, seat: e.seat, target: e.target });
    }
  }

  const roleOf = new Map(r.seats.map((s) => [s.seat, s.role]));

  // 预言家:验出狼
  let seerHits = 0;
  for (const c of checks) {
    if (roleOf.get(c.by) !== 'seer') continue;
    if (c.result !== 'wolf') continue;
    if (seerHits >= SCORE_RULES.seerFoundWolfCap) break;
    seerHits += 1;
    add(c.by, '验出狼人', SCORE_RULES.seerFoundWolf);
  }

  // 女巫:毒到狼 / 救下好人
  // ⚠️ 救人的判定看**被救的那个人的身份是好人** —— 救下一个狼(比如狼自刀)不算 MVP。
  for (const p of poisons) {
    if (roleOf.get(p.seat) !== 'witch') continue;
    if (roleOf.get(p.target) !== 'werewolf') continue;
    add(p.seat, '毒到狼人', SCORE_RULES.witchPoisonWolf);
  }
  for (const s of savedDays) {
    if (roleOf.get(s.seat) !== 'witch') continue;
    if (roleOf.get(s.target) === 'werewolf') continue;
    if (s.target === undefined || s.target === null) continue;
    add(s.seat, '救下好人', SCORE_RULES.witchSavedGood);
  }

  // 狼人:刀死神职
  let wolfHits = 0;
  for (const k of wolfKills) {
    if (wolfHits >= SCORE_RULES.wolfKilledGodCap) break;
    if (!isGod(roleOf.get(k.target))) continue;
    // ⚠️ 只看「刀口是不是神职」不够:被女巫解药救下来的人**没有死**,
    //    那不算战果(否则「刀了但被救」和「刀死了」得分一样,榜会虚高)。
    const victim = r.seats.find((x) => x.seat === k.target);
    if (!victim || victim.alive) continue;
    wolfHits += 1;
    // 刀是狼队集体决定,分给**当晚所有还活着的狼**?那会重复计分。
    // 这里记给「当晚提交了这个目标的那只狼」—— 账本里 wolfKill 事件不带 seat,
    // 所以退一步:分给**所有狼里座位号最小的那一只**(确定性,且模拟不出争议)。
    const wolves = r.seats.filter((x) => x.role === 'werewolf').map((x) => x.seat).sort((a, b) => a - b);
    if (wolves.length) add(wolves[0], '刀中神职', SCORE_RULES.wolfKilledGod);
  }

  // 平民:放逐票投中狼
  const villagerHits = new Map();
  for (const [day, list] of votesByDay) {
    const exiled = exileByDay.get(day);
    if (exiled === undefined) continue;
    if (roleOf.get(exiled) !== 'werewolf') continue;
    for (const v of list) {
      if (v.target !== exiled) continue;
      if (roleOf.get(v.seat) !== 'villager') continue;
      const n = villagerHits.get(v.seat) || 0;
      if (n >= SCORE_RULES.villagerVotedWolfCap) continue;
      villagerHits.set(v.seat, n + 1);
      add(v.seat, '投中狼人', SCORE_RULES.villagerVotedWolf);
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
    /** 座位 → { seat, total, wins, survived, lastDelta, history:[] } */
    this.bySeat = new Map();
    for (let s = 0; s < this.seats; s++) {
      this.bySeat.set(s, { seat: s, total: 0, wins: 0, survived: 0, lastDelta: 0, history: [] });
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
    const wolfWin = r.winner === 'werewolf';
    this.rounds += 1;
    for (const row of list) {
      const rec = this.bySeat.get(row.seat);
      if (!rec) continue;
      rec.total += row.delta;
      rec.lastDelta = row.delta;
      rec.history.push(row.delta);
      const s = r.seats[row.seat];
      if (r.winner) {
        const won = (sideOf(s.role) === 'werewolf') === wolfWin;
        if (won) rec.wins += 1;
        if (s.alive) rec.survived += 1;
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

/* ==================================================================== *
 * 一场的最终排名(交给平台算全局分)
 * ==================================================================== */

/**
 * 把「一场」收敛成平台统一形状。
 *
 * 平台只认这一个形状(见 src/shared/leaderboard.mjs 的 normalizeSummary):
 *   { gameId, rounds, seats, ranking: [{ seat, name, score }] }
 *
 * @param {object} source 三种都吃,调用方用手里现成的那个:
 *   · MatchStandings 实例 —— 一场已经打完几局,用它 `ranking()` 的累计分;
 *   · 内核 state / 精简 result —— 只打了**一局**(rounds 记为 1);
 *   · `{ rounds, seats, ranking:[{seat,total/score,name}] }` 快照式对象(测试方便)。
 * @param {object} [ctx] 名字来源:`{ names: string[] }` 或 `{ nameOf:(seat)=>string }`。
 *   ⚠️ 为什么名字要单独传:MatchStandings 只存积分(它属于纯算分,不该知道
 *   屏幕上的显示名),而排行榜需要名字认人 —— 所以由屏幕把名字表交进来。
 * @returns {{gameId:string, rounds:number, seats:number,
 *            ranking:Array<{seat:number,name:string,score:number}>}}
 */
export function matchSummary(source, ctx = {}) {
  const nameOf = (seat, fallback) => {
    if (typeof ctx.nameOf === 'function') {
      const n = ctx.nameOf(seat);
      if (n) return n;
    }
    if (Array.isArray(ctx.names) && ctx.names[seat]) return ctx.names[seat];
    return fallback || `${Number(seat) + 1}号`;
  };
  const toInt = (v) => Math.round(Number(v) || 0);

  let rows = [];
  let rounds = 0;
  let seats = 0;

  if (source && typeof source.ranking === 'function') {
    rows = source.ranking();                       // MatchStandings
    rounds = toInt(source.rounds);
    seats = toInt(source.seats) || rows.length;
  } else if (source && Array.isArray(source.ranking)) {
    // 快照式:{ rounds, seats, ranking:[{ seat, total }] }
    rows = source.ranking;
    rounds = toInt(source.rounds);
    seats = toInt(source.seats) || rows.length;
  } else if (source && (Array.isArray(source.roles) || Array.isArray(source?.state?.roles))) {
    // 只打了一局:用本局得分当排名(每一局的排名,就是这一局谁分高)
    const r = normalizeResult(source);
    const deltas = score(source, {});
    const total = new Map();
    for (const d of deltas) total.set(d.seat, (total.get(d.seat) || 0) + d.delta);
    rows = r.seats.map((s) => ({ seat: s.seat, total: total.get(s.seat) || 0 }));
    rounds = 1;
    seats = r.seats.length;
  } else {
    throw new Error('werewolf.matchSummary 需要 MatchStandings / 内核 state / { rounds, ranking }');
  }

  // ⚠️ 一场都没打完就不该记分:否则「全员 0 分,按座位号排名」会凭空产生
  //    一个冠军(名次分 N-1),把排行榜刷成假的。调用方(屏幕)也会先判,
  //    这里再判一次是**兜底**:宁可抛一句能看懂的错误,也不要静默记错。
  if (!(rounds > 0)) throw new Error('这一场还没打完任何一局,不记分');
  if (!rows.length) throw new Error('这一场没有排名(座位表是空的)');

  const ranking = rows
    .map((r) => ({
      seat: r.seat,
      name: nameOf(r.seat, r.name),
      score: toInt(r.total ?? r.score ?? r.points),
    }))
    // 与 MatchStandings.ranking 同一口径:总分降序、同分座位号升序
    .sort((a, b) => (b.score - a.score) || (a.seat - b.seat));

  return { gameId: 'werewolf', rounds: Math.max(1, rounds), seats: Math.max(seats, ranking.length), ranking };
}

/** 角色 → 中文(界面截图/日志用) */
export { roleLabel };
