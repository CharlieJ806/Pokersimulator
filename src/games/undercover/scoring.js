/**
 * 「谁是卧底」的**算分与排名** —— 这一层只属于这个游戏,不是平台框架。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么要单独一个文件(而不是塞进 ui/screen.js 或 index.mjs)
 *
 *   · 一局打完之后「谁该得几分」是一条**纯规则**:给它一份结算结果、还它一串
 *     `{seat, delta, label}`,不碰 DOM、不碰存储、不碰 LLM —— 所以它能被纯 Node
 *     直接测(tools/undercoverguess.mjs 就是干这个的),不必为了验分数开 Electron;
 *   · 界面只做两件事:把结果交给 `createScoreboard().apply()`、把返回的排名画出来。
 *     判定与展示分开之后,改分值不用碰任何一处 DOM 代码。
 *
 * ────────────────────────────────────────────────────────────────
 * 积分只在**本场游戏内**累计(用户明确要求:「积分制是本局游戏内的」)
 *
 *   · 表在**内存**里(`createScoreboard()` 的闭包),不写 localStorage、不进配置。
 *     所以刷新页面 / 换到别的游戏 / 重新进入谁是卧底,分数都从 0 开始 ——
 *     这是有意的,不是没做完:一个跨游戏、跨会话的长期积分榜会让「这一局谁玩得好」
 *     变成「谁玩得久」,而且积分和等级这类东西一旦落盘就得处理迁移、清零、作弊……
 *     收益远小于成本。
 *   · 同一场里**连着打几局会继续累计**(中途回大厅再点「开始」不清零),
 *     这样「三局两胜」这种玩法才看得出来;离开游戏(退出本局 / 换游戏)就没了。
 *   · 「清空」是显式的(排名面板上的按钮,点两次才真的清)—— 见 ui/screen.js。
 *
 * ────────────────────────────────────────────────────────────────
 * 分值方案(单位:分)。为什么是这几个数,以及「躺赢」「瞎猜」为什么不划算
 *
 *   | 事件                     | 分值 | 理由                                                     |
 *   |--------------------------|------|----------------------------------------------------------|
 *   | 参与一局                 | +1   | 保底,让「被第一轮冤死」的人不至于 0 分(那会让人不敢说话) |
 *   | 阵营胜                   | +3   | 这是主项:赢才是目标                                      |
 *   | 存活到最后(自己阵营获胜) | +1   | 只看**赢的那一方**的幸存者:输的那边活到最后没有意义       |
 *   | 投中一个真卧底(每票)     | +1   | ★ 这一条是我加的,专门用来治「躺赢」(见下)                |
 *   | 卧底猜词命中             | +3   | 一次赌赢直接翻盘,值这个价                                |
 *   | 卧底猜词没中             | −2   | 一次赌输直接把阵营送掉,扣分只是让人记住这个代价           |
 *   | 平民(含白板)去猜词       | −1   | 猜了必出局,等于自己送人头;扣分 + 失去后面所有得分机会     |
 *   | 被误投出局的平民         |  0   | **不惩罚受害者**:被投错是别人的判断,不是他的错           |
 *
 *   为什么「躺赢」不划算:
 *     躺着不动的人最多拿到 `参与 1 + 阵营胜 3 + 存活 1 = 5` 分。看起来和认真玩一样,
 *     但这里还有两条:
 *       ① **投中卧底 +1 / 每票** 只有真在推理的人才拿得到(最多 4 轮 = +4);
 *          跟着乱投、或者每轮弃票的人,这一项是 0。
 *       ② 「存活到最后」要求自己阵营获胜 —— 一个只会说「挺常见的」的人,
 *          在平民阵营里最容易活到最后被卧底留着背锅,但那时**阵营是输的**,
 *          这 1 分也拿不到。也就是说:躺得过分的人,大概率只能拿 1 分。
 *     所以能拿到 8~9 分的,一定是「赢 + 活着 + 至少投对几次」的人。
 *
 *   为什么「瞎猜」不划算:
 *     · 卧底猜错 = −2 且本局直接输(还丢掉 +3 阵营胜和 +1 存活),期望上是全表最差的一手;
 *     · 平民/白板猜词 = −1 且立刻出局(丢掉后面所有轮的投票命中与阵营胜);
 *     · 只有「卧底 + 猜中」这一种情况是赚的(+3),而它需要模型先自省到自己是卧底
 *       并从公开描述里推出平民词 —— 提示词与代码闸门(agent._guessGate)都按这个口径写。
 *
 *   ⚠️ 分值改动请顺手改这张表 + tools/undercoverguess.mjs 里的逐项断言,
 *      两处对不上时测试会红(有意为之)。
 */

