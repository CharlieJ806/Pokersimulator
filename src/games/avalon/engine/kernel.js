/**
 * 「阿瓦隆」(Avalon / 抵抗组织)的规则内核 —— **纯函数 + 纯数据**,不碰 LLM、不碰 DOM。
 *
 * 这一层是唯一的裁判:谁是什么身份、这一轮谁上车、队伍有没有通过、任务成功还是失败、
 * 刺客有没有刺中梅林,全部由这里算。AI 的输出一律当**提议**,非法就拒,
 * 不靠提示词求它守规矩(与狼人杀/卧底同一个主张)。
 *
 * ────────────────────────────────────────────────────────────────
 * 规则(用户口径,MVP)
 *
 *   人数     :**5~10 人可选**(用户要求,不写死)。
 *   阵营     :好人 = 梅林 / 派西维尔 / 忠臣;坏人 = 刺客 / 莫甘娜 / 莫德雷德 / 爪牙。
 *              每个档位的构成见 ROSTER_TABLE(莫德雷德 **≥7 人**才启用,用户点名)。
 *   每局     :**5 轮任务**。每轮 = 队长选人 → 全员投票 → 通过则上车者暗中投卡 → 计数。
 *   任务表   :每轮上车人数 / 需要几张失败票,见 MISSION_TABLE(**标准表**,注释里写清来源)。
 *   胜负     :3 轮成功 → 好人胜(但要先过刺杀);3 轮失败 → 坏人胜(**立即**,不再刺杀)。
 *   刺杀     :好人拿到第 3 次任务成功后,刺客**必须**刺一个人;刺中梅林 → 坏人翻盘胜,
 *              否则好人胜。
 *
 * ────────────────────────────────────────────────────────────────
 * 两个**故意砍掉**的官方规则(用户说可以砍,但要求写清理由)
 *
 *   ① **湖中夫人**:它每轮多一次「看阵营」的私有信息 + 一次传递决策。加进来的代价是
 *      多一条只有部分玩家能读到的信息流(view/prompts 都要多一层),而收益是「多一点信息」——
 *      与「先把三个阵营/刺杀/任务表做扎实」相比,这一期不值得。
 *   ② **连续 5 次组队被否 → 坏人直接胜**:这条本身是**必要的收尾**(不然全桌都投反对
 *      就是死循环),但它把胜负提前塞给坏人,和「3 次任务失败才输」冲突。所以这里保留
 *      「一轮最多 5 次提案」的**结构**,把第 5 次的结算改成**强制通过**(见
 *      _settleVotes 里的 forced 分支):压力还在(前 4 次否决就意味着这一轮由最后一次
 *      队伍说了算),但不会出现「一个任务都没打就判负」。理由写在 _settleVotes 那里。
 *
 * ⚠️ 三个容易写错的地方(都有测试盯着)
 *
 *   · **投票是同时揭晓的**:标准玩法里所有人一起亮票,所以内核先收齐**全部**票再结算,
 *     不能「谁先投先算」—— 那会让后投的人看到票型再改主意(狼人杀那种逐票揭晓在这里
 *     是规则错误,不是节奏问题)。
 *   · **好人的卡被规则钉死成 success**:好人「可以投失败」不是自由,是违规。内核直接
 *     拒绝(抛错),而不是「接受但改成成功」—— 前者能立刻暴露 bug,后者会把一个坏掉的
 *     agent 伪装成正常对局。
 *   · **任务卡是私有的,只有合计是公开的**:每次任务结束只写「几票失败」进公开账本,
 *     谁出的失败卡写进 secret 账本(上帝视角用)。这条一旦搞错,游戏立刻塌 ——
 *     大家都能看见谁破坏,就不需要推理了。
 */

/** 快照版本。结构一变就 +1,旧档会被 validateSnapshot 丢掉。 */
export const SNAPSHOT_VERSION = 1;

/** 人数范围(用户要求可选 5~10) */
export const MIN_SEATS = 5;
export const MAX_SEATS = 10;

/** 一局固定 5 轮任务 */
export const QUESTS = 5;

/**
 * 每一轮最多提几次名(第 5 次强制通过 —— 见文件头「砍掉的官方规则 ②」)。
 * 这个数字来自官方规则的「连续 5 次否决」,只是把结算方式换了。
 */
export const MAX_PROPOSALS = 5;

/** 两种角色变体(设置里的「启用的角色变体」) */
export const VARIANTS = ['classic', 'plain'];

/** 本 MVP 存在的七个角色。顺序 = 发牌时铺牌的顺序(不影响平衡,只影响可读性) */
export const ROLES = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'minion'];

