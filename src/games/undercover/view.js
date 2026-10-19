/**
 * 「谁是卧底」的**信息出口** —— 每个座位能看到的全部内容,只有这一个函数产。
 *
 * ────────────────────────────────────────────────────────────────
 * 这个文件为什么是整个游戏最重要的地方
 *
 * 游戏的核心是「每个人只知道自己的词,连自己是不是卧底都要靠推理」。
 * 一旦某个 AI(或玩家模式的渲染层)拿到了别人的词或阵营,游戏就塌了 ——
 * 而且**塌得没有任何报错**:AI 会突然变得"神准",看起来像模型变聪明了。
 *
 * 所以照研究文档的做法(与狼人杀共用同一套范式):
 *   · `buildView(state, seat)` 是 AI 与渲染层的**唯一**信息出口;
 *   · 它返回的对象里**根本不存在**别人的 words / roles 字段 ——
 *     不是「有但藏起来」,而是**取的时候就没有**(玩家模式也是这条:渲染前就不传);
 *   · 上帝模式另走 `buildGodView(state)`,它是唯一会读 roles 的地方 ——
 *     而它只在**观看 AI** 模式下被调用。
 *
 * ⚠️ 别把「过滤」写成 `delete view.seats[i].role`:那还是先取了再删,
 *    任何一次拷贝/日志/JSON.stringify(view) 都可能把删掉的东西带回去。
 *    这里每个字段都是**显式新建**的,state 对象从头到尾没被展开过。
 */

/** 某个座位自己是否还活着 */
function aliveOf(state, seat) {
  return !!state.alive[seat];
}

/** 名字:内核只存字符串,取不到就给座位号 */
function nameOf(state, seat) {
  return state.names?.[seat] || `${seat + 1}号`;
}

/**
 * 公开的座位列表 —— **只有编号、名字、死活**。
 * 别人的词与阵营**不在这个对象里**,也不在随后拼接的任何一处。
 */
function publicSeats(state) {
  return state.alive.map((alive, seat) => ({ seat, name: nameOf(state, seat), alive: !!alive }));
}

/** 公开描述(每一轮谁说了一句什么) */
function publicDescriptions(state, viewer = null) {
  return state.descriptions.map((d) => ({
    round: d.round, seat: d.seat, say: d.say,
    // self_read 是 AI 对自己的判断(可能猜错)。
    // ★ 只把自己的那一格交给自己:别人的自省在观看模式里很好玩,但**玩家模式不该看** ——
    //   它常常直接点破「那个人是卧底」,等于白送一条线索(研究文档也把 self_read
    //   归给上帝模式)。所以这里按 viewer 截断,不是渲染层再隐藏。
    ...(viewer === null || d.seat === viewer ? { selfRead: d.selfRead || 'unsure' } : {}),
    quality: d.quality || 'ok',
  }));
}

/** 公开投票(谁投了谁、理由;to=null = 弃票) */
function publicVotes(state) {
  return state.votes.map((v) => ({ round: v.round, from: v.from, to: v.to, reason: v.reason }));
}

/**
 * 猜词的**公开**那一份。
 *
 * ⚠️ 这是信息隔离在这个玩法上的落点:「谁猜了、猜没猜中」是公开的,
 *    **猜的那个词**不是 —— 除非
 *      ① 猜的人是真正的卧底(猜完这一局立刻结束,没有泄漏面),或者
 *      ② 本局已经结束(谁赢都定了,再藏没有意义)。
 *    否则平民/白板猜的词会把平民词直接送给还活着的卧底(他们照着念就赢了)。
 *    屏幕层因此**不许**直接读 state.guesses,只能走这里 / buildGodView。
 *
 * @param {object} state
 * @param {{full?:boolean}} [opts] full = 上帝视角(AI 看 AI 的那一屏)
 */
function publicGuesses(state, { full = false } = {}) {
  return (state.guesses || []).map((g) => {
    const reveal = full || g.role === 'undercover' || state.phase === 'end';
    return {
      round: g.round,
      seat: g.seat,
      // hit 是公开的:它只说明「这个词对/不对」,不透露词本身
      hit: !!g.hit,
      ...(reveal ? { text: g.text } : {}),
    };
  });
}

