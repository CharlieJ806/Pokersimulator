/**
 * 「狼人杀」的**信息出口** —— 每个座位能看到的全部内容,只有这个文件产。
 *
 * ────────────────────────────────────────────────────────────────
 * 这个文件为什么是整个游戏最重要的地方
 *
 * 这个游戏的全部乐趣来自「我知道的和你不一样」。一旦某个 AI(或玩家模式的渲染层)
 * 拿到了别人的身份,游戏就塌了 —— 而且**塌得没有任何报错**:AI 会突然变得神准,
 * 看起来像模型变聪明了。研究文档把这条写成一句话:
 *   「隔离不能靠『请不要作弊』,要靠**上下文里根本没有那个字段**。」
 *
 * 所以照卧底那套(两个游戏共用同一个范式):
 *   · `buildView(state, seat)` 是 AI 与渲染层的**唯一**信息出口;
 *   · 它返回的对象里**根本不存在**别人的 roles 字段 —— 不是「有但藏起来」,
 *     而是**取的时候就没有**(玩家模式也是这条:渲染前就不传);
 *   · 上帝模式另走 `buildGodView(state)`,它是唯一会读 roles 的地方 ——
 *     而它只在**观看 AI** 模式下被调用。
 *
 * ⚠️ 别把「过滤」写成 `delete view.seats[i].role`:那还是先取了再删,
 *    任何一次拷贝 / 日志 / JSON.stringify(view) 都可能把删掉的东西带回去。
 *    这里每个字段都是**显式新建**的,state 对象从头到尾没被展开过。
 *
 * ────────────────────────────────────────────────────────────────
 * 分层(用户点名的四条)
 *   · 狼人   :知道彼此是谁(me.teammates)+ 今晚刀了谁(faction 账本);
 *   · 预言家 :知道自己的查验结果(me.checks);
 *   · 女巫   :知道药的使用情况(me.witch)+ 今晚谁被刀(她本来就知道);
 *   · 平民   :什么都不知道 —— me 里除了自己的身份,没有一个字段是「别人」的。
 *
 * ⚠️ 「公开角色配置只发数量、不发座位」的落点在 roster 这个字段:
 *    它只有 { 狼人×2、预言家×1 … } 这样的计数,没有座位,也没有「还活着几个」。
 *    这样 AI 能算「还剩几只狼」,但不会误以为「7 号是狼」是系统告诉它的。
 */

import {
  aliveSeatsOf, dawnOf, speechesOf, votesOf, rosterText, roleLabel, isGod,
  winConditionText, winConditionHint,
} from './engine/kernel.js';

/** 名字:内核只存字符串,取不到就给座位号 */
function nameOf(state, seat) {
  return state.names?.[seat] || `${seat + 1}号`;
}

/**
 * 公开的座位列表 —— **只有编号、名字、死活**。
 * 别人的身份不在这个对象里,也不在随后拼接的任何一处。
 */
function publicSeats(state) {
  return state.alive.map((alive, seat) => ({ seat, name: nameOf(state, seat), alive: !!alive }));
}

/** 公开死讯(只有「谁在第几天出局」,没有身份、没有死因) */
function publicDeaths(state) {
  const out = [];
  for (const e of state.events) {
    if (e.kind !== 'dawn') continue;
    for (const s of (e.deaths || [])) out.push({ day: e.day, seat: s });
  }
  return out;
}

/** 公开收出局(被放逐的) */
function publicExiles(state) {
  return state.events.filter((e) => e.kind === 'exile')
    .map((e) => ({ day: e.day, seat: e.seat, votes: e.votes }));
}

/** 公开发言:[{day, seat, say:[]}] */
function publicSpeeches(state) {
  return state.events.filter((e) => e.kind === 'speech')
    .map((e) => ({ day: e.day, seat: e.seat, say: (e.say || []).slice(), quality: e.quality }));
}

/** 公开票型:[{day, from, to, reason}] to=null 表示弃票 */
function publicVotes(state) {
  return state.events.filter((e) => e.kind === 'vote')
    .map((e) => ({ day: e.day, from: e.seat, to: e.target, reason: e.reason || '' }));
}