/** 坏人阵营的四个角色(名字统一从这一份取,别在各处再列一遍) */
export const EVIL_ROLES = ['assassin', 'morgana', 'mordred', 'minion'];

/**
 * 人数 → 每轮上车人数 / 需要几张失败票(**标准阿瓦隆表**)。
 *
 * 为什么预热一张表而不是按比例算:这张表是官方**人为调过平衡**的整数,
 * 用公式(比如 ceil(n/2))在 5/6 人局会给出「2 人车要 2 张失败」这种必败局。
 * 表比公式好复核,而且测试可以逐格对照(见 tools/avalonest.mjs 的 [7] 用例)。
 *
 * 读法:`sizes[round-1]` = 第 round 轮要几人上车;`fails[round-1]` = 要几张失败票才失败。
 * ★ 7 人起**第 4 轮**需要 2 张失败票 —— 这是全表唯一一个非 1 的格子,
 *   它让「后期任务必须两个坏人一起上」,是整个游戏后段博弈的核心。
 */
const MISSION_TABLE = {
  5: { sizes: [2, 3, 2, 3, 3], fails: [1, 1, 1, 1, 1] },
  6: { sizes: [2, 3, 4, 3, 4], fails: [1, 1, 1, 1, 1] },
  7: { sizes: [2, 3, 3, 4, 4], fails: [1, 1, 1, 2, 1] },
  8: { sizes: [3, 4, 4, 5, 5], fails: [1, 1, 1, 2, 1] },
  9: { sizes: [3, 4, 4, 5, 5], fails: [1, 1, 1, 2, 1] },
  10: { sizes: [3, 4, 4, 5, 5], fails: [1, 1, 1, 2, 1] },
};

/**
 * 人数 → 好人/坏人各几个(**标准配比**)。
 *   5 人 3/2、6 人 4/2、7 人 4/3、8 人 5/3、9 人 6/3、10 人 6/4。
 * 好人恒比坏人多 1~3 个:坏人靠「任务里搅一票」和「刺客翻盘」补,不靠人数。
 */
const SIDE_TABLE = {
  5: { good: 3, evil: 2 },
  6: { good: 4, evil: 2 },
  7: { good: 4, evil: 3 },
  8: { good: 5, evil: 3 },
  9: { good: 6, evil: 3 },
  10: { good: 6, evil: 4 },
};

/** 人数夹到合法范围(手改配置写出 seats:99 也不该把局开崩) */
function clampSeats(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return MIN_SEATS;
  return Math.max(MIN_SEATS, Math.min(MAX_SEATS, n));
}

/**
 * 按人数取本局的**任务表**(纯函数)。
 * @param {number} seats
 * @returns {{sizes:number[], fails:number[]}}
 */
export function missionTableFor(seats) {
  const n = clampSeats(seats);
  return { sizes: MISSION_TABLE[n].sizes.slice(), fails: MISSION_TABLE[n].fails.slice() };
}

/** 某一轮要几个人上车(round 从 1 起) */
export function teamSizeFor(seats, round) {
  const t = missionTableFor(seats);
  const i = Math.max(0, Math.min(QUESTS - 1, Math.round(Number(round) || 1) - 1));
  return t.sizes[i];
}

/** 某一轮要几张失败票才失败 */
export function failNeedFor(seats, round) {
  const t = missionTableFor(seats);
  const i = Math.max(0, Math.min(QUESTS - 1, Math.round(Number(round) || 1) - 1));
  return t.fails[i];
}

/**
 * 按人数(与变体)取角色构成。
 *
 * classic(默认,用户口径的完整 MVP):
 *   好人 = 梅林×1 + 派西维尔×1 + 忠臣×N
 *   坏人 = 刺客×1 + 莫甘娜×1 + 莫德雷德(**≥7 人才有**)×1 + 爪牙×剩下的
 * plain(简化变体:**没有派西维尔、没有莫甘娜**):
 *   好人 = 梅林×1 + 忠臣×N
 *   坏人 = 刺客×1 + 爪牙×剩下的
 *   为什么留这个变体:派西维尔/莫甘娜这一对是**信息隔离里最难解释的一段**
 *   (「你看到两个人,但不知道谁是哪个」),新手局很容易被它绕晕;
 *   关掉之后游戏只剩「梅林看坏人 + 刺客刺杀」,适合第一次玩。
 *
 * @param {number} seats
 * @param {string} [variant] 'classic' | 'plain'
 * @returns {{merlin:number, percival:number, loyal:number,
 *            assassin:number, morgana:number, mordred:number, minion:number}}
 */