/** 分值表(唯一真源:score() 只从这里取数,别在别处写死数字) */
export const POINTS = Object.freeze({
  participate: 1,
  campWin: 3,
  survive: 1,
  correctVote: 1,
  guessHit: 3,
  guessMiss: -2,
  civilianGuess: -1,
});

/** 阵营:白板在胜负与算分上都算平民阵营(只有 'undercover' 是另一边) */
function campOf(role) {
  return role === 'undercover' ? 'undercover' : 'civilian';
}

function campLabel(camp) {
  return camp === 'undercover' ? '卧底' : '平民';
}

/**
 * 一局的算分明细。
 *
 * 这是这个游戏**自己的** `score(result, cfg)`:`result` 的形状由
 * view.js 的 buildScoreResult 定义(seats / winner / guess / votes),
 * 平台壳与界面只负责原样把它交进来、再把返回的数组累加 —— 它们不解释任何字段。
 *
 * @param {object} result buildScoreResult(state) 的返回值
 * @param {object} [cfg] games.undercover 那一份设置。
 *   ⚠️ 目前**不读**:分值只由事件决定(用户口径),难度/人数都不参与,否则「今天调简单
 *   难度刷分」会变成一条捷径。保留这个形参是因为调用点(界面 / 以后别的游戏)
 *   统一按 score(result, cfg) 调 —— 真需要按设置加权时,改这里就够了。
 * @returns {Array<{seat:number, delta:number, label:string}>}
 *   label 是**给人看的一句话**,带分值(如「卧底猜中 +3」),界面直接拼进结算明细。
 */
export function score(result, cfg = {}) {
  void cfg;
  const out = [];
  if (!result || !Array.isArray(result.seats) || !result.winner) return out;
  const winner = result.winner === 'undercover' ? 'undercover' : 'civilian';
  const bySeat = new Map();
  for (const s of result.seats) bySeat.set(s.seat, s);

  // ① 参与 + 阵营胜 + 存活
  for (const s of result.seats) {
    if (!Number.isInteger(s.seat)) continue;
    out.push({ seat: s.seat, delta: POINTS.participate, label: `参与一局 +${POINTS.participate}` });
    if (campOf(s.role) === winner) {
      out.push({
        seat: s.seat,
        delta: POINTS.campWin,
        label: `${campLabel(winner)}胜(阵营) +${POINTS.campWin}`,
      });
      // 只有赢的一方的幸存者才算「存活到最后」:输的那边活到最后没有任何意义,
      // 给分等于奖励「躲起来不表态」——那正是要压的行为。
      if (s.alive) {
        out.push({ seat: s.seat, delta: POINTS.survive, label: `存活到最后 +${POINTS.survive}` });
      }
    }
  }

  // ② 投中真卧底(每票 +1)。只算**平民阵营**投出去的票:
  //    两卧底局里卧底互相投能骗信任,那是他们的战术,不该给平民阵营的分。
  for (const v of (result.votes || [])) {
    if (v.to === null || v.to === undefined) continue;
    const from = bySeat.get(v.from);
    const to = bySeat.get(v.to);
    if (!from || !to) continue;
    if (campOf(from.role) !== 'civilian') continue;
    if (to.role !== 'undercover') continue;
    out.push({ seat: from.seat, delta: POINTS.correctVote, label: `投中卧底 +${POINTS.correctVote}` });
  }

  // ③ 猜词(一局里可能有好几次:平民猜一次自己出局,后面别人还能再猜)。
  //    每一条都要算 —— 只算最后一条的话,前面那个送人头的平民就白送了。
  for (const g of (result.guesses || [])) {
    if (!Number.isInteger(g.seat)) continue;
    if (g.role === 'undercover') {
      out.push(g.hit
        ? { seat: g.seat, delta: POINTS.guessHit, label: `卧底猜中平民词 +${POINTS.guessHit}` }
        : { seat: g.seat, delta: POINTS.guessMiss, label: `卧底猜错平民词 ${POINTS.guessMiss}` });
    } else {
      // 平民/白板：对错都一样，猜了就出局
      out.push({
        seat: g.seat,
        delta: POINTS.civilianGuess,
        label: `${campLabel(campOf(g.role))}去猜词(自己出局) ${POINTS.civilianGuess}`,
      });
    }
  }
  return out;
}

/* ==================================================================== *
 * 本场积分表(纯内存)
 * ==================================================================== */

/** 按座位聚合的排序:总分 → 阵营胜场 → 座位号(稳定的确定性顺序,测试可断言) */
function compareRows(a, b) {
  if (b.points !== a.points) return b.points - a.points;
  if (b.wins !== a.wins) return b.wins - a.wins;
  return a.seat - b.seat;
}