/** 公开公告(发词人数、每轮顺序、谁出局——出局即公开阵营) */
function publicLog(state) {
  return state.log.map((e) => ({ round: e.round, kind: e.kind, text: e.text }));
}

/**
 * 某个座位视角的完整信息。
 *
 * @param {object} state 内核 state
 * @param {number} seat 视角座位
 * @param {{matchStandings?:{rounds:number,ranking:Array<{seat:number,name:string,score:number}>}}} [opts]
 *   matchStandings = 本场积分榜的**公开快照**(座位 / 名字 / 积分),由 runner 从屏幕取。
 *   积分榜就挂在界面上给所有人看,所以它是公开信息;而别人的词 / 阵营不在这里。
 * @returns {object} 可以直接交给 agent / 渲染层 / JSON.stringify 的纯公开视图
 */
export function buildView(state, seat, opts = {}) {
  const me = Number(seat) || 0;
  const alive = aliveOf(state, me);
  const aliveSeats = state.alive.map((a, s) => (a ? s : -1)).filter((s) => s >= 0);
  return {
    game: 'undercover',
    seat: me,
    round: state.round,
    rounds: state.config.rounds,
    phase: state.phase,
    threshold: state.config.seats >= 6 ? 3 : 2,
    // 白板人数是**公开的设置信息**(和「几个人」「几个卧底」一样)——
    // 谁在硬编要靠它来推理,但「谁**是**白板」不在这里(那只能靠听)。
    blankCount: state.config.blankCount || 0,
    aliveCount: aliveSeats.length,
    aliveSeats,
    /**
     * ⚠️ 这是**唯一**一处出现「词」的地方,而且只出现自己的那一个。
     * 别人的词在整个对象里没有任何字段能装它。
     *
     * blank 这个字段是**这个座位本来就知道的事**:白板手里没有词,自己当然清楚。
     * 但它不告诉它「白板属于平民阵营」—— 那会直接把这个游戏的灵魂拆了
     * (白板一旦知道自己不是卧底,就再也不用推理、也不会赌要不要猜词了)。
     */
    me: {
      seat: me,
      name: nameOf(state, me),
      word: state.words[me] || '',
      blank: !state.words[me],
      alive,
    },
    /** 公开座位表(没有词、没有阵营) */
    seats: publicSeats(state),
    /**
     * 本场积分榜(公开信息;还没打完一局时为空数组 + rounds:0)。
     * ⚠️ 只有 seat / name / score —— 排名公开,词/阵营不公开。
     */
    matchStandings: opts.matchStandings || null,
    /** 本轮描述顺序与当前该谁说话 */
    order: state.order.slice(),
    orderIdx: state.orderIdx,
    currentSpeaker: state.phase === 'describe' ? (state.order[state.orderIdx] ?? null) : null,
    /** 公开历史 */
    descriptions: publicDescriptions(state, me),
    votes: publicVotes(state),
    guesses: publicGuesses(state),
    eliminated: state.eliminated.map((e) => ({ seat: e.seat, round: e.round, role: e.role })),
    log: publicLog(state),
    /** 投票阶段:轮到自己的话,能投谁(不含自己、不含已出局) */
    voteCandidates: state.phase === 'vote' && alive
      ? state.alive.map((a, s) => (a && s !== me ? s : -1)).filter((s) => s >= 0)
      : [],
    pendingVoters: state.phase === 'vote'
      ? state.alive.map((a, s) => (a ? s : -1)).filter((s) => s >= 0)
        .filter((s) => !state.votes.some((v) => v.round === state.round && v.from === s))
      : [],
    winner: state.winner,
    endReason: state.endReason,
  };
}

/**
 * 上帝视角(观看 AI 模式专用)。
 *
 * 这是**唯一**读 `words` / `roles` 的地方。玩家模式绝对不许调它 ——
 * ui/screen.js 里只有一个分支会走到这里(见那里的注释与测试)。
 */
