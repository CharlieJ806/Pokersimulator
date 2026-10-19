/**
 * 德州扑克的「局内积分」与「一场的最终排名」。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么扑克也要有 scoring.js(它以前没有)
 *
 * 平台现在有两层积分(见 src/shared/leaderboard.mjs 的文件头):
 *   ① 局内积分 —— 一场游戏内部的分,用来算**本场排名**;
 *   ② 全局积分 —— 一场结束后按最终名次折算,写持久化排行榜。
 * 卧底、狼人杀早就有自己的 scoring.js,扑克用的是「筹码」这个天然积分 ——
 * 但接口必须统一(`score(result,cfg)` + `matchSummary(source,ctx)`),
 * 否则平台壳就要为扑克写一条 if,再加游戏就变成三条。
 *
 * 所以这里不发明第二套分:扑克的积分**就是筹码**。
 *   · 一局的 delta = 这一手的净筹码输赢(引擎的 lastResult.deltas);
 *   · 一场的排名 = 当前筹码从多到少(筹码归零 = 出局 = 垫底)。
 * 这也符合用户口径「赢光所有人、拿第一」:筹码就是名次。
 *
 * ⚠️ 为什么不按「累计 delta 之和」排名:筹码会因为**摊牌赢池**而流入流出,
 *    但 delta 之和等于「当前筹码 - 起始筹码」,只有人出局(筹码被没收)时才对不上。
 *    直接用当前筹码最直观,也和界面上「全场筹码对比」显示的是同一个数。
 */

/**
 * 一手的积分(净筹码输赢)。
 *
 * @param {object} result 引擎 state(或 {state}),读 lastResult.deltas
 * @param {object} [cfg] 游戏设置(现在不读 —— 分值只由牌局结果决定)
 * @returns {Array<{seat:number, delta:number, label:string}>}
 */
export function score(result, cfg = {}) {
  void cfg;
  const st = result?.state && Array.isArray(result.state.players) ? result.state : result;
  const deltas = Array.isArray(st?.lastResult?.deltas) ? st.lastResult.deltas : [];
  const out = [];
  for (const d of deltas) {
    if (!Number.isInteger(d?.seat)) continue;
    const delta = Math.round(Number(d.delta) || 0);
    out.push({
      seat: d.seat,
      delta,
      label: `本手筹码 ${delta >= 0 ? '+' : ''}${delta}`,
    });
  }
  return out;
}

/**
 * 一场(一次锦标赛)的最终排名 —— 平台据此算全局分。
 *
 * 统一形状(见 shared/leaderboard.mjs 的 normalizeSummary):
 *   { gameId, rounds, seats, ranking: [{ seat, name, score }] }
 *
 * @param {object} source 引擎 state(或 {state})
 * @param {object} [ctx] 预留(例如以后按赛制加权);现在不读
 * @returns {{gameId:string, rounds:number, seats:number,
 *            ranking:Array<{seat:number,name:string,score:number}>}}
 */
export function matchSummary(source, ctx = {}) {
  void ctx;
  const st = source?.state && Array.isArray(source.state.players) ? source.state : source;
  if (!st || !Array.isArray(st.players)) throw new Error('poker.matchSummary 需要引擎 state');

  // 参战人数 = 开桌时的座位数(不是「还剩几个人」)—— 名次分要按开桌规模算,
  // 否则「6 人桌打到最后剩 2 人」会被当成 2 人局,冠军只值 1 分。
  const seats = st.players.length;
  const ranking = st.players
    .map((p) => ({
      seat: p.seat,
      name: p.name || `${p.seat + 1}号`,
      // 筹码为负只可能出现在坏状态里;夹到 0,别让排名出现负数分。
      score: Math.max(0, Math.round(Number(p.stack) || 0)),
    }))
    // 同筹码按座位号升序:确定性(与引擎 stackSituation 的排名口径一致),
    // 不能让「同分两个人」每帧换顺序。
    .sort((a, b) => (b.score - a.score) || (a.seat - b.seat));

  // 回合数 = 打了多少手。手数越多,这一场的名次越能说明问题(权重里的回合系数)。
  const rounds = Math.max(1, Math.round(Number(st.handNo) || 0));
  return { gameId: 'poker', rounds, seats, ranking };
}
