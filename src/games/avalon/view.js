/**
 * 「阿瓦隆」的**信息出口** —— 每个座位能看到的全部内容,只有这个文件产。
 *
 * ────────────────────────────────────────────────────────────────
 * 这个文件为什么是整个游戏最重要的地方
 *
 * 这个游戏的全部乐趣来自「我知道的和你不一样」:
 *   · 梅林知道所有坏人(莫德雷德除外),但一旦被人看出来就会被刺杀;
 *   · 派西维尔知道「这两个人里有一个是梅林、一个是莫甘娜」,但**分不清谁是谁**;
 *   · 坏人之间互相认识,但要装成什么都不知道;
 *   · 忠臣什么都不知道,只能靠票型和任务结果推。
 *
 * 隔离一旦漏了,塌得没有任何报错:坏人会突然开始「配合」,梅林会突然开始
 * 精准地避开某个座位 —— 看起来像模型变聪明了。所以照狼人杀那套:
 *   · `buildView(state, seat)` 是 AI 与渲染层的**唯一**信息出口;
 *   · 它返回的对象里**根本不存在**别人的 roles 字段 —— 不是「有但藏起来」,
 *     而是**取的时候就没有**;
 *   · 上帝模式另走 `buildGodView(state)`,它是唯一会读 roles 的地方 ——
 *     而它只在**观看 AI** 模式下被调用。
 *
 * ⚠️ 别把「过滤」写成 `delete view.seats[i].role`:那还是先取了再删,
 *    任何一次拷贝 / 日志 / JSON.stringify(view) 都可能把删掉的东西带回去。
 *    这里每个字段都是**显式新建**的,state 对象从头到尾没被展开过。
 *
 * ────────────────────────────────────────────────────────────────
 * 分层(用户点名的四条)
 *   · 坏人(刺客/莫甘娜/莫德雷德/爪牙):me.teammates = **所有**坏人(含莫德雷德);
 *   · 梅林                              :me.knownEvil = 坏人**但排除莫德雷德**;
 *   · 派西维尔                          :me.merlinCandidates = 梅林与莫甘娜两个人,
 *                                         **按座位号排序**、没有标签 —— 分不清谁是谁;
 *   · 忠臣                              :me 里除了自己的身份,没有一个字段是「别人」的。
 *
 * ⚠️ 派西维尔那个数组**必须排序**:如果按「先梅林后莫甘娜」拼,数组的第一个元素
 *    就等于告诉派西维尔「谁是梅林」—— 这是最隐蔽的一种泄漏(测试里用两条断言盯着:
 *    数组长度是 2,而且两种身份的排列在**同一个座位序**下长得一样)。
 *
 * ⚠️ 「公开角色配置只发数量、不发座位」的落点在 roster 这个字段:
 *    它只有 { 梅林×1、刺客×1 … } 这样的计数,没有座位,也没有「谁是哪个」。
 */

import {
  isEvil, roleLabel, rosterText, missionTableFor, QUESTS, MAX_PROPOSALS,
  teamSizeFor, failNeedFor,
} from './engine/kernel.js';

/** 名字:内核只存字符串,取不到就给座位号 */
function nameOf(state, seat) {
  return state.names?.[seat] || `${seat + 1}号`;
}

/**
 * 公开的座位列表 —— **只有编号、名字、在不在场**。
 * 阿瓦隆没有出局,所以 alive 恒为 true;字段保留是为了与另外两个游戏同形
 * (3D 场景与存档层都按这个形状读)。
 */
function publicSeats(state) {
  return state.alive.map((alive, seat) => ({ seat, name: nameOf(state, seat), alive: !!alive }));
}

/** 公开的提名记录:[{round, proposalNo, seat, team, say}] */
function publicProposals(state) {
  return state.events
    .filter((e) => e.kind === 'proposal')
    .map((e) => ({
      round: e.round, proposalNo: e.proposalNo, seat: e.seat,
      team: (e.team || []).slice(), say: (e.say || []).slice(),
    }));
}