export function buildGodView(state) {
  const base = buildView(state, state.config.humanSeat ?? 0);
  // 上帝看的是「所有人」,所以自己的词那一格没有意义,换成整张表
  const selfReads = {};
  const lastDescribe = {};
  for (const d of state.descriptions) {
    if (!lastDescribe[d.seat] || d.round >= lastDescribe[d.seat].round) {
      selfReads[d.seat] = d.selfRead || 'unsure';
      lastDescribe[d.seat] = { round: d.round, say: d.say };
    }
  }
  return {
    ...base,
    god: true,
    civilianWord: state.civilianWord,
    undercoverWord: state.undercoverWord,
    /** 整张身份/词表 —— 只给观看模式 */
    seats: state.alive.map((a, s) => ({
      seat: s,
      name: nameOf(state, s),
      alive: !!a,
      // 白板这一格是空串:界面上要显示成「(白板)」,别显示成空白
      word: state.words[s],
      role: state.roles[s],
      selfRead: selfReads[s] || 'unsure',
      lastSay: lastDescribe[s]?.say || '',
    })),
    selfReads,
    /** 上帝视角看得到猜的到底是什么词(局中也不藏,因为观众本来就都知道) */
    guesses: publicGuesses(state, { full: true }),
  };
}

/**
 * 渲染层拿哪一份视图 —— **玩家模式与观看模式在这里分流**。
 *
 * 这是「渲染前就不取」的落实点:玩家模式走 buildView(只含自己的词),
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
 * 一局打完之后的**结算视图**(给算分用)。
 *
 * ⚠️ 只在 `state.phase === 'end'` 时调用。它读 roles —— 那在结算时是公开信息
 *    (出局公开阵营 / 终局亮牌),但**局中调用它就是泄漏**,所以别把它当通用 view
 *    去喂给 AI 或渲染层:AI 与渲染层用 buildView / buildGodView。
 *
 * 返回值是**游戏自己定义**的结算结果,平台/界面只负责原样交给 scoring.js 的
 * score(result, cfg) —— 卧底这一份的形状(seat/role/alive/guess)只有卧底自己解释。
 *
 * @param {object} state 内核 state
 * @returns {object}
 */
export function buildScoreResult(state) {
  return {
    game: 'undercover',
    winner: state.winner,              // 'civilian' | 'undercover' | null
    endReason: state.endReason,        // ... | 'guessRight' | 'guessMiss'
    rounds: state.round,
    config: {
      seats: state.config.seats,
      undercoverCount: state.config.undercoverCount,
      blankCount: state.config.blankCount || 0,
    },
    seats: state.alive.map((a, s) => ({
      seat: s,
      name: nameOf(state, s),
      role: state.roles[s],            // 'civilian' | 'undercover' | 'blank'
      alive: !!a,
    })),
    /** 公开投票(算「投中卧底」那 +1 用;它本来就是公开信息) */
    votes: publicVotes(state),
    /**
     * 本局所有猜词动作(一局里可以有好几次:平民猜一次出局,后面别人还能再猜)。
     * 算分要**每一条都算**,不能只看最后一条 —— 否则前面那个送人头的平民白送了。
     */
    guesses: (state.guesses || []).map((g) => ({
      seat: g.seat,
      role: g.role,
      text: g.text,
      hit: !!g.hit,
      round: g.round,
    })),
  };
}

/**
 * 场景核心(Table3D)要的那份 view。
 *
 * ⚠️ 这不是「游戏 view」,而是一个**适配层**:sceneCore 是通用的,它要的是
 *    每个人「在不在桌上 / 还活着吗 / 现在轮到谁」这类通用字段(见
 *    sceneCore/table.js 的 syncSeats)。所以这里把卧底的存活状态翻译过去:
 *      · 出局的人 stack=0 + folded=true → 立绘变淡、头顶指示器收起;
 *      · actor = 当前发言/需要投票的人;
 *      · button = -1(卧底没有庄家按钮,场景核心会自己隐藏它);
 *      · positions 留空(卧底没有大小盲)。
 *    这里同样**不含任何词/阵营** —— 道具层要显示词时,由观看模式单独塞进 ctx,
 *    不经过这个对象(见 props/undercover 的道具层)。
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
