/**
 * 平台级**全局排行榜**:把「一场游戏的最终名次」折成全局积分,持久化,并给界面/提示词用。
 *
 * ════════════════════════════════════════════════════════════════════
 * 两层积分(用户口径,先把概念钉死,免得后来人又搅在一起)
 *
 *   ① **局内积分**(每个游戏自己的 scoring.js,已有)
 *        一场游戏(可以连打多个回合)内部的分,只用来算**本场排名**;
 *        只在内存里,换游戏/退出就没了。
 *   ② **全局积分**(这个文件,新增)
 *        一场游戏**结束**时,把本场最终排名按下面的公式折成全局分,
 *        写进**持久化**排行榜(跨游戏、跨会话累计)。
 *
 * 所以这个文件**不做**「一局一算」:它是「一场一算」。
 * 局内积分的计算仍然在各自的 games/<id>/scoring.js 里 —— 这里不重复实现任何
 * 游戏规则,只认一个统一形状:`matchSummary()` 的产物(见下)。
 *
 * ════════════════════════════════════════════════════════════════════
 * 换算公式(用户建议的那一版,这里落地并给出每一权重项的理由)
 *
 *   名次分 rankPoints = 参战人数 - 名次        (第 1 名 = N-1,末名 = 0)
 *   权重   W = 游戏系数 × 回合系数 × 人数系数
 *   全局分  = round(rankPoints × W)
 *
 * ── 为什么名次分是「人数-名次」而不是固定 100/80/60 ──────────────────
 *   人越多,拿第 1 的含金量越高 —— 6 人桌第一和 12 人桌第一不该同分。
 *   末名恒为 0:参与本身不奖励(局内积分已经给过「参与分」了,全局分奖励的是名次)。
 *
 * ── 为什么权重需要「游戏系数」──────────────────────────────────────
 *   狼人杀/阿瓦隆的核心是**欺骗与推理**,信息不对称、每场的决策链更长
 *   (一局要发言、投票、夜间行动十几轮 LLM 调用),策略深度明显高于
 *   「比较描述」的卧底和「打牌」的扑克。给 1.2 而不是 1.5:
 *   这个系数只是**微调含金量**,拉太开会变成「只玩狼人杀排行榜才涨」。
 *   扑克 1.0:牌技很硬,但它有大量运气成分(发牌),不适合给高权重。
 *   卧底 1.0:推理有,但轮次短、随机词对影响大。
 *   ⚠️ 阿瓦隆先按 1.2 预置(与狼人杀同类),它接进注册表后不用再改配置。
 *
 * ── 为什么权重需要「回合系数」1 + 0.05×(回合数-1) ──────────────────
 *   同一场里连打 3 局比只打 1 局更能说明「稳定地名列前茅」,
 *   但回合数不是无限的收益:0.05/回合、上限 +50%(11 回合封顶)。
 *   上限的作用是**防刷分**:否则「开一局 99 回合的狼人杀」会把总分撑爆。
 *
 * ── 为什么权重需要「人数系数」1 + 0.05×(人数-4) ────────────────────
 *   4 人是「一桌人」的基准(多数桌游的最小完整局),每多一个人多 5% 竞争强度,
 *   上限 +50%(14 人封顶)。下限不做另行保护:2 人局的冠军确实只值 0.9 倍,
 *   这是有意的 —— 双人局拿第一的含金量本来就低。
 *
 * ── 为什么最后要 round 成整数 ──────────────────────────────────────
 *   排行榜是**累加**的:小数分会带浮点误差(0.1+0.2≠0.3),而且界面上
 *   「第 1 名 127.30000000000001」很难看。整数分让累加完全确定、可断言。
 *
 * ── 上限夹取的位置 ─────────────────────────────────────────────────
 *   夹的是**系数**,不是最终分。这样「人数 12 × 回合 12」的极端局权重是
 *   1.2×1.5×1.5 = 2.7,而不是 1.2×1.6×1.6 = 3.07 —— 涨得慢、可预测。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么权重放 `global.leaderboard`(而不是 games.<id> 或顶层)
 *
 *   · **不是 games.<id>**:系数要横向比较(狼人杀 vs 扑克),必须放在同一个
 *     能被一起读写的块里;放进每个游戏自己的设置,调一次权重就要改三处。
 *   · **不是配置顶层**:顶层是平台专属字段(workerUrl 那种)的地盘,
 *     tool/configmigrate.mjs 把顶层键钉成了显式清单(只有 global/games/ui)。
 *   · **是用户设置**:所以它可以进配置(会被保存、会被用户改);
 *     而**排行榜数据本身绝不进配置** —— 配置是「用户怎么设置」,
 *     排行榜是「用户玩出了什么」,混在一起会让「重置配置」把战绩也清掉。
 *
 * ════════════════════════════════════════════════════════════════════
 * 持久化:两端行为一致(和 shared/gameStorage.mjs 同一个套路)
 *
 *   桌面版:preload 暴露 getLeaderboard/setLeaderboard/clearLeaderboard,
 *           主进程写到 userData/leaderboard.json(**独立文件**,与 settings.json 同目录)。
 *   网页版:localStorage 的 poker-dealer/leaderboard/v1。
 *   两个适配器返回同样的形状、**任何异常都不外抛**:
 *   写排行榜失败绝不能把一局刚打完的界面搞崩(最坏是丢一次记录,不能白屏)。
 *
 * ⚠️ 版本号:存储的是 `{ v: 1, rows: [...] }`。读到 v 不匹配 → **整份丢弃**
 *    (返回空榜),下一次写入自然覆盖。为什么要这样:排行榜是纯展示数据,
 *    旧格式硬迁移的收益远小于「迁移写错把新版本搞崩」的风险。
 *    键名里也带 v1,所以即使不删旧数据,新版本换个键也能干净地重新开始。
 */