/** 公开的票型(整轮一起揭晓):[{round, proposalNo, votes, yes, no, passed}] */
function publicVotes(state) {
  return state.events
    .filter((e) => e.kind === 'votes')
    .map((e) => ({
      round: e.round, proposalNo: e.proposalNo,
      votes: (e.votes || []).map((v) => ({ seat: v.seat, approve: !!v.approve, reason: v.reason || '' })),
      yes: e.yes, no: e.no, passed: !!e.passed,
    }));
}

/** 已打完的任务(公开):[{round, team, size, failNeed, fails, result}] */
function publicQuests(state) {
  return (state.quests || []).map((q) => ({
    round: q.round, team: (q.team || []).slice(), size: q.size,
    failNeed: q.failNeed, fails: q.fails, result: q.result,
  }));
}

/* ------------------------------------------------------------ 声明提取 */

/**
 * 从**公开说法**里抽出声明(不是事实,只是「谁说了什么」)。
 *
 * 阿瓦隆里公开说话的场合只有两个:①队长提名时的 `say`;②投票时的 `reason`。
 * 所以要抽的也只有这两处。
 *
 * ⚠️ 研究文档把「把声明当事实」列为最严重的坑之一:
 *    「2 号说自己是梅林」和「2 号是梅林」在提示词里必须长得不一样。
 *    抽出来的东西全部带 `by`(谁说的)与 `round`,进提示词的【只是听说的声明】。
 *
 * ⚠️ 这是**启发式**提取:漏抽是常态(模型会换说法),所以提示词里还要写一句
 *    「下面这段是机器提取的,可能不全」。
 */
export function extractClaims(state) {
  const out = [];
  const scan = (text, round, by) => {
    const s = String(text || '');
    if (!s) return;
    // 「我是梅林 / 我跳派西维尔 / 我其实就是忠臣」
    const roleRe = /我(?:就|真|其实|的确|确实)?\s*(?:是|跳|认)\s*(?:一个|一名|个)?\s*(梅林|派西维尔|忠臣|好人|坏人|刺客|莫甘娜|莫德雷德|爪牙)/g;
    let m;
    while ((m = roleRe.exec(s))) {
      out.push({
        round, by, kind: 'role', value: m[1],
        text: `${by + 1}号声称自己是${m[1]}`,
      });
    }
    // 「3 号是坏人 / 5 号肯定不是好人 / 7 号像莫甘娜」
    const accuseRe = /(\d+)\s*号\s*(?:肯定|一定|八成|多半|就是|是|不像|不是)\s*(?:个)?\s*(坏人|好人|刺客|莫甘娜|莫德雷德|爪牙|梅林|派西维尔|忠臣)/g;
    while ((m = accuseRe.exec(s))) {
      out.push({
        round, by, kind: 'accuse', target: Number(m[1]) - 1, value: m[2],
        text: `${by + 1}号声称 ${m[1]} 号是${m[2]}`,
      });
    }
    // 「我怀疑 4 号」
    const susRe = /我(?:最)?(?:怀疑|不信|不信任|觉得可疑)\s*(\d+)\s*号/g;
    while ((m = susRe.exec(s))) {
      out.push({
        round, by, kind: 'suspect', target: Number(m[1]) - 1,
        text: `${by + 1}号怀疑 ${m[1]} 号`,
      });
    }
  };
  for (const e of state.events) {
    if (e.visibility !== 'public') continue;
    if (e.kind === 'proposal') for (const b of (e.say || [])) scan(b, e.round, e.seat);
    if (e.kind === 'votes') {
      for (const v of (e.votes || [])) scan(v.reason, e.round, v.seat);
    }
  }
  return out;
}

/* ------------------------------------------------------------ 座位视角 */

/**
 * 某个座位视角的完整信息。
 *
 * @param {object} state 内核 state
 * @param {number} seat 视角座位
 * @returns {object} 可以直接交给 agent / 渲染层 / JSON.stringify 的纯视图
 */