export function rosterFor(seats, variant = 'classic') {
  const n = clampSeats(seats);
  const side = SIDE_TABLE[n];
  const plain = variant === 'plain';
  const out = {
    merlin: 1,
    percival: plain ? 0 : 1,
    loyal: 0,
    assassin: 1,
    morgana: plain ? 0 : 1,
    // ★ 莫德雷德:用户要求「只在 ≥7 人时启用」。5/6 人局他是**不存在**的角色,
    //   不是「存在但梅林看不见」—— 两件事在提示词里长得完全不同,不能混。
    mordred: (!plain && n >= 7) ? 1 : 0,
    minion: 0,
  };
  out.loyal = side.good - out.merlin - out.percival;
  out.minion = side.evil - out.assassin - out.morgana - out.mordred;
  if (out.loyal < 0 || out.minion < 0) {
    // 表格与配比对不上是**内核自己的错**(改表时漏了),必须当场炸出来
    throw new Error(`角色构成与 ${n} 人局的配比对不上(ROSTER 表写错了)`);
  }
  return out;
}

/** 是不是坏人阵营 */
export function isEvil(role) {
  return EVIL_ROLES.includes(role);
}

/** 是不是好人阵营 */
export function isGood(role) {
  return !isEvil(role);
}

/** 身份 → 中文 */
export function roleLabel(role) {
  return {
    merlin: '梅林',
    percival: '派西维尔',
    loyal: '忠臣',
    assassin: '刺客',
    morgana: '莫甘娜',
    mordred: '莫德雷德',
    minion: '爪牙',
  }[role] || String(role || '');
}

/** 阵营 → 中文 */
export function sideLabel(side) {
  return side === 'evil' ? '坏人' : '好人';
}

/**
 * 角色构成的中文一句话(**只有数量,没有座位**)。
 * 这一句会原样进提示词 —— 公开配置只发数量的落点就在这儿。
 */
export function rosterText(roster) {
  const parts = [];
  const push = (n, name) => { if (n) parts.push(`${name}×${n}`); };
  push(roster.merlin, '梅林');
  push(roster.percival, '派西维尔');
  push(roster.loyal, '忠臣');
  push(roster.assassin, '刺客');
  push(roster.morgana, '莫甘娜');
  push(roster.mordred, '莫德雷德');
  push(roster.minion, '爪牙');
  return parts.join('、');
}

/** 任务表的中文一句话(「第1轮 2 人 / 1 张失败票 …」)—— 提示词与界面共用 */
export function missionTableText(seats) {
  const t = missionTableFor(seats);
  return t.sizes.map((n, i) => `第${i + 1}轮 ${n}人/${t.fails[i]}票失败`).join(' · ');
}

/** Fisher–Yates 洗牌,随机源注入(与狼人杀/卧底同一套:sort(()=>rand()-0.5) 分布有偏) */
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 配置归一化:夹范围 + 认不出的变体回落 classic */
function normalizeConfig(cfg = {}) {
  const seats = clampSeats(cfg.seats ?? 7);
  const variant = VARIANTS.includes(cfg.variant) ? cfg.variant : 'classic';
  const humanSeat = Number.isInteger(cfg.humanSeat) && cfg.humanSeat >= 0 && cfg.humanSeat < seats
    ? cfg.humanSeat : null;
  const speakDelayMs = Math.max(0, Math.min(8000, Math.round(Number(cfg.speakDelayMs) || 900)));
  return { seats, variant, humanSeat, speakDelayMs };
}

/** 一局的初始状态(还没发身份)。restore 与 start 共用同一个形状。 */
function blankState(config) {
  const table = missionTableFor(config.seats);
  return {
    game: 'avalon',
    config,
    /** 公开的角色构成(只有数量、没有座位)—— 提示词只发这一份 */
    roster: rosterFor(config.seats, config.variant),
    /** 公开的任务表(每轮几人上车 / 几张失败票) */
    missionTable: table,
    /** 第几轮任务(1 起) */
    round: 1,
    /** idle | team | vote | mission | assassinate | end */
    phase: 'idle',
    /** 本轮队长 */
    leader: 0,
    /** 本轮第几次提案(1 起,最多 MAX_PROPOSALS) */
    proposalNo: 0,
    /** 本轮被提名的队伍(公开信息) */
    team: [],
    /** 队长这次的公开说法(气泡数组) */
    say: [],
    /** 本轮票型 { 座位: {approve, reason} } —— 收齐后才一次性公开 */
    roundVotes: {},
    /** 本轮任务卡 { 座位: 'success'|'fail' } —— **私有**,只有合计公开 */
    missionCards: {},
    /** 已打完的任务:[{round, team, size, failNeed, fails, result}] —— 公开 */
    quests: [],
    /** 成功/失败的轮数 */
    successes: 0,
    fails: 0,
    /** 连续被否的次数(本轮内);第 5 次提案会强制通过 */
    rejects: 0,
    /** 活着的人(阿瓦隆没有出局,永远全活;数组形式是为了与另外两个游戏同形) */
    alive: new Array(config.seats).fill(true),
    /** 真实身份(私有) */
    roles: [],
    names: [],
    /** 刺客刺了谁(私有,结算时才公开) */
    assassinTarget: null,
    /**
     * 事件账本(唯一真相源,追加不修改)。
     * visibility 三档 —— 这是信息隔离在数据层的落点:
     *   · 'public'  —— 所有人可见:提名、票型、任务结果、刺杀结果、胜负;
     *   · 'faction' —— 仅坏人阵营(以及上帝视角):坏人内部的默契(这一期只用于记账);
     *   · 'secret'  —— 仅本人(以及上帝视角):谁出了失败卡、刺客的思考。
     * 只有 'public' 事件会进别人的视图 —— 见 view.js 的 publicEvents()。
     */
    events: [],
    winner: null,     // null | 'good' | 'evil'
    endReason: null,  // quests | assassin-hit | assassin-miss
  };
}