/* ════════════════════════════════════════════════════════════════════
 * 常量
 * ════════════════════════════════════════════════════════════════════ */

/** 存储格式版本。改字段/语义就 +1 —— 读到不匹配的版本直接当空榜。 */
export const LEADERBOARD_VERSION = 1;

/** 网页版 localStorage 键(与桌面的 leaderboard.json 对应) */
export const LEADERBOARD_KEY = 'poker-dealer/leaderboard/v1';

/** 桌面版文件名。与 settings.json / game.json 同目录,用户打开配置文件夹就能看到。 */
export const LEADERBOARD_FILE = 'leaderboard.json';

/** 排行榜最多保留多少行。只截断尾部,不删除正在榜上的人。 */
const DEFAULT_MAX_ROWS = 200;

/**
 * 权重默认值 —— 与 config.cjs / web/pokerApi.js 的 `global.leaderboard` **逐字段一致**。
 * (两端默认值由 tools/configmigrate.mjs 的 deepEqual 盯着;这里再放一份是因为
 *  排行榜模块要能被纯 Node 单独用 —— 不能反过来依赖配置那一层。)
 */
export const LEADERBOARD_DEFAULTS = Object.freeze({
  enabled: true,
  // 游戏系数(见文件头理由)。认不出的游戏用 defaultGameWeight。
  gameWeights: { poker: 1.0, undercover: 1.0, werewolf: 1.2, avalon: 1.2 },
  defaultGameWeight: 1.0,
  // 回合系数:1 + step×(回合数-1),上限 max。
  rounds: { step: 0.05, max: 1.5 },
  // 人数系数:1 + step×(人数-base),上限 max。
  seats: { step: 0.05, base: 4, max: 1.5 },
  maxRows: DEFAULT_MAX_ROWS,
});

/* ════════════════════════════════════════════════════════════════════
 * 小工具(纯函数,测试直接断言)
 * ════════════════════════════════════════════════════════════════════ */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 收敛成有限数字;非数字/NaN/Infinity 一律取 fallback */
function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 非负整数(用于累计值;分数在上层已经 round 过) */
function count(v) {
  return Math.max(0, Math.round(finite(v, 0)));
}