/** 每天的汇总(死了谁 / 平票没有 / 谁被放逐 / 票型) */
function publicDays(state) {
  const days = [];
  const maxDay = Math.max(1, state.day | 0);
  for (let d = 1; d <= maxDay; d++) {
    const dawn = dawnOf(state, d)[0];
    const speeches = speechesOf(state, d);
    if (!dawn && !speeches.length) continue;
    const exit = publicExiles(state).find((e) => e.day === d) || null;
    const tie = state.events.some((e) => e.kind === 'tie' && e.day === d);
    const votes = publicVotes(state).filter((v) => v.day === d);
    days.push({
      day: d,
      deaths: dawn ? (dawn.deaths || []).slice() : [],
      peaceful: !!dawn && (dawn.deaths || []).length === 0,
      exiled: exit ? exit.seat : null,
      tie,
      votes,
    });
  }
  return days;
}

/* ------------------------------------------------------------ 声明提取 */

/**
 * 从公开发言里抽出**声明**(不是事实,只是「谁说了什么」)。
 *
 * 为什么要单独抽一层:研究文档把「把声明当事实」列为最严重的坑之一 ——
 * 「2 号是预言家」和「2 号**声称**自己是预言家」在提示词里必须长得不一样。
 * 抽出来的东西全部带 `by`(谁说的)与 `day`,进提示词的【只是听说的声明】那一段。
 *
 * ⚠️ 这是**启发式**提取:漏抽是常态(模型会换说法),所以提示词里还要写一句
 *    「下面这段是机器提取的,可能不全;不要因为某条没被提取到就当成没发生」。
 */
export function extractClaims(state) {
  const out = [];
  for (const e of state.events) {
    if (e.kind !== 'speech') continue;
    const text = (e.say || []).join(' ');
    if (!text) continue;
    // 「我是预言家 / 我真的是女巫」
    const roleRe = /我(?:就|真|其实|的确)?\s*是\s*(?:一个|一名|个)?\s*(预言家|女巫|平民|村民|好人|狼人|狼)/g;
    let m;
    while ((m = roleRe.exec(text))) {
      out.push({ day: e.day, by: e.seat, kind: 'role', value: m[1], text: `${e.seat + 1}号声称自己是${m[1]}` });
    }
    // 「我验了 3 号,是狼 / 好人」
    const chkRe = /(?:我)?(?:昨晚|夜里|第\s*\d+\s*夜)?\s*验(?:了|过)?\s*(\d+)\s*号[^。;；]{0,12}?(狼人|狼|好人|金水|查杀)/g;
    while ((m = chkRe.exec(text))) {
      out.push({
        day: e.day, by: e.seat, kind: 'check', target: Number(m[1]) - 1,
        value: /狼|查杀/.test(m[2]) ? 'wolf' : 'good',
        text: `${e.seat + 1}号声称验了 ${m[1]} 号 → ${/狼|查杀/.test(m[2]) ? '狼人' : '好人'}`,
      });
    }
    // 「我怀疑 5 号 / 我想出 5 号」
    const susRe = /(?:我)?(?:最)?(?:怀疑|想出|先出|投)\s*(\d+)\s*号/g;
    while ((m = susRe.exec(text))) {
      out.push({
        day: e.day, by: e.seat, kind: 'suspect', target: Number(m[1]) - 1,
        text: `${e.seat + 1}号认为 ${m[1]} 号可疑`,
      });
    }
  }
  return out;
}

/** 同一座位是否投过票 / 今天说过什么 —— 给「投票须与发言一致」用 */
function mySpeechToday(state, seat) {
  const today = state.day;
  return state.events
    .filter((e) => e.kind === 'speech' && e.day === today && e.seat === seat)
    .flatMap((e) => e.say || []);
}

/** 今天公开表态要投谁(发言事件里的 stake);没表态返回 null */
function myStakeToday(state, seat) {
  const e = state.events
    .filter((x) => x.kind === 'speech' && x.day === state.day && x.seat === seat)
    .pop();
  return e && Number.isInteger(e.stake) ? e.stake : null;
}

/* ------------------------------------------------------------ 座位视角 */

/**
 * 某个座位视角的完整信息。
 *
 * @param {object} state 内核 state
 * @param {number} seat 视角座位
 * @param {{matchStandings?:{rounds:number,ranking:Array<{seat:number,name:string,score:number}>}}} [opts]
 *   matchStandings = 本场积分榜的**公开快照**(座位 / 名字 / 积分)。
 *   它由 runner 从屏幕的 MatchStandings 取来 —— 积分榜本来就挂在界面上给所有人看,
 *   所以它是公开信息;而身份/队友/刀口/药水**不在这里**(那才是这个游戏的命门)。
 * @returns {object} 可以直接交给 agent / 渲染层 / JSON.stringify 的纯视图
 */