export class AvalonKernel {
  /**
   * @param {object} cfg { seats, variant, humanSeat, speakDelayMs }
   * @param {{rand?:()=>number, deal?:object}} [opts]
   *   rand 随机源(测试传种子随机源 → 同一局可复现)
   *   deal 指定身份牌(测试用;不传就随机发)
   */
  constructor(cfg = {}, opts = {}) {
    this.config = normalizeConfig(cfg);
    this.rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
    this._deal = opts.deal || null;
    this.state = blankState(this.config);
  }

  /* ------------------------------------------------------------ 开局 */

  /**
   * 发身份 + 定第一任队长。只能调一次(重复调会重发身份)。
   * @param {string[]} names 座位显示名(由界面给,内核只存不解释)
   */
  start(names = []) {
    const st = this.state;
    if (st.phase !== 'idle') throw new Error('这局已经开始了(start 只能调一次)');
    const { seats } = this.config;
    const roster = st.roster;

    // 身份牌:先按人数铺一份,再洗牌发下去。
    // ⚠️ 顺序要紧:先洗牌再分配座位,不能「按座位顺序填」—— 那样 1 号永远是梅林。
    let deck = [];
    for (const role of ROLES) {
      for (let i = 0; i < (roster[role] || 0); i++) deck.push(role);
    }
    if (deck.length !== seats) {
      throw new Error(`角色构成 ${deck.length} 张牌与 ${seats} 个座位对不上(ROSTER_TABLE 写错了)`);
    }
    if (this._deal && Array.isArray(this._deal.roles) && this._deal.roles.length === seats) {
      // 测试用:指定身份(校验合法性,免得测出一个规则外的局面)
      const want = this._deal.roles.slice();
      const sorted = want.slice().sort().join(',');
      const okDeck = deck.slice().sort().join(',');
      if (sorted !== okDeck) {
        throw new Error(`指定的身份牌与人数构成不符:${sorted} vs ${okDeck}`);
      }
      deck = want;
    } else {
      deck = shuffle(deck, this.rand);
    }
    st.roles = deck;
    st.alive = new Array(seats).fill(true);
    st.names = st.roles.map((_, seat) => String(names[seat] ?? `${seat + 1}号`));
    st.round = 1;
    // 第一任队长随机 —— 固定从 1 号开始会让「1 号永远先选人」变成一种隐形的座位优势
    st.leader = Math.floor(this.rand() * seats) % seats;
    st.proposalNo = 1;
    st.rejects = 0;
    st.phase = 'team';
    this._log('public', 'start', {
      text: `已发身份:${seats} 人局,${rosterText(roster)}(身份不公开,只有主持人知道)`,
    });
    this._log('public', 'round', {
      text: `第 1 轮任务开始:要 ${teamSizeFor(seats, 1)} 人上车,需要 ${failNeedFor(seats, 1)} 张失败票;`
        + `队长是 ${st.leader + 1} 号`,
    });
    return this;
  }

  /* ------------------------------------------------------------ 组队 */

  /** 本轮任务要几个人上车 */
  teamSize() {
    return teamSizeFor(this.config.seats, this.state.round);
  }

  /** 本轮需要几张失败票 */
  failNeed() {
    return failNeedFor(this.config.seats, this.state.round);
  }

  /** 现在该谁提名;不在组队阶段返回 null */
  currentLeader() {
    const st = this.state;
    if (st.phase !== 'team') return null;
    return st.leader;
  }

  /** 这一轮还能提几次名(界面上给个提示,也给 runner 的安全阀用) */
  proposalsLeft() {
    return Math.max(0, MAX_PROPOSALS - this.state.proposalNo + 1);
  }