/** 允许负数的整数(名次分/总分理论上都是非负,但别把坏数据悄悄改成 0) */
function int(v) {
  return Math.round(finite(v, 0));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ════════════════════════════════════════════════════════════════════
 * 权重:读配置 + 计算
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 从整份配置里取排行榜权重(**带默认值合并与夹取**)。
 *
 * 为什么要夹取:配置是用户手改得动的(设置面板/直接编辑 settings.json)。
 * 一个写成 50 的游戏系数会让排行榜瞬间失去意义;一个写成 0 的回合步长会让
 * 「多打几局」完全没有收益。这里的夹取范围故意宽松(0~5),只拦明显的手误。
 *
 * @param {object} [cfg] 整份配置(DEFAULT_CONFIG 形状);缺省用默认值
 */
export function leaderboardConfig(cfg) {
  const raw = isPlainObject(cfg?.global?.leaderboard) ? cfg.global.leaderboard : {};
  const d = LEADERBOARD_DEFAULTS;

  const gameWeights = { ...d.gameWeights };
  if (isPlainObject(raw.gameWeights)) {
    for (const [id, v] of Object.entries(raw.gameWeights)) {
      if (!/^[a-z][a-z0-9]*$/.test(id)) continue;   // 只认 gameId 形状的键
      const n = finite(v, NaN);
      if (Number.isFinite(n)) gameWeights[id] = clamp(n, 0, 5);
    }
  }

  const rounds = {
    step: clamp(finite(raw.rounds?.step, d.rounds.step), 0, 0.5),
    max: clamp(finite(raw.rounds?.max, d.rounds.max), 1, 5),
  };
  const seats = {
    step: clamp(finite(raw.seats?.step, d.seats.step), 0, 0.5),
    base: clamp(Math.round(finite(raw.seats?.base, d.seats.base)), 1, 16),
    max: clamp(finite(raw.seats?.max, d.seats.max), 1, 5),
  };

  return {
    enabled: raw.enabled === undefined ? d.enabled : !!raw.enabled,
    gameWeights,
    defaultGameWeight: clamp(finite(raw.defaultGameWeight, d.defaultGameWeight), 0, 5),
    rounds,
    seats,
    maxRows: clamp(Math.round(finite(raw.maxRows, d.maxRows)), 1, 2000),
  };
}

/**
 * 某一场的权重 W = 游戏系数 × 回合系数 × 人数系数。
 *
 * 回合/人数都夹在自己的上限里(见文件头)。返回 4 位小数:
 * 1.2 × 1.05 = 1.2600000000000002 这种浮点尾巴会顺着乘法放大,
 * 先收敛一次,最后 round 出来的分才稳定、可断言。
 *
 * @param {{gameId?:string, rounds?:number, seats?:number}} info
 * @param {object} [cfg] 整份配置(或 leaderboardConfig 的产物 —— 两者都吃)
 */
export function weightOf(info = {}, cfg = null) {
  const w = cfg && isPlainObject(cfg.global?.leaderboard)
    ? leaderboardConfig(cfg)
    : (cfg && isPlainObject(cfg.rounds) && isPlainObject(cfg.seats) ? cfg : leaderboardConfig(cfg));
  const gameId = String(info.gameId || '');
  const game = finite(w.gameWeights[gameId], w.defaultGameWeight);
  const rounds = clamp(count(info.rounds) || 1, 1, 999);
  const roundsW = Math.min(w.rounds.max, 1 + w.rounds.step * (rounds - 1));
  // 人数低于 base 时系数 < 1(双人局冠军含金量更低,这是有意的,见文件头)
  const seats = clamp(count(info.seats) || 1, 1, 64);
  const seatsW = Math.min(w.seats.max, 1 + w.seats.step * (seats - w.seats.base));
  return Math.round(game * roundsW * seatsW * 10000) / 10000;
}

/** 名次分:第 1 名 = 人数-1,末名 = 0。名次/人数越界时夹回合法范围。 */
export function rankPointsOf(rank, seats) {
  const n = clamp(count(seats), 1, 64);
  const r = clamp(Math.round(finite(rank, n)), 1, n);
  return Math.max(0, n - r);
}

/* ════════════════════════════════════════════════════════════════════
 * 一场 → 全局分
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 把每个游戏的 `matchSummary()` 收敛成统一形状。
 *
 * 统一接口(平台只认这一个形状):
 *   {
 *     gameId:  'poker' | 'undercover' | 'werewolf' | ...,
 *     rounds:  这一场打了几个回合(扑克 = 手数,卧底/狼人杀 = 局数),
 *     seats:   参战人数(排名分的分母),
 *     ranking: [{ seat, name, score, text? }]  —— **已经按本场名次排好**,
 *              score 是该游戏自己的本场积分(筹码/分数),text 是展示用可选文本。
 *   }
 *
 * 为什么排名由**游戏**给、而不是平台重算:平台不知道扑克按筹码、
 * 卧底按积分、狼人杀按「参与+阵营胜+MVP」——重算必然要认识三套规则。
 * 平台只做「按名次序换算」这一件与游戏无关的事。
 */
export function normalizeSummary(summary) {
  if (!isPlainObject(summary)) throw new Error('matchSummary 必须是一个对象');
  const gameId = String(summary.gameId || '').trim();
  if (!/^[a-z][a-z0-9]*$/.test(gameId)) throw new Error(`matchSummary.gameId 不合法:${JSON.stringify(summary.gameId)}`);
  const rawList = Array.isArray(summary.ranking) ? summary.ranking : [];
  const ranking = [];
  for (const r of rawList) {
    if (!isPlainObject(r)) continue;
    const seat = Math.round(finite(r.seat, -1));
    if (seat < 0) continue;
    const name = String(r.name ?? '').trim() || `${seat + 1}号`;
    const score = finite(r.score, 0);
    const text = r.text === undefined || r.text === null ? '' : String(r.text).slice(0, 40);
    ranking.push({ seat, name: name.slice(0, 40), score, ...(text ? { text } : {}) });
  }
  if (!ranking.length) throw new Error('matchSummary.ranking 是空的(没打完的一场不该记分)');
  // 名次:分数降序;同分按座位号升序(与三个游戏自己的本场排名口径一致,
  // 所以平台不需要第二套「同分怎么算」的规则 —— 这里只是防御性地重排一次)。
  ranking.sort((a, b) => (b.score - a.score) || (a.seat - b.seat));
  const seats = clamp(count(summary.seats) || ranking.length, 1, 64);
  const rounds = clamp(count(summary.rounds) || 1, 1, 999);
  return { gameId, rounds, seats, ranking };
}

/**
 * 算一场的全局分。
 *
 * @param {object} summary 见 normalizeSummary
 * @param {object} [cfg] 整份配置(取 global.leaderboard 权重)
 * @returns {{ok:true, gameId:string, rounds:number, seats:number, weight:number,
 *            awards:Array<{seat:number,name:string,model:string,score:number,rank:number,
 *                          rankPoints:number,weight:number,points:number}>}
 *          | {ok:false, error:string}}
 */
export function awardMatch(summary, cfg = null) {
  let s;
  try { s = normalizeSummary(summary); } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  const conf = leaderboardConfig(cfg);
  if (!conf.enabled) return { ok: false, error: '排行榜在配置里被关闭了(global.leaderboard.enabled=false)' };
  const weight = weightOf({ gameId: s.gameId, rounds: s.rounds, seats: s.seats }, conf);
  const awards = s.ranking.map((r, i) => {
    const rank = i + 1;
    const rankPoints = rankPointsOf(rank, s.seats);
    return {
      seat: r.seat,
      name: r.name,
      // model 是「这个名字背后是哪家模型」的可选元数据。三个游戏的显示名
      // 本来就跟着模型走(见 ai/portraits.js),拿不到真实 model id 时留空。
      model: String(r.model || '').slice(0, 60),
      score: r.score,
      rank,
      rankPoints,
      weight,
      points: Math.round(rankPoints * weight),
    };
  });
  return { ok: true, gameId: s.gameId, rounds: s.rounds, seats: s.seats, weight, awards };
}

/* ════════════════════════════════════════════════════════════════════
 * 榜:形状 / 累计 / 排序
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 空榜。
 *
 * 行形状(`records` 里每一项):
 *   { name, model, totalPoints, matches, wins,
 *     byGame: { [gameId]: { points, matches, wins } }, lastAt }
 *
 * 为什么用 name 当身份键:三个游戏的座位名**本来就跟着模型走**
 * (ai/portraits.js 的 displayNameForModel,同桌同名自动加序号),
 * 所以「同一个名字 = 同一位玩家/模型」。加账号体系之前,这是唯一稳定的键;
 * 而且换设备/换游戏也认得出来(名字来自模型,不来自本局座位号)。
 */
export function emptyBoard() {
  return { v: LEADERBOARD_VERSION, updatedAt: 0, rows: [] };
}

/** 把一行坏数据洗干净(返回 null = 这一行丢掉,别让一条坏行把整榜搞崩) */
function cleanRow(r) {
  if (!isPlainObject(r)) return null;
  const name = String(r.name ?? '').trim().slice(0, 40);
  if (!name) return null;
  const byGame = {};
  if (isPlainObject(r.byGame)) {
    for (const [id, v] of Object.entries(r.byGame)) {
      if (!/^[a-z][a-z0-9]*$/.test(id) || !isPlainObject(v)) continue;
      byGame[id] = { points: int(v.points), matches: count(v.matches), wins: count(v.wins) };
    }
  }
  return {
    name,
    model: String(r.model ?? '').slice(0, 60),
    totalPoints: int(r.totalPoints),
    matches: count(r.matches),
    wins: count(r.wins),
    byGame,
    lastAt: count(r.lastAt),
  };
}

/**
 * 读到的原始值 → 榜。
 *
 * @param {object|string|null} raw 存储里拿到的对象,或它的 JSON 文本
 * @returns {{v:number, updatedAt:number, rows:object[]}|null}
 *   null = **这份数据不能用**(版本不符 / 结构不对 / 坏 JSON)。
 *   为什么返回 null 而不是空榜:调用方要能区分「没有数据」和「有数据但坏了」,
 *   虽然目前两者都当空榜处理 —— 但测试要能断言「版本不匹配确实被丢弃」。
 */
export function boardFromRaw(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!isPlainObject(obj)) return null;
  // ⚠️ 版本不符 → 直接丢。排行榜是纯展示数据,旧格式硬迁移的风险
  //    (迁移写错把新版本搞崩)远大于「少几行历史战绩」。
  if (obj.v !== LEADERBOARD_VERSION) return null;
  if (!Array.isArray(obj.rows)) return null;
  const rows = [];
  for (const r of obj.rows) {
    const row = cleanRow(r);
    if (row) rows.push(row);
  }
  return { v: LEADERBOARD_VERSION, updatedAt: count(obj.updatedAt), rows };
}