export function buildView(state, seat, opts = {}) {
  const me = Number(seat) || 0;
  const alive = !!state.alive[me];
  const aliveSeats = aliveSeatsOf(state);
  const role = state.roles[me];
  const isWolf = role === 'werewolf';
  const isSeer = role === 'seer';
  const isWitch = role === 'witch';

  // ── 私有信息:每一块都**只在自己的分支里新建**,没有一条「先取全表再删」
  const meBlock = {
    seat: me,
    name: nameOf(state, me),
    alive,
    role,
    roleLabel: roleLabel(role),
    /** 神职 / 平民 / 狼 —— 给提示词挑措辞用(这是**自己**的阵营,不是别人的) */
    side: isWolf ? 'werewolf' : 'good',
    isGod: isGod(role),
  };
  if (isWolf) {
    // 狼人:知道彼此是谁(包括已经出局的 —— 死人不会因为出局就不再是狼)
    meBlock.teammates = state.roles
      .map((r, s) => (r === 'werewolf' && s !== me ? s : -1))
      .filter((s) => s >= 0)
      .map((s) => ({ seat: s, name: nameOf(state, s), alive: !!state.alive[s] }));
    // 狼队今晚商定的刀口(账本里 faction 那一条)
    const kills = state.events.filter((e) => e.visibility === 'faction' && e.kind === 'wolfKill');
    meBlock.wolfKills = kills.map((e) => ({ day: e.day, target: e.target ?? null }));
  }
  if (isSeer) {
    // 预言家:只知道自己验过谁、结果是什么
    meBlock.checks = state.checks
      .filter((c) => c.by === me)
      .map((c) => ({ day: c.day, target: c.target, name: nameOf(state, c.target), result: c.result }));
  }
  if (isWitch) {
    // 女巫:知道药的情况,以及**今晚谁被刀**(她要在救与不救之间选)
    meBlock.witch = {
      antidote: !!state.witch.antidote,
      poison: !!state.witch.poison,
      killTarget: state.phase === 'night' && state.nightStep === 'witch'
        ? (state.night.kill ?? null) : null,
      savedTonight: state.phase === 'night' ? !!state.night.saved : false,
    };
  }

  return {
    game: 'werewolf',
    seat: me,
    day: state.day,
    phase: state.phase,
    /** 夜里的子阶段(wolves / seer / witch / done);不在夜里是 null */
    nightStep: state.phase === 'night' ? state.nightStep : null,
    maxDays: state.config.maxDays,
    /**
     * ★ 公开角色配置:**只有数量、没有座位**(研究文档的硬机制)。
     * 它同时告诉 AI「这局有哪些角色」和「开局各几个」,但绝不点名谁是谁。
     */
    roster: { ...state.roster },
    rosterText: rosterText(state.roster),
    /** ★ 当前胜负规则(提示词必须写清,否则狼队会乱刀) */
    winCondition: state.config.winCondition,
    winConditionText: winConditionText(state.config.winCondition),
    winConditionHint: winConditionHint(state.config.winCondition),

    me: meBlock,
    /**
     * 本场积分榜(公开信息;还没打完一局时为空数组 + rounds:0)。
     * ⚠️ 只有 seat / name / score 三样 —— 排名是公开的,身份不是。
     */
    matchStandings: opts.matchStandings || null,
    /** 公开座位表(没有身份) */
    seats: publicSeats(state),
    aliveSeats,
    aliveCount: aliveSeats.length,
    deaths: publicDeaths(state),
    exiles: publicExiles(state),
    speeches: publicSpeeches(state),
    votes: publicVotes(state),
    days: publicDays(state),
    claims: extractClaims(state),
    /** 我今天说过的话(投票阶段要它来保证「投票与发言一致」) */
    mySpeechToday: mySpeechToday(state, me),
    /**
     * 我今天公开表态要投的人(发言里的 stake)。
     * 投票阶段用它是为了落实「投票必须与发言一致」——
     * 与发言不符时必须在 changed_from 里交代,否则就是不认自己说过的话。
     */
    myStakeToday: myStakeToday(state, me),

    /** 白天发言:现在轮到谁 */
    currentSpeaker: state.phase === 'day' ? (state.order[state.orderIdx] ?? null) : null,
    /** 投票阶段:能投谁(不含自己、不含已出局) */
    voteCandidates: state.phase === 'vote' && alive
      ? state.alive.map((a, s) => (a && s !== me ? s : -1)).filter((s) => s >= 0)
      : [],
    pendingVoters: state.phase === 'vote'
      ? aliveSeats.filter((s) => !votesOf(state, state.day).some((e) => e.seat === s))
      : [],
    /** 今天已经投过的人(用来判断自己是否还能投) */
    vottedToday: votesOf(state, state.day).map((e) => e.seat),
    winner: state.winner,
    endReason: state.endReason,
  };
}