  /**
   * 队长提名队伍。
   *
   * 校验全写在最前面:人数必须刚好、座位必须合法且不重复。非法一律**抛错**
   * (agent 那边已经兜过一层;真传到这里说明有 bug,静默纠正会让局面悄悄走偏)。
   *
   * ⚠️ **允许队长把自己排除在外**(真实玩法里合法,虽然少见):所以这里不校验
   *    「必须包含队长」。这也是降级策略「不上车」能成立的前提(见 agent.js)。
   *
   * @param {number} seat 队长座位
   * @param {number[]} team 上车座位
   * @param {string[]|string} [say] 队长的公开说法
   */
  proposeTeam(seat, team, say = []) {
    const st = this.state;
    if (st.phase !== 'team') throw new Error(`现在不是组队阶段(${st.phase})`);
    if (seat !== st.leader) throw new Error(`现在该 ${st.leader + 1} 号提名,不是 ${seat + 1} 号`);
    const size = this.teamSize();
    const list = Array.isArray(team) ? team : [];
    if (list.length !== size) throw new Error(`这一轮要选 ${size} 人,收到 ${list.length} 人`);
    const seen = new Set();
    const clean = [];
    for (const raw of list) {
      const t = Math.round(Number(raw));
      if (!Number.isInteger(t) || t < 0 || t >= st.alive.length) throw new Error(`队伍里有非法座位(${raw})`);
      if (seen.has(t)) throw new Error(`队伍里有重复座位(${t + 1} 号)`);
      seen.add(t);
      clean.push(t);
    }
    const bubbles = normalizeBubbles(say);
    st.team = clean.sort((a, b) => a - b);
    st.say = bubbles;
    st.roundVotes = {};
    st.proposalNo = Math.max(1, st.proposalNo);
    st.phase = 'vote';
    this._log('public', 'proposal', {
      seat, team: st.team.slice(), say: bubbles, round: st.round, proposalNo: st.proposalNo,
      text: `第 ${st.round} 轮 · ${seat + 1} 号提名:${st.team.map((s) => `${s + 1}号`).join('、')}`
        + (bubbles.length ? `。他说:${bubbles.join(' ')}` : ''),
    });
    return this;
  }

  /* ------------------------------------------------------------ 投票 */

  /** 这一轮还没投票的座位(阿瓦隆没有出局,所以就是全部座位) */
  pendingVoters() {
    const st = this.state;
    if (st.phase !== 'vote') return [];
    const out = [];
    for (let s = 0; s < st.alive.length; s++) {
      if (!(s in st.roundVotes)) out.push(s);
    }
    return out;
  }

  /**
   * 记一张赞成/反对票。
   *
   * ⚠️ **收齐才结算**(标准玩法:所有人同时亮票)。所以这里只写进 roundVotes,
   *    结算发生在最后一张票进来的时候 —— 界面上的「票型」也只在那一刻整体出现。
   *
   * @param {number} from
   * @param {boolean} approve true = 赞成
   * @param {string} [reason] 公开理由(≤25 字,已过 filter)
   */
  recordVote(from, approve, reason = '') {
    const st = this.state;
    if (st.phase !== 'vote') throw new Error('现在不是投票阶段');
    if (!st.alive[from]) throw new Error(`${from + 1} 号不在场上`);
    if (from in st.roundVotes) throw new Error(`${from + 1} 号这一轮已经投过了`);
    st.roundVotes[from] = {
      approve: !!approve,
      reason: String(reason || '').slice(0, 40),
    };
    if (!this.pendingVoters().length) this._settleVotes();
    return this;
  }