/** 榜 → 可写盘的形状(带版本号) */
export function encodeBoard(board, now = Date.now()) {
  const b = board && Array.isArray(board.rows) ? board : emptyBoard();
  return {
    v: LEADERBOARD_VERSION,
    updatedAt: count(now),
    rows: b.rows.map((r) => ({
      name: r.name,
      model: r.model || '',
      totalPoints: int(r.totalPoints),
      matches: count(r.matches),
      wins: count(r.wins),
      byGame: Object.fromEntries(Object.entries(r.byGame || {}).map(([id, v]) => [id, {
        points: int(v?.points), matches: count(v?.matches), wins: count(v?.wins),
      }])),
      lastAt: count(r.lastAt),
    })),
  };
}

/**
 * 排行榜排序:**总分降序**。同分规则(明确写下来,测试盯着):
 *   ① 胜场多的在前 —— 同样的分,拿过更多第一说明含金量更高;
 *   ② 场次少的在前 —— 同样的分,用更少的场次拿到,效率更高;
 *   ③ 名字按**码位**升序 —— 最后一条只是为了「顺序稳定」,不用 localeCompare:
 *      它依赖运行环境的 ICU 数据,同一个名字在桌面版/网页版/不同系统上
 *      可能排出不同顺序,而排行榜的截图与测试需要确定性。
 */