export function buildView(state, seat) {
  const me = Number(seat) || 0;
  const role = state.roles[me];
  const evil = isEvil(role);
  const isMerlin = role === 'merlin';
  const isPercival = role === 'percival';

  // ── 私有信息:每一块都**只在自己的分支里新建**,没有一条「先取全表再删」
  const meBlock = {
    seat: me,
    name: nameOf(state, me),
    alive: !!state.alive[me],
    role,
    roleLabel: roleLabel(role),
    /** 自己属于哪一边 —— 这是**自己**的阵营,不是别人的 */
    side: evil ? 'evil' : 'good',
  };

  if (evil) {
    // 坏人:知道彼此是谁。★ 莫德雷德**在这个名单里**(他对梅林隐身,但对队友不隐身)
    //
    // ⚠️ 名单里**不带 roleLabel**:官方玩法里坏人只互相认识「谁是自己人」,
    //    不知道对方具体是刺客/莫甘娜/莫德雷德/爪牙。带上角色会给坏人一条
    //    不该有的信息(「3 号是莫德雷德,梅林看不到他,让他去扛」),
    //    而且 prompt 里一旦出现「莫甘娜是谁」,它就会开始拿这条信息做推理。
    meBlock.teammates = state.roles
      .map((r, s) => (isEvil(r) && s !== me ? s : -1))
      .filter((s) => s >= 0)
      .map((s) => ({ seat: s, name: nameOf(state, s) }));
  }
  if (isMerlin) {
    // 梅林:看到所有坏人 —— **但看不到莫德雷德**(用户点名的硬机制)
    meBlock.knownEvil = state.roles
      .map((r, s) => (isEvil(r) && r !== 'mordred' ? s : -1))
      .filter((s) => s >= 0)
      .map((s) => ({ seat: s, name: nameOf(state, s) }));
    // 这一局有没有莫德雷德(公开配置里就有,但单独标一句能让提示词写得干净)
    meBlock.mordredInPlay = !!state.roster.mordred;
  }
  if (isPercival) {
    // 派西维尔:看到梅林与莫甘娜两个人,分不清谁是谁。
    // ⚠️ 这里先收集、再**按座位号排序**:数组顺序不能带任何身份暗示。
    //    (变体 plain 里没有莫甘娜,那就只看到他一个人 —— 这本身就是确定的信息,
    //     提示词会明说「这一局没有莫甘娜」。)
    const pair = state.roles
      .map((r, s) => ((r === 'merlin' || r === 'morgana') && s !== me ? s : -1))
      .filter((s) => s >= 0)
      .sort((a, b) => a - b);
    meBlock.merlinCandidates = pair.map((s) => ({ seat: s, name: nameOf(state, s) }));
    meBlock.morganaInPlay = !!state.roster.morgana;
  }

  const table = state.missionTable || missionTableFor(state.config.seats);
  const myVote = state.roundVotes?.[me] || null;

  return {
    game: 'avalon',
    seat: me,
    round: state.round,
    phase: state.phase,
    /** 本轮第几次提案 / 还能提几次 */
    proposalNo: state.proposalNo,
    proposalsLeft: Math.max(0, MAX_PROPOSALS - state.proposalNo + 1),
    maxProposals: MAX_PROPOSALS,
    questsTotal: QUESTS,

    /**
     * ★ 公开角色配置:**只有数量、没有座位**(研究文档的硬机制)。
     */
    roster: { ...state.roster },
    rosterText: rosterText(state.roster),
    /** ★ 公开任务表:每轮几人上车 / 几张失败票 */
    missionTable: { sizes: table.sizes.slice(), fails: table.fails.slice() },
    teamSize: teamSizeFor(state.config.seats, state.round),
    failNeed: failNeedFor(state.config.seats, state.round),

    me: meBlock,
    /** 公开座位表(没有身份) */
    seats: publicSeats(state),
    seatsTotal: state.alive.length,
    aliveSeats: publicSeats(state).map((s) => s.seat),

    /** 本轮队长(公开) */
    leader: state.phase === 'team' || state.phase === 'vote' || state.phase === 'mission'
      ? state.leader : null,
    /** 本轮被提名的队伍(公开) */
    team: (state.team || []).slice(),
    /** 队长这次的公开说法 */
    leaderSay: (state.say || []).slice(),
    /** 我是队长吗(组队阶段才有意义) */
    iAmLeader: state.phase === 'team' && state.leader === me,

    /** 公开历史 */
    proposals: publicProposals(state),
    votes: publicVotes(state),
    quests: publicQuests(state),
    successes: state.successes | 0,
    fails: state.fails | 0,
    /** 本轮已经连续被否了几次(公开) */
    rejects: state.rejects | 0,
    claims: extractClaims(state),

    /** 我这一轮的票(还没揭晓时只有自己知道) */
    myVote: myVote ? { approve: !!myVote.approve, reason: myVote.reason || '' } : null,
    /** 我现在能不能投票 / 能不能上车投卡 */
    canVote: state.phase === 'vote' && !(me in (state.roundVotes || {})),
    onTeam: (state.team || []).includes(me),
    canPlayCard: state.phase === 'mission' && (state.team || []).includes(me)
      && !(me in (state.missionCards || {})),

    winner: state.winner,
    endReason: state.endReason,
  };
}