  /**
   * 结算本轮投票:过半数赞成 → 上车;否则换队长重提(第 5 次强制通过)。
   *
   * 过半数 = `赞成 > 座位数 / 2`(偶数人局同样口径:6 人要 4 票)。
   * 为什么不用「平票算通过」的简化:平票意味着这一队连一半人都说服不了,
   * 让它上车会让「说服」这件事失去意义。
   */
  _settleVotes() {
    const st = this.state;
    const votes = Object.entries(st.roundVotes)
      .map(([s, v]) => ({ seat: Number(s), approve: !!v.approve, reason: v.reason || '' }))
      .sort((a, b) => a.seat - b.seat);
    const yes = votes.filter((v) => v.approve).length;
    const no = votes.length - yes;
    const passed = yes > st.alive.length / 2;

    this._log('public', 'votes', {
      round: st.round, proposalNo: st.proposalNo,
      votes, yes, no, passed,
      text: `表决 ${yes} 赞成 / ${no} 反对 → ${passed ? '通过,上车' : '否决'}`,
    });

    if (passed) {
      st.phase = 'mission';
      st.missionCards = {};
      this._log('public', 'missionStart', {
        round: st.round, team: st.team.slice(),
        text: `第 ${st.round} 轮任务开始:${st.team.map((s) => `${s + 1}号`).join('、')} 上车,`
          + `需要 ${this.failNeed()} 张失败票才失败`,
      });
      return;
    }

    // 否决:换下一个座位当队长,同一轮重来。第 5 次提案**强制通过**。
    st.rejects += 1;
    if (st.proposalNo >= MAX_PROPOSALS) {
      // ★ 强制通过(官方规则这里是「坏人直接胜」,本 MVP 砍掉了 —— 见文件头)。
      //   压力仍然存在:前 4 次否决意味着这一轮的最后一次提案说了算,
      //   所以「否决」不是免费的重置键。
      st.phase = 'mission';
      st.missionCards = {};
      this._log('public', 'forced', {
        round: st.round, team: st.team.slice(),
        text: `第 ${MAX_PROPOSALS} 次提案也被否决 —— 按规则这一队**强制上车**(不再换队长)`,
      });
      this._log('public', 'missionStart', {
        round: st.round, team: st.team.slice(),
        text: `第 ${st.round} 轮任务开始:${st.team.map((s) => `${s + 1}号`).join('、')} 上车,`
          + `需要 ${this.failNeed()} 张失败票才失败`,
      });
      return;
    }
    st.leader = (st.leader + 1) % st.alive.length;
    st.proposalNo += 1;
    st.phase = 'team';
    st.team = [];
    st.say = [];
    st.roundVotes = {};
    this._log('public', 'rejected', {
      round: st.round, leader: st.leader, proposalNo: st.proposalNo,
      text: `第 ${st.round} 轮换队长:现在是 ${st.leader + 1} 号(第 ${st.proposalNo} 次提案)`,
    });
  }

  /* ------------------------------------------------------------ 任务 */

  /** 这一轮该投卡的人(上车的那几个人) */
  pendingMissionActors() {
    const st = this.state;
    if (st.phase !== 'mission') return [];
    return st.team.filter((s) => !(s in st.missionCards));
  }

  /**
   * 上车投卡。
   *
   * ⚠️ **好人只能投 success**:内核直接拒绝 fail(抛错),而不是「接受再改成 success」。
   *    理由:改成 success 会把一个坏掉的 agent 伪装成正常对局,查不出来;
   *    抛错则立刻在日志里现形,runner 会把这一步降级成 success 重记一次(有事件)。
   *
   * @param {number} seat 必须在这轮队伍里
   * @param {'success'|'fail'} card
   */
  playCard(seat, card) {
    const st = this.state;
    if (st.phase !== 'mission') throw new Error('现在不是任务阶段');
    if (!st.team.includes(seat)) throw new Error(`${seat + 1} 号不在这一轮的上车名单里`);
    if (seat in st.missionCards) throw new Error(`${seat + 1} 号已经投过卡了`);
    const c = String(card || '').trim();
    if (c !== 'success' && c !== 'fail') throw new Error(`卡只能是 success / fail(收到 ${card})`);
    const role = st.roles[seat];
    if (c === 'fail' && isGood(role)) {
      throw new Error(`${seat + 1} 号是好人阵营,规则只允许投 success`);
    }
    st.missionCards[seat] = c;
    // 谁出了什么卡:secret(只有本人与上帝视角看得到)
    this._log('secret', 'card', {
      round: st.round, seat, card: c,
      text: `${seat + 1} 号投出 ${c === 'fail' ? '失败' : '成功'}卡`,
    });
    if (!this.pendingMissionActors().length) this._settleMission();
    return this;
  }