export function sortBoardRows(rows = []) {
  return [...rows].sort((a, b) => (
    (b.totalPoints - a.totalPoints)
    || (b.wins - a.wins)
    || (a.matches - b.matches)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  ));
}

/** 给界面用:排序 + rank */
export function boardRows(board) {
  return sortBoardRows(board?.rows || []).map((r, i) => ({
    ...r,
    rank: i + 1,
    byGame: { ...r.byGame },
  }));
}

/**
 * 把一场的 awards 累加进榜(返回**新**榜,不改入参)。
 *
 * @param {object} board 原榜
 * @param {object[]} awards awardMatch().awards
 * @param {{gameId:string, now?:number, maxRows?:number}} opts
 */
export function applyAwards(board, awards = [], { gameId = '', now = Date.now(), maxRows = DEFAULT_MAX_ROWS } = {}) {
  const base = board && Array.isArray(board.rows) ? board : emptyBoard();
  const byName = new Map(base.rows.map((r) => [r.name, {
    ...r,
    byGame: Object.fromEntries(Object.entries(r.byGame || {}).map(([id, v]) => [id, { ...v }])),
  }]));

  // 同一场里出现重名(理论上不会 —— 一桌名字唯一)只算**名次最好的那一个**:
  // 否则一场会被记成两场(matches +2),把「场次」这个统计悄悄弄错。
  const perName = new Map();
  for (const a of awards) {
    const prev = perName.get(a.name);
    if (!prev || a.rank < prev.rank) perName.set(a.name, a);
  }

  for (const a of perName.values()) {
    const rec = byName.get(a.name) || {
      name: a.name, model: a.model || '', totalPoints: 0, matches: 0, wins: 0, byGame: {}, lastAt: 0,
    };
    rec.totalPoints += int(a.points);
    rec.matches += 1;
    if (a.rank === 1) rec.wins += 1;
    if (a.model) rec.model = String(a.model).slice(0, 60);
    const g = rec.byGame[gameId] || { points: 0, matches: 0, wins: 0 };
    g.points += int(a.points);
    g.matches += 1;
    if (a.rank === 1) g.wins += 1;
    rec.byGame[gameId] = g;
    rec.lastAt = count(now);
    byName.set(a.name, rec);
  }

  const rows = sortBoardRows([...byName.values()]).slice(0, clamp(count(maxRows) || DEFAULT_MAX_ROWS, 1, 2000));
  return { v: LEADERBOARD_VERSION, updatedAt: count(now), rows };
}