/**
 * 建一张**本场**积分表。
 *
 * 为什么是闭包里的一个 Map,而不是模块级单例:
 *   · 单例会在「退出本局 → 再进来」时把上一场的分带回来(那就变成跨场累计了);
 *   · 屏幕对象每次 mount 建一个,kernel/scoreboard 同生共死,语义最直白 ——
 *     ui/screen.js 里 `this.scoreboard = createScoreboard()` 只有一行。
 *
 * @returns {{
 *   apply:(result:object, cfg?:object)=>{deltas:object[], rows:object[]},
 *   rows:()=>object[], games:()=>number, lastDeltas:()=>object[], reset:()=>void,
 * }}
 */
export function createScoreboard() {
  /** seat → { seat, name, points, plays, wins, lastLabel } */
  const rows = new Map();
  let games = 0;
  let lastDeltas = [];

  function ensure(seat, name) {
    if (!rows.has(seat)) {
      rows.set(seat, { seat, name: name || `${seat + 1}号`, points: 0, plays: 0, wins: 0, lastLabel: '' });
    }
    const r = rows.get(seat);
    if (name) r.name = name;
    return r;
  }

  const board = {
    /**
     * 一局结束后调用:算分 → 累加 → 返回这一局的明细与最新排名。
     * 界面只需要拿返回值重画,不需要自己再维护一份分。
     */
    apply(result, cfg = {}) {
      const deltas = score(result, cfg);
      if (!deltas.length) return { deltas: [], rows: board.rows() };
      games += 1;
      const winner = result.winner === 'undercover' ? 'undercover' : 'civilian';
      for (const s of (result.seats || [])) {
        if (!Number.isInteger(s.seat)) continue;
        const r = ensure(s.seat, s.name);
        r.plays += 1;                       // 参与了本局
        if (campOf(s.role) === winner) r.wins += 1;
      }
      for (const d of deltas) {
        const r = ensure(d.seat);
        r.points += d.delta;
        r.lastLabel = d.label;
      }
      lastDeltas = deltas;
      return { deltas, rows: board.rows() };
    },

    /** 排名(带 rank;顺序 = 总分 → 胜场 → 座位号) */
    rows() {
      return [...rows.values()].sort(compareRows).map((r, i) => ({ ...r, rank: i + 1 }));
    },

    /** 本场已经打了几局(0 = 还没打过,界面据此不显示排名面板) */
    games() { return games; },

    /** 上一局的算分明细(界面的「本局得分」那一块用它) */
    lastDeltas() { return lastDeltas.slice(); },

    /** 清空(界面上的「清空积分」按钮;退出游戏时屏幕自己会丢掉整张表) */
    reset() {
      rows.clear();
      games = 0;
      lastDeltas = [];
    },
  };
  return board;
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
 * @param {object|Array} source 调用方手里现成的那个:
 *   · createScoreboard() 的返回值(有 rows() / games());
 *   · `{ rounds, ranking/rows:[{ seat, name, points }] }` 快照式对象(测试方便);
 *   · 一局的结算 result —— 那时 rounds 记为 1,排名按**那一局**的得分。
 * @param {object} [ctx] 预留;现在不读
 * @returns {{gameId:string, rounds:number, seats:number,
 *            ranking:Array<{seat:number,name:string,score:number}>}}
 */
export function matchSummary(source, ctx = {}) {
  void ctx;
  const toInt = (v) => Math.round(Number(v) || 0);
  let rows = [];
  let rounds = 0;

  if (source && typeof source.rows === 'function') {
    rows = source.rows();                    // createScoreboard()
    rounds = toInt(source.games());
  } else if (source && Array.isArray(source.ranking)) {
    rows = source.ranking;
    rounds = toInt(source.rounds);
  } else if (Array.isArray(source)) {
    rows = source;
    rounds = toInt(rows[0]?.rounds) || 1;
  } else if (source && Array.isArray(source.seats)) {
    // 只打了一局:把这一局的得分按座位汇总成排名
    const deltas = score(source, {});
    const total = new Map();
    for (const s of source.seats) total.set(s.seat, 0);
    for (const d of deltas) total.set(d.seat, (total.get(d.seat) || 0) + d.delta);
    rows = source.seats
      .filter((s) => Number.isInteger(s.seat))
      .map((s) => ({ seat: s.seat, name: s.name, points: total.get(s.seat) || 0 }));
    rounds = 1;
  } else {
    throw new Error('undercover.matchSummary 需要 scoreboard / { rounds, ranking } / 一局结算结果');
  }

  // ⚠️ 一场都没打完不该记分(全员 0 分会凭空排出一个冠军,见 werewolf 的同名注释)
  if (!(rounds > 0)) throw new Error('这一场还没打完任何一局,不记分');
  if (!rows.length) throw new Error('这一场没有排名(积分表是空的)');

  const ranking = rows
    .filter((r) => Number.isInteger(r?.seat))
    .map((r) => ({
      seat: r.seat,
      name: r.name || `${r.seat + 1}号`,
      score: toInt(r.points ?? r.total ?? r.score),
    }))
    // 与 createScoreboard().rows() 同一口径:总分降序、同分座位号升序
    .sort((a, b) => (b.score - a.score) || (a.seat - b.seat));

  return { gameId: 'undercover', rounds: Math.max(1, rounds), seats: Math.max(rows.length, ranking.length), ranking };
}

/* ==================================================================== *
 * 排名面板的 HTML(纯字符串,可在纯 Node 里断言)
 * ==================================================================== */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 把一局的算分明细按座位汇总成「本局得分」的那几行。
 *
 * 为什么明细要按人汇总:一局里一个人可能拿 4 条(参与/阵营胜/存活/投中),
 * 摊成 4 行会把面板撑爆;汇总成一行、后面括号里列原因,既短又能解释分值。
 */
export function summarizeDeltas(deltas = []) {
  const bySeat = new Map();
  for (const d of deltas) {
    if (!bySeat.has(d.seat)) bySeat.set(d.seat, { seat: d.seat, total: 0, labels: [] });
    const row = bySeat.get(d.seat);
    row.total += d.delta;
    row.labels.push(d.label);
  }
  return [...bySeat.values()].sort((a, b) => b.total - a.total || a.seat - b.seat);
}

/**
 * 排名面板的 HTML。
 *
 * 视觉**全部复用现成的 token**(同一套 --panel / --line / --text-dim / 表格排版),
 * 不新造任何「积分榜皮肤」:这个仓库的多游戏界面就是这么统一的
 * (见 styles3d.css 里 `.uc__*` 那段头注释)。
 *
 * @param {object[]} rows createScoreboard().rows() 的返回值
 * @param {{games?:number, deltas?:object[], you?:number|null}} [opts]
 *   games = 本场打了几局;deltas = 上一局明细(可省略);you = 玩家自己的座位(高亮)
 */
export function rankingHtml(rows = [], { games = 0, deltas = [], you = null } = {}) {
  if (!rows.length) return '';
  const body = rows.map((r) => {
    // 玩家自己那一行已经叫「你」了,再加一个(你)是重复的;名字是模型名时才标注
    const youMark = (r.seat === you && r.name !== '你') ? ' <b>(你)</b>' : '';
    const cls = [r.points < 0 ? 'is-neg' : r.points > 0 ? 'is-pos' : '']
      .filter(Boolean).join(' ');
    return `<tr class="${r.seat === you ? 'is-you' : ''}">
      <td>${r.rank}</td>
      <td class="uc__rankName">${esc(r.name)}${youMark}</td>
      <td class="${cls}">${r.points > 0 ? '+' : ''}${r.points}</td>
      <td class="uc__rankMeta">${r.plays ? `${r.plays} 局` : '—'}${r.wins ? ` · 胜 ${r.wins}` : ''}</td>
    </tr>`;
  }).join('');

  // 上一局的明细:名字 +5(参与 +1、平民胜 +3、存活 +1)
  // ⚠️ 一定要标明「本局」:排名那一列是**本场累计**,而这块明细只是**刚打完这一局**
  //    的加减,两者数字不一样(比如累计 +14、本局 +6),不写清楚会被当成算错。
  const detail = deltas.length
    ? `<div class="uc__rankDetail"><div class="uc__rankDetailHead">本局得分</div>${summarizeDeltas(deltas).map((d) => {
      const name = rows.find((r) => r.seat === d.seat)?.name || `${d.seat + 1}号`;
      return `<div class="uc__rankLine"><b>${esc(name)}</b> <span class="${d.total < 0 ? 'is-neg' : 'is-pos'}">${d.total > 0 ? '+' : ''}${d.total}</span> <em>${esc(d.labels.join('、'))}</em></div>`;
    }).join('')}</div>`
    : '';

  return `
    <div class="uc__rankHead">本场积分 <span>${games ? `已打 ${games} 局 · 按总分排名` : '按总分排名'}</span></div>
    <table class="uc__rankTable">
      <thead><tr><th>名次</th><th>玩家</th><th>积分</th><th>战绩</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${detail}
    <div class="uc__rankFoot">
      <button class="btn btn--ghost uc__rankReset" data-rank-reset>清空积分</button>
      <span>积分只算本场(这个游戏里连打的几局),退出游戏就清零。</span>
    </div>`;
}