  /** 结算本轮任务:数失败票 → 记进 quests → 判胜负 / 进下一轮 */
  _settleMission() {
    const st = this.state;
    const needed = this.failNeed();
    const cards = Object.entries(st.missionCards).map(([s, c]) => ({ seat: Number(s), card: c }));
    const fails = cards.filter((c) => c.card === 'fail').length;
    const result = fails >= needed ? 'fail' : 'success';
    const quest = {
      round: st.round,
      team: st.team.slice(),
      size: st.team.length,
      failNeed: needed,
      fails,
      result,
    };
    st.quests.push(quest);
    if (result === 'success') st.successes += 1;
    else st.fails += 1;

    // ★ 公开的只有「几张失败票 + 结果」;谁出的失败卡在上面那条 secret 事件里,
    //    永远不会出现在 public 账本里(信息隔离的数据层落点)。
    this._log('public', 'quest', {
      round: st.round, team: quest.team.slice(), size: quest.size,
      failNeed: needed, fails, result,
      successes: st.successes, failsTotal: st.fails,
      text: `第 ${st.round} 轮任务${result === 'success' ? '**成功**' : '**失败**'}`
        + `(${fails} 张失败票,需要 ${needed} 张)`
        + ` —— 当前 ${st.successes} 成功 / ${st.fails} 失败`,
    });

    const win = this.checkWin();
    if (win) {
      this._end(win.winner, win.reason);
      return;
    }
    if (st.successes >= 3) {
      // 好人拿到 3 次成功 → 进入刺杀(胜负还没定)
      st.phase = 'assassinate';
      st.assassinTarget = null;
      this._log('public', 'assassinateStart', {
        round: st.round,
        text: '好人已经拿到 3 次任务成功 —— 刺客现在要刺杀梅林。',
      });
      return;
    }
    // 下一轮
    st.round += 1;
    st.leader = (st.leader + 1) % st.alive.length;
    st.proposalNo = 1;
    st.rejects = 0;
    st.team = [];
    st.say = [];
    st.roundVotes = {};
    st.missionCards = {};
    st.phase = 'team';
    this._log('public', 'round', {
      text: `第 ${st.round} 轮任务开始:要 ${this.teamSize()} 人上车,需要 ${this.failNeed()} 张失败票;`
        + `队长是 ${st.leader + 1} 号`,
    });
  }

  /* ------------------------------------------------------------ 刺杀 */

  /** 刺客的座位(世界里找不到就返回 null —— 理论上不可能,变体关掉时也不会有) */
  assassinSeat() {
    const st = this.state;
    const i = st.roles.indexOf('assassin');
    return i >= 0 ? i : null;
  }

  /**
   * 刺客刺杀。
   *
   * 规则:必须刺一个人(不能空刺),不能刺自己;刺中梅林 → 坏人胜,否则好人胜。
   * @param {number} seat 刺客座位
   * @param {number} target
   */
  recordAssassination(seat, target) {
    const st = this.state;
    if (st.phase !== 'assassinate') throw new Error('现在不是刺杀阶段');
    const assassin = this.assassinSeat();
    if (assassin === null) throw new Error('这一局里没有刺客(角色构成有问题)');
    if (seat !== assassin) throw new Error(`刺杀只能由刺客执行(${assassin + 1} 号),不是 ${seat + 1} 号`);
    const t = Math.round(Number(target));
    if (!Number.isInteger(t) || t < 0 || t >= st.alive.length) throw new Error(`刺杀目标非法(${target})`);
    if (t === seat) throw new Error('不能刺杀自己');
    st.assassinTarget = t;
    const hit = st.roles[t] === 'merlin';
    this._log('secret', 'assassinate', {
      seat, target: t, hit,
      text: `刺客 ${seat + 1} 号刺杀 ${t + 1} 号(${hit ? '命中梅林' : '不是梅林'})`,
    });
    this._end(hit ? 'evil' : 'good', hit ? 'assassin-hit' : 'assassin-miss', {
      assassin: seat, target: t,
    });
    return this;
  }

  /* ------------------------------------------------------------ 胜负 */

  /**
   * 判胜负。**规则只有这一份**。
   *   · 3 次任务失败 → 坏人胜(立即,不等刺杀);
   *   · 3 次任务成功 → 还没结束,进刺杀(afterQuest 那边处理);
   *   · 刺杀命中梅林 → 坏人胜;未命中 → 好人胜(在 recordAssassination 里落)。
   * @returns {{winner:'good'|'evil', reason:string}|null}
   */
  checkWin() {
    const st = this.state;
    if (st.phase === 'end') return null;
    if (st.fails >= 3) return { winner: 'evil', reason: 'quests' };
    return null;
  }

  /** @param {string} winner @param {string} reason @param {object} [extra] */
  _end(winner, reason, extra = {}) {
    const st = this.state;
    st.phase = 'end';
    st.winner = winner;
    st.endReason = reason;
    const why = {
      quests: '3 次任务失败',
      'assassin-hit': '刺客刺杀了梅林',
      'assassin-miss': '刺客没刺中梅林',
    }[reason] || reason;
    this._log('public', 'win', {
      ...extra,
      text: `${winner === 'good' ? '好人胜' : '坏人胜'}(${why})`,
      winner, reason,
    });
  }

  /* ------------------------------------------------------------ 账本 */

  /**
   * 追加一条事件。events 是**唯一真相源**:界面、提示词、测试全都从这里读,
   * 所以「谁说了什么、投票结果如何」只有一份记录,不会出现两套历史。
   */
  _log(visibility, kind, data = {}) {
    const st = this.state;
    st.events.push({
      seq: st.events.length + 1,
      round: st.round,
      phase: st.phase,
      visibility,
      kind,
      ...data,
    });
    // 防御:5 轮 × 10 人 × 若干条,正常也就几百条;真出 bug 无限追加时别把内存吃光
    if (st.events.length > 4000) st.events.splice(0, st.events.length - 4000);
  }