/* ════════════════════════════════════════════════════════════════════
 * 存储适配器(桌面 IPC / 网页 localStorage / 什么都没有)
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 桌面版:走 preload 的 IPC。
 *
 * 用**能力探测**而不是判断是不是 Electron:老 preload 没有这三个方法时,
 * 这里应该退回 localStorage,而不是抛「undefined is not a function」。
 * 三个方法都返回 Promise(主进程读一个小 json 文件),所以统一 await。
 */
function ipcStorage(api) {
  return {
    kind: 'ipc',
    async read() {
      try { return await api.getLeaderboard() || null; } catch { return null; }
    },
    async write(obj) {
      try { return (await api.setLeaderboard(obj)) || { ok: true }; } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    async clear() {
      try { return (await api.clearLeaderboard()) || { ok: true }; } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  };
}

/**
 * 网页版:localStorage。
 *
 * ⚠️ 三个坑(与 shared/gameStorage.mjs 里写的是同一批,别只修一边):
 *   1. 隐私模式下读 `globalThis.localStorage` 这个 getter 本身就可能抛;
 *   2. 配额满时 setItem 抛 —— 接住并返回可读原因,不能让结算流程崩;
 *   3. 别人手改过 / 旧版本写下的坏 JSON —— parse 失败当没有(由 boardFromRaw 判版本)。
 */
function localStorageStorage(ls) {
  return {
    kind: 'localStorage',
    async read() {
      try {
        const raw = ls.getItem(LEADERBOARD_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    async write(obj) {
      try {
        ls.setItem(LEADERBOARD_KEY, JSON.stringify(obj));
        return { ok: true, path: 'localStorage' };
      } catch (err) {
        return { ok: false, error: `localStorage 写入失败:${err?.name || ''} ${err?.message || err}`.trim() };
      }
    },
    async clear() {
      try { ls.removeItem(LEADERBOARD_KEY); return { ok: true }; } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  };
}

/** 拿不到任何存储时的兜底:读 → null、写 → 成功但什么都不做(语义是「不记录」,不是「报错」) */
function nullStorage(reason) {
  return {
    kind: 'none',
    reason,
    async read() { return null; },
    async write() { return { ok: true, path: 'none' }; },
    async clear() { return { ok: true }; },
  };
}

/**
 * 选一个可用的适配器。
 *
 * 优先级:**桌面 IPC 优先** —— 网页版(pokerApi.js)也会装 window.pokerAPI,
 * 但它没有 getLeaderboard;探测不到就落到 localStorage。
 * 反过来的话,桌面版会误走 localStorage 分支(清缓存战绩就没了),
 * 与 shared/gameStorage.mjs 的选择顺序保持一致。
 *
 * @param {object} [win] 便于测试注入(默认 globalThis)
 */
export function resolveLeaderboardStorage(win = globalThis) {
  const api = win?.pokerAPI;
  if (api && typeof api.getLeaderboard === 'function') return ipcStorage(api);
  let ls = null;
  try { ls = win?.localStorage || null; } catch { ls = null; }
  if (ls && typeof ls.getItem === 'function') return localStorageStorage(ls);
  return nullStorage('这个环境没有可用的本地存储(桌面版 preload 没接上 / 浏览器禁用了存储)');
}

/* ════════════════════════════════════════════════════════════════════
 * 对外:读 / 记一场 / 清空
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 读排行榜。永远返回一个可用的榜(读不到/坏了 = 空榜),**不抛**。
 * @param {object} [win]
 */
export async function loadLeaderboard(win = globalThis) {
  const storage = resolveLeaderboardStorage(win);
  try {
    const decoded = boardFromRaw(await storage.read());
    return decoded || emptyBoard();
  } catch {
    return emptyBoard();
  }
}

/**
 * 一场游戏结束 → 算分 → 累加 → 写盘。
 *
 * @param {object} opts
 * @param {object} opts.summary 游戏的 matchSummary() 产物
 * @param {object} [opts.cfg] 整份配置(取权重)
 * @param {object} [opts.win]   便于测试注入
 * @param {object} [opts.storage] 便于测试注入(不传就按 win 解析)
 * @param {number} [opts.now]
 * @returns {Promise<{ok:boolean, error?:string, gameId?:string, awards?:object[],
 *                    board?:object, rows?:object[]}>} **永不抛**
 */
export async function recordMatch({ summary, cfg = null, win = globalThis, storage = null, now = Date.now() } = {}) {
  const aw = awardMatch(summary, cfg);
  if (!aw.ok) return aw;
  const st = storage || resolveLeaderboardStorage(win);
  let board = emptyBoard();
  try {
    board = boardFromRaw(await st.read()) || emptyBoard();
  } catch { board = emptyBoard(); }
  const conf = leaderboardConfig(cfg);
  const next = applyAwards(board, aw.awards, { gameId: aw.gameId, now, maxRows: conf.maxRows });
  let wrote;
  try {
    wrote = await st.write(encodeBoard(next, now));
  } catch (err) {
    wrote = { ok: false, error: err?.message || String(err) };
  }
  if (!wrote || wrote.ok === false) {
    return { ok: false, error: wrote?.error || '排行榜写入失败', gameId: aw.gameId, awards: aw.awards, board: next };
  }
  return {
    ok: true, gameId: aw.gameId, awards: aw.awards, board: next, rows: boardRows(next),
  };
}

/** 清空排行榜(界面上的「清空」入口)。删不掉时如实返回失败,不假装成功。 */
export async function clearLeaderboard(win = globalThis) {
  const st = resolveLeaderboardStorage(win);
  try { return await st.clear() || { ok: true }; } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ════════════════════════════════════════════════════════════════════
 * 提示词:【你的最终目标】+ 当前本场排名
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 拼【你的最终目标】那一段(三个游戏**共用同一份文案**,只换数据)。
 *
 * 用户口径(原话):「不管任何游戏,每个模型最终目的都是取得尽量高的名次,
 * 不仅仅是赢下某一小局」。所以这一段必须:
 *   ① 明确否定「只赢这一局」,把目标抬到**本场排名**;
 *   ② 把**当前本场排名**喂给它(谁第几名、多少分、自己第几);
 *   ③ 给策略指引:落后要冒险翻盘、领先要守住位置。
 *
 * ⚠️ 信息隔离的底线:这里只允许出现**公开信息** —— 座位号 / 名字 / 本场积分。
 *    身份、词、手牌一律不进来。三个游戏的调用方都只传这几项,
 *    测试则从「这一段里有没有出现别人的词/身份/底牌」反向断言。
 *
 * @param {Array<{seat:number,name:string,score:number,text?:string}>} rows 本场排名(任意顺序,内部会重排)
 * @param {object} [opts]
 * @param {number|null} [opts.selfSeat] 自己坐几号(用来写「你第几名」)
 * @param {number} [opts.rounds] 本场已经打完几个回合(0 = 还没打完过)
 * @param {string} [opts.scoreUnit] 分数单位(卧底/狼人杀「分」,扑克「筹码」)
 * @param {boolean} [opts.showSeat] 是否写「几号」。扑克刻意不写(见 agent.js 的注释:
 *   座位号和位置标签混在一起会让模型认知错乱),只写名字。
 * @param {string} [opts.title] 这一榜叫什么(默认「本场积分」)
 */
export function matchGoalBlock(rows = [], {
  selfSeat = null, rounds = 0, scoreUnit = '分', showSeat = true, title = '本场积分',
} = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number.isFinite(Number(r.seat)) && Number.isFinite(Number(r.score)))
    .map((r) => ({
      seat: Number(r.seat),
      name: String(r.name || `${Number(r.seat) + 1}号`).slice(0, 24),
      score: Number(r.score),
      text: r.text ? String(r.text).slice(0, 30) : '',
    }))
    .sort((a, b) => (b.score - a.score) || (a.seat - b.seat));

  const fmt = (r) => (r.text || `${Math.round(r.score)}${scoreUnit}`);
  const who = (r) => (showSeat ? `${r.seat + 1}号(${r.name})` : r.name);

  const lines = [
    '【你的最终目标】',
    '· 你的目标不是赢下这一局,而是**本场排名尽量靠前**。',
  ];
  if (!list.length || !(Number(rounds) > 0)) {
    // 第一局开始前:排名还不存在。仍然要把「目标是什么」说清楚 ——
    // 这一段的意义不只是给数字,而是改变它整场的取舍。
    lines.push('· 本场还没有打完的局,所以现在还没有名次 —— 先赢下这一局,把名次立起来。');
  } else {
    const selfIdx = list.findIndex((r) => r.seat === selfSeat);
    const parts = [];
    if (selfIdx >= 0) parts.push(`你第 ${selfIdx + 1} 名(${fmt(list[selfIdx])})`);
    list.forEach((r, i) => {
      if (r.seat === selfSeat) return;
      parts.push(`第 ${i + 1} 名是 ${who(r)}(${fmt(r)})`);
    });
    lines.push(`· 当前${title}(公开信息):${parts.join(';')}。`);
  }
  lines.push('· 因此:落后时要更愿意冒险去翻盘;领先时保住位置比多赢一局更重要。');
  return lines.join('\n');
}

/* ════════════════════════════════════════════════════════════════════
 * 界面:排行榜的 HTML(纯字符串,可在纯 Node 里断言)
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 全局排行榜的 HTML。
 *
 * 视觉**完全复用**现成的 `.uc__rank*` 那一套(见 styles3d.css 里那段头注释:
 * 这个仓库的多游戏界面就是这么统一的)——不新造「排行榜皮肤」。
 *
 * @param {object[]} rows boardRows() 的返回值(已排序、带 rank)
 * @param {{gameNames?:Record<string,string>, limit?:number}} [opts]
 *   gameNames = gameId → 中文短名(由宿主从注册表给,模块不 import 注册表)
 */
export function leaderboardHtml(rows = [], { gameNames = {}, limit = 0 } = {}) {
  const head = '<div class="uc__rankHead">全局排行榜 <span>本场名次 × 权重;按总分排名</span></div>';
  if (!rows.length) {
    return `${head}<div class="uc__rankDetail">还没有战绩 —— 打完一场(同一场连打的几局算一场)就会记在这里。</div>
      <div class="uc__rankFoot"><span>只记名次分,不记每一局的过程。</span></div>`;
  }
  const list = limit > 0 ? rows.slice(0, limit) : rows;
  const body = list.map((r) => {
    const games = Object.entries(r.byGame || {})
      .filter(([, v]) => v && v.matches > 0)
      .sort((a, b) => (b[1].points - a[1].points) || (a[0] < b[0] ? -1 : 1))
      .map(([id, v]) => `${esc(gameNames[id] || id)} ${v.points > 0 ? '+' : ''}${v.points}`)
      .join(' · ');
    return `<tr class="${r.rank === 1 ? 'is-you' : ''}">
      <td>${r.rank}</td>
      <td class="uc__rankName">${esc(r.name)}</td>
      <td class="${r.totalPoints > 0 ? 'is-pos' : ''}">${r.totalPoints > 0 ? '+' : ''}${r.totalPoints}</td>
      <td class="uc__rankMeta">${r.matches} 场${r.wins ? ` · 胜 ${r.wins}` : ''}</td>
      <td class="uc__rankMeta">${games || '—'}</td>
    </tr>`;
  }).join('');
  return `${head}
    <table class="uc__rankTable">
      <thead><tr><th>名次</th><th>玩家</th><th>总分</th><th>战绩</th><th>分游戏</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="uc__rankFoot">
      <button class="btn btn--ghost uc__rankReset" data-board-clear>清空排行榜</button>
      <span>全局分只在<b>一场结束</b>时结算(扑克 = 全场打完;卧底/狼人杀 = 退出本场)。</span>
    </div>`;
}