/**
 * 上帝视角(**观看 AI 模式专用**)。
 *
 * 这是**唯一**读全员 roles / checks / witch 的地方。玩家模式绝对不许调它 ——
 * ui/screen.js 里只有一个分支会走到这里(见那里的注释与测试)。
 */
export function buildGodView(state) {
  const base = buildView(state, state.config.humanSeat ?? 0);
  return {
    ...base,
    god: true,
    rosterText: rosterText(state.roster),
    /** 整张身份表 —— 只给观看模式 */
    seats: state.alive.map((a, s) => ({
      seat: s,
      name: nameOf(state, s),
      alive: !!a,
      role: state.roles[s],
      roleLabel: roleLabel(state.roles[s]),
      side: state.roles[s] === 'werewolf' ? 'werewolf' : 'good',
    })),
    /** 夜里的真相:刀口 / 救没救 / 毒了谁(上帝看得到) */
    night: {
      step: state.nightStep,
      kill: state.night.kill ?? null,
      saved: !!state.night.saved,
      poison: state.night.poison ?? null,
    },
    checks: state.checks.map((c) => ({ ...c, byName: nameOf(state, c.by), targetName: nameOf(state, c.target) })),
    witch: { ...state.witch },
    candidatePool: aliveSeatsOf(state),
  };
}

/**
 * 渲染层拿哪一份视图 —— **玩家模式与观看模式在这里分流**。
 *
 * 这是「渲染前就不取」的落实点:玩家模式走 buildView(只含自己的身份),
 * 观看模式才走 buildGodView(全量)。屏幕层**只**通过这个函数取数据,
 * 所以「渲染了再 CSS 隐藏」那条路根本不存在(隐藏得再干净,数据也已经进了 DOM)。
 *
 * @param {object} state
 * @param {{mode?:'watch'|'join', humanSeat?:number|null}} opts
 */
export function buildRenderView(state, { mode = 'watch', humanSeat = null } = {}) {
  if (mode === 'join') return buildView(state, humanSeat ?? state.config.humanSeat ?? 0);
  return buildGodView(state);
}

/**
 * 场景核心(Table3D)要的那份 view。
 *
 * ⚠️ 这不是「游戏 view」,而是一个**适配层**:sceneCore 是通用的,它要的是
 *    每个人「在不在桌上 / 还活着吗 / 现在轮到谁」这类通用字段(见
 *    sceneCore/table.js 的 syncSeats)。所以这里把狼人杀的存活状态翻译过去:
 *      · 出局的人 stack=0 + folded=true → 立绘变淡、头顶指示器收起;
 *      · actor = 当前发言 / 需要投票的人;
 *      · button = -1(狼人杀没有庄家按钮,场景核心会自己隐藏它);
 *      · positions 留空(没有大小盲)。
 *    这里同样**不含任何身份** —— 道具层要显示身份时,由观看模式单独塞进 ctx,
 *    不经过这个对象(见 props/werewolf 的道具层)。
 * @param {object} state
 * @param {{actor?:number|null}} [opts]
 */
export function buildTableViewModel(state, { actor = null } = {}) {
  return {
    players: state.alive.map((alive, seat) => ({
      seat,
      name: nameOf(state, seat),
      inHand: true,
      stack: alive ? 1000 : 0,
      folded: !alive,
      hole: [],
    })),
    actor: actor ?? null,
    button: -1,
    handOver: state.phase === 'end',
    positions: {},
  };
}