  /** 某座位有权读到的账本(public + 自己的 faction/secret)—— 给测试与调试用 */
  eventsFor(seat) {
    const st = this.state;
    const evil = isEvil(st.roles[seat]);
    return st.events.filter((e) => {
      if (e.visibility === 'public') return true;
      if (e.visibility === 'faction') return evil;
      if (e.visibility === 'secret') return e.seat === seat;
      return false;
    });
  }

  /* ------------------------------------------------------------ 快照 */

  /**
   * 打一份快照(给存档层用)。
   * progress 里的 handNo 是**给宿主的通用字段**(存档层与主页「继续上一局」都读它)
   * —— 阿瓦隆这边它就是「第几轮任务」。
   */
  snapshot() {
    const st = JSON.parse(JSON.stringify(this.state));
    return {
      v: SNAPSHOT_VERSION,
      game: 'avalon',
      savedAt: Date.now(),
      progress: {
        handNo: st.round | 0,
        street: st.phase,
        handOver: st.phase === 'end',
        humanSeat: st.config.humanSeat ?? null,
        players: st.alive.length,
      },
      config: JSON.parse(JSON.stringify(this.config)),
      state: st,
    };
  }

  /** 从快照恢复(原位覆盖,不换实例 —— 界面的引用抓着这个 kernel) */
  restore(snap) {
    const { state, config } = AvalonKernel.validateSnapshot(snap);
    this.state = state;
    this.config = config;
    return true;
  }

  /**
   * 校验快照。不合格**抛错**(宿主据此当场丢掉),通过时返回解析出来的
   * {state, config} —— 与扑克 / 卧底 / 狼人杀同一个约定。
   */
  static validateSnapshot(snap) {
    const fail = (why) => { throw new Error(`阿瓦隆的存档不可用:${why}`); };
    if (!snap || typeof snap !== 'object') fail('不是对象');
    if (snap.game !== 'avalon') fail(`这是别的游戏的存档(${String(snap.game)})`);
    if (snap.v !== SNAPSHOT_VERSION) fail(`版本不匹配(存档 v${snap.v},当前 v${SNAPSHOT_VERSION})`);
    const st = snap.state;
    if (!st || typeof st !== 'object') fail('缺少 state');
    if (!Array.isArray(st.alive) || st.alive.length < MIN_SEATS) fail('alive 缺失或人数不足');
    if (!Array.isArray(st.roles) || st.roles.length !== st.alive.length) fail('roles 与座位数对不上');
    if (!Array.isArray(st.events)) fail('events 缺失');
    if (!Array.isArray(st.quests)) fail('quests 缺失');
    if (!['idle', 'team', 'vote', 'mission', 'assassinate', 'end'].includes(st.phase)) {
      fail(`phase 非法(${st.phase})`);
    }
    if (st.winner !== null && st.winner !== 'good' && st.winner !== 'evil') {
      fail(`winner 非法(${st.winner})`);
    }
    if (!st.config || typeof st.config !== 'object') fail('config 缺失');
    if (!VARIANTS.includes(st.config.variant)) fail(`variant 非法(${st.config.variant})`);
    // 存档里**必须**带着身份:否则恢复出来人人都是 undefined,牌桌静默失效
    const bad = st.roles.find((r) => !ROLES.includes(r));
    if (bad !== undefined) fail(`roles 里有非法身份(${bad})`);
    return {
      state: st,
      config: normalizeConfig({ ...st.config, seats: st.alive.length }),
    };
  }
}

/* ------------------------------------------------------------ 纯函数工具 */

/**
 * 把模型给的发言收敛成「1~3 条气泡」。
 * 允许直接给字符串(模型偶尔会这么回),按换行切开 —— 不让「一次糊一大段」
 * 毁掉逐条打字机的节奏。
 */
export function normalizeBubbles(say, max = 3) {
  let list = [];
  if (Array.isArray(say)) list = say.map((s) => String(s ?? ''));
  else if (typeof say === 'string') list = say.split(/[\r\n]+/);
  const out = [];
  for (let s of list) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (s.length > 90) {
      const parts = s.split(/(?<=[。!?！？；;])/).map((x) => x.trim()).filter(Boolean);
      for (const p of parts) if (p) out.push(p);
    } else {
      out.push(s);
    }
  }
  return out.slice(0, max);
}

/** 建一个内核(工厂,宿主 / 测试都用它,不直接 new) */
export function createKernel(cfg, opts) {
  return new AvalonKernel(cfg, opts);
}