/**
 * 上帝视角(**观看 AI 模式专用**)。
 *
 * 这是**唯一**读全员 roles / 任务卡 / 刺杀目标的地方。玩家模式绝对不许调它 ——
 * ui/screen.js 里只有一个分支会走到这里(见那里的注释与测试)。
 */
export function buildGodView(state) {
  const base = buildView(state, state.config.humanSeat ?? 0);
  return {
    ...base,
    god: true,
    /** 整张身份表 —— 只给观看模式 */
    seats: state.alive.map((a, s) => ({
      seat: s,
      name: nameOf(state, s),
      alive: !!a,
      role: state.roles[s],
      roleLabel: roleLabel(state.roles[s]),
      side: isEvil(state.roles[s]) ? 'evil' : 'good',
    })),
    /** 刺客是谁、他刺了谁(上帝看得到) */
    assassin: (() => {
      const i = state.roles.indexOf('assassin');
      return i >= 0 ? { seat: i, name: nameOf(state, i), target: state.assassinTarget ?? null } : null;
    })(),
    /** 本轮任务卡(私有真相) */
    missionCards: Object.entries(state.missionCards || {})
      .map(([s, c]) => ({ seat: Number(s), card: c }))
      .sort((a, b) => a.seat - b.seat),
    /** 历史上每一轮谁出了失败卡(从 secret 账本读) */
    cardHistory: state.events
      .filter((e) => e.visibility === 'secret' && e.kind === 'card')
      .map((e) => ({ round: e.round, seat: e.seat, card: e.card })),
    /** 本轮票型(还没揭晓时上帝也先看着) */
    liveVotes: Object.entries(state.roundVotes || {})
      .map(([s, v]) => ({ seat: Number(s), approve: !!v.approve, reason: v.reason || '' }))
      .sort((a, b) => a.seat - b.seat),
    /** 梅林在哪 —— 结算横幅要写「刺客刺的是不是梅林」 */
    merlinSeat: (() => {
      const i = state.roles.indexOf('merlin');
      return i >= 0 ? i : null;
    })(),
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
 *    sceneCore/table.js 的 syncSeats)。阿瓦隆没有出局,所以 stack 恒为 1000;
 *    actor = 现在该行动的人(队长 / 正在投票的人 / 正在投卡的人 / 刺客)。
 *    这里同样**不含任何身份** —— 道具层要显示身份时,由观看模式单独塞进 ctx,
 *    不经过这个对象(见 props/avalon 的道具层)。
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
