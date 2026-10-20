/**
 * 「谁是卧底」的规则内核 —— **纯函数 + 纯数据**,不碰 LLM、不碰 DOM。
 *
 * 这一层是唯一的裁判:谁拿到什么词、谁该说话、票数够不够、卧底赢没赢,
 * 全部由这里算。AI 的输出一律当**提议**(见 11zhouxuan 那套「kernel 与 agent 分离」),
 * 非法就拒,不靠提示词求它守规矩。
 *
 * ────────────────────────────────────────────────────────────────
 * 规则(口径来自 docs/GAMES-RESEARCH.md 的「谁是卧底」一章)
 *
 *   人数      :5~10 人(界面可选,见 gameDefaults 的 undercover.seats)。6 人 = 5 平民 + 1 卧底
 *              (研究文档推荐的最稳配置);8 人可 2 卧底。
 *   发词      :每人都拿一个词。平民拿同一个,卧底拿相近但不同的那个。
 *              **没有人知道自己属于哪一边** —— 内核知道 roles,但发出去的 view
 *              里没有这个字段(view.js 是唯一出口)。
 *   白板      :`blankCount:1` 时,除卧底之外还有一个人**没有词**(words[i] === '')。
 *              它属于**平民阵营**(胜负判定按平民算),任务是不被投出去。门槛与理由
 *              见 gameDefaults 的 blankCount 注释:seats≥7 才允许,最多 1 个。
 *              ⚠️ 它知道自己「没拿到词」(这是它的私有信息,不给就演不了),
 *                 但**不告诉它这意味着它属于哪一边** —— 一旦说了,它立刻变成
 *                 一个「知道自己不是卧底」的人,这个游戏的灵魂就没了。
 *   猜词      :描述轮轮到某人时,它可以**放弃描述、改为猜平民的词**(见 recordGuess)。
 *              · 真正的**卧底**猜中 → 卧底立即获胜(本局直接结束);
 *              · 真正的**卧底**猜错 → 卧底立即失败(平民胜);
 *              · **平民 / 白板**去猜 → 该玩家立即出局,局继续,**不做**卧底获胜判定
 *                (「不能让人一个人害全队」——它就是自己送死,不牵动胜负)。
 *              判定为什么必须这么写:平民**本来就知道**平民词,所以「平民猜对」
 *              毫无信息量、不能算赢;卧底不知道平民词,猜中才是真本事。而因为
 *              **没人知道自己是谁**,「我要不要猜」本身就是一次赌博 —— 这正是要的张力。
 *   一轮      :描述轮(按顺序每人一句)→ 投票轮(每人一票)→ 公布 → (无人平票时)淘汰。
 *   平票      :本轮无人出局(研究文档建议砍掉 PK 重投,节奏更快)。
 *   出局公开  :被投出去的人**公开阵营**(研究文档「必须做决定的流派点」:公开,
 *              否则平民拿不到任何反馈,AI 会瞎投)。
 *   胜负      :平民胜 = 所有卧底出局;
 *              卧底胜 = 卧底活到「只剩 N 人」,**N 取决于开局人数**:
 *                       <6 人局 N=2,≥6 人局 N=3(九游口径,研究文档采用)。
 *              例外:卧底**猜词猜中**直接判卧底胜、**猜错**直接判平民胜(不看到不到阈值)。
 *   轮次上限  :默认 4 轮。到上限还没分出胜负 → 按「卧底有没有撑到人数阈值」判:
 *              存活人数 ≤ 阈值 → 卧底胜,否则平民胜(撑满 4 轮 = 没让卧底达到胜利条件)。
 *              为什么这么定:6 人局每轮淘汰一人,第 3 轮就必然触及阈值,
 *              4 轮只是安全阀;真打到上限说明连续平票,判平民胜比判卧底胜更合理
 *              (卧底并没有达成「活到只剩 3 人」)。
 *
 * ────────────────────────────────────────────────────────────────
 * ⚠️ 三个容易写错的地方(都有测试盯着)
 *
 *   · **描述顺序每轮随机起始座位、方向固定**(研究文档建议):固定从 1 号开始会让
 *     后说的人有「抄前面」的优势。随机源是注入的 rand,测试里换成种子随机源即可复现。
 *   · **发词之后不许再改**:words/roles 在 start() 里一次定死,snapshot / restore
 *     原样搬运。中途重算会让「卧底明明换了词」这种事静默发生。
 *   · **淘汰判定只看票数,不看 AI 的理由**:票投给了谁就是谁,理由只是公开文本。
 *     AI 说「我投 3 号」但 vote 字段写 4 号时,以字段为准(它是动作,话是修辞)。
 *   · **猜词的文字在局中不是公开信息**:平民/白板猜的词一旦公布,场上还活着的
 *     卧底就白得了平民词。所以 recordGuess 只把「谁猜了、猜得对不对」写进公开的
 *     guesses;**猜的那个词**只在「猜的人是卧底」或「本局已经结束」时才算公开
 *     (view.js 的 publicGuesses 按这条规则截断,屏幕层不许绕过它直接读 state.guesses)。
 */

import { pickWordPair } from '../words.js';

/** 快照版本。结构一变就 +1,旧档会被 validateSnapshot 丢掉。
 *  v2:加了白板(roles 里出现 'blank'、words 里是空串)与猜词记录(state.guesses)。
 *  旧档(state 里没有 guesses)一律丢掉 —— 那是「一局打到一半的存档」,
 *  丢掉只是这一局要重开,而带着半份结构跑会静默出错(比如 guesses 是 undefined)。 */
export const SNAPSHOT_VERSION = 2;

/** 胜负阈值:开局人数 <6 → 卧底活到剩 2 人胜;≥6 → 剩 3 人胜(九游口径)。 */
export function winThreshold(seats) {
  return Number(seats) >= 6 ? 3 : 2;
}

/** 白板的最低人数门槛(与 gameDefaults 的 blankCount 注释同源) */
export const BLANK_MIN_SEATS = 7;

/** 阵营中文名(公开信息用:出局/结算时它就是公开的) */
export function roleLabel(role) {
  if (role === 'undercover') return '卧底';
  if (role === 'blank') return '白板';
  return '平民';
}

/** 白板在**胜负**上算平民阵营:只有 'undercover' 是另一边,其余一切都是平民阵营。 */
export function campOf(role) {
  return role === 'undercover' ? 'undercover' : 'civilian';
}

/**
 * 把「猜的那个词」收敛成可比较的形式:去空白、去引号/句末标点、全角空格。
 * 为什么要清洗:模型很爱输出「"牛奶"」「牛奶。」这类包裹,直接和 civilianWord
 * 比永远不等 —— 那就变成「卧底明明猜对了却判输」,而这正是这个机制最不能出错的地方。
 */
export function normalizeGuess(raw) {
  return String(raw ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^["'“”‘’「」『』《》【】()（）]+|["'“”‘’「」『』《》【】()（）]+$/g, '')
    .replace(/[。.!！?？,，、;；:：]+$/g, '')
    .slice(0, 12);
}

/**
 * 洗牌(Fisher–Yates),随机源注入。
 * 不用 sort(() => rand()-0.5):那个分布的偏差在 6 人局里就能看出来,
 * 而且不同引擎的结果不一致(测试会偶发红)。
 */
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 把配置夹到合法范围 —— 手改配置写出 seats:99 也不该把局开崩 */
function normalizeConfig(cfg = {}) {
  const seats = Math.max(4, Math.min(10, Math.round(Number(cfg.seats) || 6)));
  // 卧底人数上限:**5~6 人局只允许 1 个**,7 人起才允许 2 个,并且永远不超过 2。
  //
  // 为什么不是「不超过 floor((seats-1)/2)」那种纯数学夹取:那个公式在 5 人局会给出
  // 2 个卧底(3 平民 vs 2 卧底),平民要连着投对两次才赢、卧底只要搅一次局 ——
  // 实测十局里平民一把没赢过,纯属坏局。研究文档(GAMES-RESEARCH.md)的口径也是
  // 「6 人 1 个卧底、8 人 2 个」,而 2 个卧底起步需要 7 人以上给平民留出容错。
  const maxUnder = seats < 7 ? 1 : Math.min(2, Math.max(1, Math.floor((seats - 1) / 2)));
  const undercoverCount = Math.max(1, Math.min(maxUnder, Math.round(Number(cfg.undercoverCount) || 1)));
  const rounds = Math.max(1, Math.min(10, Math.round(Number(cfg.rounds) || 4)));
  const difficulty = ['easy', 'normal', 'hard'].includes(cfg.difficulty) ? cfg.difficulty : 'normal';
  // 白板:人数不够就归 0(而不是报错)。理由:界面上这一格在 <7 人时是 disabled,
  // 但配置是**手改得动**的;让「配置写 1、人数 5」开出一局带白板的 5 人局会很难查。
  // 另外还要给卧底留位置:seats - undercoverCount 至少 2 个平民阵营的人才有推理材料。
  const blankWant = Math.round(Number(cfg.blankCount) || 0) >= 1 ? 1 : 0;
  const blankCount = (seats >= BLANK_MIN_SEATS && seats - undercoverCount >= 3) ? blankWant : 0;
  const humanSeat = Number.isInteger(cfg.humanSeat) && cfg.humanSeat >= 0 && cfg.humanSeat < seats
    ? cfg.humanSeat : null;
  return { seats, undercoverCount, blankCount, rounds, difficulty, humanSeat };
}

/** 一局牌的初始状态(还没发词)。单独抽出来,restore 与 start 共用同一个形状。 */
function blankState(config) {
  return {
    game: 'undercover',
    config,
    /** 第几轮(1 起;0 = 还没开始) */
    round: 0,
    /** idle | describe | vote | reveal | end */
    phase: 'idle',
    /** 本轮描述顺序(座位号数组)与进行到第几个 */
    order: [],
    orderIdx: 0,
    /** 存活标记(与座位号同长) */
    alive: new Array(config.seats).fill(true),
    /** 已出局:[{seat, round, role}]。role 是公开信息(出局即公开阵营) */
    eliminated: [],
    /** 座位显示名(由界面给,内核只存不解释) */
    names: [],
    /** 每个人拿到的词 —— **私有**,只能通过 view.js 按座位发出去 */
    words: [],
    /** 每个人真实的阵营 —— **私有**,只有上帝视图与裁判读它 */
    roles: [],
    civilianWord: '',
    undercoverWord: '',
    /** 公开描述:[{round, seat, say, quality}] */
    descriptions: [],
    /**
     * 猜词记录:[{round, seat, role, text, hit}]
     * role / text / hit 是**裁判视角**的完整记录 —— 公开到哪一步由 view.js 的
     * publicGuesses 决定(见文件头「猜词的文字在局中不是公开信息」)。
     */
    guesses: [],
    /** 公开投票:[{round, from, to, reason}] to=null 表示弃票 */
    votes: [],
    winner: null,           // null | 'civilian' | 'undercover'
    endReason: null,        // null | 'undercoverOut' | 'threshold' | 'rounds' | 'guessRight' | 'guessMiss'
    /** 主持人公告(公开):谁第几轮说了什么、谁出局、谁赢了 */
    log: [],
  };
}

export class UndercoverKernel {
  /**
   * @param {object} cfg { seats, undercoverCount, rounds, difficulty, humanSeat }
   * @param {{rand?:()=>number, wordPair?:object}} [opts]
   *   rand     随机源(测试传种子随机源 → 同一局可复现)
   *   wordPair 指定词对(测试用;不传就按 difficulty 从词库抽)
   */
  constructor(cfg = {}, opts = {}) {
    this.config = normalizeConfig(cfg);
    this.rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
    this._wordPair = opts.wordPair || null;
    this.state = blankState(this.config);
  }

  /* ------------------------------------------------------------ 开局 */

  /** 发词 + 定阵营 + 进入第 1 轮描述。只能调一次(重复调会重发词)。 */
  start(names = []) {
    const st = this.state;
    if (st.phase !== 'idle') throw new Error('这局已经开始了(start 只能调一次)');
    const { seats, undercoverCount, blankCount, difficulty } = this.config;
    const pair = this._wordPair || pickWordPair({ difficulty, rand: this.rand });
    st.civilianWord = pair.c;
    st.undercoverWord = pair.u;

    // 先随机定卧底/白板座位,再按座位发词。
    // ⚠️ 顺序要紧:先发词再定卧底的话,后一步会把已经发出去的词改掉一半,
    //    restore 出来的局面就可能出现「卧底拿的是平民词」这种内部矛盾。
    // 座位先打乱一次,前 undercoverCount 个是卧底,紧接着 blankCount 个是白板,
    // 剩下的是平民 —— 一次洗牌定三种身份,不会出现「白板占掉了卧底的名额」。
    const seatsArr = Array.from({ length: seats }, (_, i) => i);
    const shuffled = shuffle(seatsArr, this.rand);
    const underSeats = new Set(shuffled.slice(0, undercoverCount));
    const blankSeats = new Set(shuffled.slice(undercoverCount, undercoverCount + blankCount));
    st.roles = seatsArr.map((s) => (underSeats.has(s) ? 'undercover'
      : blankSeats.has(s) ? 'blank' : 'civilian'));
    // 白板**没有词**:words[座位] 是空串。空串是「没有」,不是「还没发」——
    // 发词是这一句里一次做完的,之后没有任何代码会再往里写。
    st.words = seatsArr.map((s) => (underSeats.has(s) ? st.undercoverWord
      : blankSeats.has(s) ? '' : st.civilianWord));
    st.names = st.roles.map((_, seat) => String(names[seat] ?? `${seat + 1}号`));

    st.round = 1;
    this._startRound();
    this._log(1, 'deal', `已发词:${seats} 人,其中 ${undercoverCount} 个卧底`
      + `${blankCount ? `、${blankCount} 个白板(没有词)` : ''}(阵营只有主持人知道)`);
    return this;
  }

  /** 本轮描述顺序:随机起始座位,方向固定(+1 座位号,跳过出局者) */
  _startRound() {
    const st = this.state;
    const aliveSeats = [];
    for (let s = 0; s < st.alive.length; s++) if (st.alive[s]) aliveSeats.push(s);
    const start = aliveSeats[Math.floor(this.rand() * aliveSeats.length)] ?? 0;
    // 从随机起点沿座位号递增绕一圈(只排存活的人)—— 方向固定,观众跟得上
    const order = [];
    for (let k = 0; k < st.alive.length; k++) {
      const s = (start + k) % st.alive.length;
      if (st.alive[s]) order.push(s);
    }
    st.order = order;
    st.orderIdx = 0;
    st.phase = 'describe';
    st.votes = st.votes.filter((v) => v.round !== st.round);   // 防御:重进本轮时清掉旧票
    this._log(st.round, 'round', `第 ${st.round} 轮开始,描述顺序:${order.map((s) => `${s + 1}号`).join(' → ')}`);
  }

  /* ------------------------------------------------------------ 描述轮 */

  /** 现在该谁描述;描述轮结束(或不在描述轮)返回 null */
  currentSpeaker() {
    const st = this.state;
    if (st.phase !== 'describe') return null;
    return st.order[st.orderIdx] ?? null;
  }

  /**
   * 记一句描述。**只接受当前该说话的那个人**,座位不对直接拒 ——
   * 这是「LLM 的输出只是提议」的落实点:乱序的发言不许改写局面。
   *
   * @param {number} seat
   * @param {string} say 已经过 filter 的公开描述
   * @param {{quality?:string, selfRead?:string}} [meta]
   *   quality:'low' = 这是确定性兜底句;selfRead = AI 对自己阵营的猜测(上帝模式看的关键字段)
   */
  recordDescription(seat, say, meta = {}) {
    const st = this.state;
    const cur = this.currentSpeaker();
    if (cur === null) throw new Error('现在不是描述轮');
    if (seat !== cur) throw new Error(`现在该 ${cur + 1} 号描述,不是 ${seat + 1} 号`);
    const text = String(say ?? '').trim();
    if (!text) throw new Error('描述不能为空(卧底里没有「跳过」这个动作)');
    const selfRead = ['civilian', 'undercover', 'unsure'].includes(meta.selfRead) ? meta.selfRead : 'unsure';
    st.descriptions.push({
      round: st.round, seat, say: text, selfRead,
      quality: meta.quality === 'low' ? 'low' : 'ok',
    });
    this._log(st.round, 'describe', `${seat + 1}号:${text}`);
    st.orderIdx += 1;
    if (st.orderIdx >= st.order.length) {
      st.phase = 'vote';
      this._log(st.round, 'voteStart', `第 ${st.round} 轮描述结束,开始投票`);
    }
    return this;
  }

  /* ------------------------------------------------------------ 猜词 */

  /**
   * 描述轮:轮到的这个人**放弃描述**,改为猜「平民的词」。
   *
   * ────────────────────────────────────────────────────────────────
   * 判定为什么是现在这样(这是这个机制的灵魂,改之前先读完)
   *
   *   · 平民**本来就知道**平民词 —— 所以「平民猜对了」这件事毫无信息量,
   *     绝不能因为猜对就判平民赢(那会让一局在第一个平民开口时就结束)。
   *     所以平民/白板一猜就**出局**,对错都不改变局面,只是把一个队友送走。
   *   · 卧底**不知道**平民词,猜中才是真本事 —— 所以卧底猜中直接获胜,
   *     猜错直接失败(等于当众认输)。
   *   · 因为**没人知道自己是谁**(白板除外,但白板也不知道自己属于哪一边),
   *     「我要不要猜」本身就是一次赌博:你可能正拿着卧底词、也可能只是个平民。
   *     这条张力是这个玩法唯一的乐趣来源,别把它「优化」掉。
   *
   * 平民猜词被淘汰时**不做**卧底获胜判定:规则写的是「不能让人一个人害全队」,
   * 所以这一下只死一个人,局面照常往下走(该轮的描述继续、或者直接进投票)。
   * 后面的胜负仍然由常规路径(卧底全部出局 / 存活到阈值 / 轮次上限)决定 ——
   * 也就是说,一个平民乱猜顶多把自己投出去,不会顺手把整队卖了。
   *
   * @param {number} seat 必须正好是当前该描述的人
   * @param {string} raw  猜的词(会做 normalizeGuess:引号/句号/空白都剥掉)
   * @returns {{seat:number, role:string, hit:boolean, ended:boolean,
   *            winner:null|string, eliminated:number|null,
   *            publicText:string, publicHit:boolean}}
   *   publicText = **能公开的那个词**:只有「猜的人是卧底」时才给(本局立刻结束,
   *   没有泄漏面);平民/白板猜的词一律是空串(公开了就等于把平民词送给还活着的卧底)。
   *   publicHit = 猜没猜中。它对谁都公开 —— 它只说明「这个词对不对」,不透露词是什么
   *   (卧底听到「他猜中了」也学不到平民词)。
   */
  recordGuess(seat, raw) {
    const st = this.state;
    const cur = this.currentSpeaker();
    if (st.phase !== 'describe') throw new Error('现在不是描述轮(只有轮到你描述时才能改猜词)');
    if (seat !== cur) throw new Error(`现在该 ${cur + 1} 号行动,不是 ${seat + 1} 号`);
    const text = normalizeGuess(raw);
    if (!text) throw new Error('猜的词不能为空');
    const role = st.roles[seat];
    const hit = text === st.civilianWord;
    // 完整记录留在 state(裁判视角),公开到哪一步由 view.publicGuesses 决定
    st.guesses.push({ round: st.round, seat, role, text, hit });
    // 猜词也消耗掉这个人的发言位:orderIdx 往后一格(先移出 order 再让下标停在
    // 下一个还没说话的人身上 —— 与 recordDescription 里的 +1 等价,见下面的分支)
    st.order = st.order.filter((s) => s !== seat);

    if (role === 'undercover') {
      this._log(st.round, 'guess',
        `${seat + 1}号放弃描述,猜词「${text}」 —— ${hit ? '猜中了' : '猜错了'}`);
      if (hit) this._end('undercover', 'guessRight');
      else this._end('civilian', 'guessMiss');
      return {
        seat, role, hit, ended: true, winner: st.winner, eliminated: null,
        publicText: text, publicHit: hit,
      };
    }

    // 平民 / 白板:对错不重要,一律出局。文案里**不报对错也不报词** ——
    // 报词等于把平民词公开(卧底白得答案),报对错则是一句没有意义的信息。
    this._log(st.round, 'guess',
      `${seat + 1}号放弃描述,改为猜词 —— 猜词是卧底的活,${roleLabel(role)}猜词直接出局`);
    st.alive[seat] = false;
    st.eliminated.push({ seat, round: st.round, role });
    // 该轮剩下的描述继续(描述顺序里已经摘掉了他);他要是本轮最后一个,就进投票
    if (st.orderIdx >= st.order.length) {
      st.phase = 'vote';
      this._log(st.round, 'voteStart', `第 ${st.round} 轮描述结束,开始投票`);
    }
    return {
      seat, role, hit, ended: false, winner: null, eliminated: seat,
      publicText: '', publicHit: hit,
    };
  }

  /* ------------------------------------------------------------ 投票轮 */

  /** 某座位能投的人(存活、且不是自己)。已投过的人不再返回。 */
  voteCandidates(seat) {
    const st = this.state;
    if (st.phase !== 'vote') return [];
    if (!st.alive[seat]) return [];
    const voted = new Set(st.votes.filter((v) => v.round === st.round).map((v) => v.from));
    if (voted.has(seat)) return [];
    const out = [];
    for (let s = 0; s < st.alive.length; s++) {
      if (s !== seat && st.alive[s]) out.push(s);
    }
    return out;
  }

  /** 这一轮还没投票的座位 */
  pendingVoters() {
    const st = this.state;
    if (st.phase !== 'vote') return [];
    const voted = new Set(st.votes.filter((v) => v.round === st.round).map((v) => v.from));
    const out = [];
    for (let s = 0; s < st.alive.length; s++) if (st.alive[s] && !voted.has(s)) out.push(s);
    return out;
  }

  /**
   * 记一票。
   *
   * @param {number} from
   * @param {number|null} to 目标座位;null = **弃票**(解析失败时的确定性降级)
   * @param {string} [reason] 公开理由(≤25 字,已过 filter)
   */
  recordVote(from, to, reason = '') {
    const st = this.state;
    if (st.phase !== 'vote') throw new Error('现在不是投票轮');
    if (!st.alive[from]) throw new Error(`${from + 1} 号已经出局,不能投票`);
    if (st.votes.some((v) => v.round === st.round && v.from === from)) {
      throw new Error(`${from + 1} 号这一轮已经投过了`);
    }
    let target = null;
    if (to !== null && to !== undefined) {
      const t = Math.round(Number(to));
      if (!Number.isInteger(t) || t < 0 || t >= st.alive.length) throw new Error(`投票目标非法(${to})`);
      if (t === from) throw new Error('不能投自己');
      if (!st.alive[t]) throw new Error(`${t + 1} 号已经出局,不能投他`);
      target = t;
    }
    st.votes.push({ round: st.round, from, to: target, reason: String(reason || '').slice(0, 40) });
    this._log(st.round, 'vote', target === null
      ? `${from + 1}号弃票`
      : `${from + 1}号 → ${target + 1}号(${String(reason || '').slice(0, 24)})`);
    if (!this.pendingVoters().length) this._settleVote();
    return this;
  }

  /**
   * 统计本轮票数。抽成纯函数是为了让测试能**单独验平票**,
   * 也让「谁被投出去了」只有一份算法。
   * @param {object[]} votes 一局的 votes(只统计 round 等于当前轮的)
   * @param {number} round
   * @returns {{tally:number[], top:number[], abstain:number}}
   */
  tallyVotes(votes = this.state.votes, round = this.state.round) {
    const tally = new Array(this.state.alive.length).fill(0);
    let abstain = 0;
    for (const v of votes) {
      if (v.round !== round) continue;
      if (v.to === null || v.to === undefined) { abstain += 1; continue; }
      tally[v.to] += 1;
    }
    let best = 0;
    for (const n of tally) if (n > best) best = n;
    const top = [];
    if (best > 0) for (let s = 0; s < tally.length; s++) if (tally[s] === best) top.push(s);
    return { tally, top, abstain };
  }

  /**
   * 结算这一轮:淘汰 / 平票 / 判胜负 / 进下一轮。
   * @returns {{eliminated:number|null, tie:boolean, winner:string|null}}
   */
  _settleVote() {
    const st = this.state;
    const { top, tally } = this.tallyVotes();
    st.phase = 'reveal';
    const record = { eliminated: null, tie: false, winner: null };

    if (top.length === 1) {
      const seat = top[0];
      st.alive[seat] = false;
      const role = st.roles[seat];
      st.eliminated.push({ seat, round: st.round, role });
      record.eliminated = seat;
      this._log(st.round, 'eliminate',
        `${seat + 1}号以 ${tally[seat]} 票出局 —— 他是${role === 'undercover' ? '卧底' : '平民'}`);
      // 所有卧底都出局 = 平民胜(2 卧底局要全投出去)
      if (!st.roles.some((r, s) => r === 'undercover' && st.alive[s])) {
        this._end('civilian', 'undercoverOut');
        record.winner = 'civilian';
        return record;
      }
      // 卧底还活着:活到人数阈值了吗?
      const alive = st.alive.filter(Boolean).length;
      if (alive <= winThreshold(st.config.seats)) {
        this._end('undercover', 'threshold');
        record.winner = 'undercover';
        return record;
      }
    } else {
      // 平票 / 全员弃票:本轮无人出局(研究文档:砍掉 PK 重投)
      record.tie = top.length > 1;
      this._log(st.round, 'tie', top.length > 1
        ? `${top.map((s) => `${s + 1}号`).join('、')} 平票,本轮无人出局`
        : '本轮没人得票,无人出局');
    }

    if (st.round >= st.config.rounds) {
      this._endByRounds();
      record.winner = st.winner;
      return record;
    }

    st.round += 1;
    this._startRound();
    return record;
  }

  /**
   * 轮次用尽 → 按「卧底有没有撑到人数阈值」判终局(研究文档:超时按人数判定)。
   *
   * 单独抽出来是给 repairTurn 复用的:结算中途被打断(进程退出 / 存档停在 reveal)
   * 之后要能走同一个出口。规则只有这一份 —— 两处各写一遍迟早漂移。
   */
  _endByRounds() {
    const alive = this.state.alive.filter(Boolean).length;
    if (alive <= winThreshold(this.state.config.seats)) this._end('undercover', 'rounds');
    else this._end('civilian', 'rounds');
    return this.state.winner;
  }

  /**
   * 「回合推进卡住了」的**确定性修复**。runner 在发现「状态没往前走」时调它。
   *
   * 为什么需要:三种情况会让 runner 的 for(;;) 永远等不到下一步 ——
   *
   *   · `phase === 'reveal'`:投票结算的中间态。正常 <1ms 就离开了,但如果进程
   *     **正好死在那一刻**(关窗口 / 浏览器崩),存档里就会留下一个 reveal。
   *     恢复之后 runner 只认识 describe/vote/end,于是当场抛「意外阶段」——
   *     用户看到的就是「上一轮打完了,下一轮永远不开」。
   *   · `phase === 'describe'` 却没有当前发言者(order 空 / orderIdx 越界):
   *     快照结构合法但语义坏掉时会出现。原代码是 `continue`,那就是**死转**。
   *   · `phase === 'vote'` 但没有待投的人:票已经记满却没结算(同样来自坏存档)。
   *
   * 修复原则:**绝不猜结果**。reveal 一律按「本轮无人出局」收尾(不重复淘汰、
   * 不重算票),describe 空着就直接进投票,vote 满了就结算。这样即使存档是坏的,
   * 局也能走到一个**规则允许的**终局,而不是永远停在那儿。
   *
   * @returns {string|null} 修了什么(给 runner 广播 repair 事件);无事可修返回 null
   */
  repairTurn() {
    const st = this.state;
    if (st.phase === 'end') return null;
    if (st.phase === 'reveal') {
      // 结算被打断:当作「本轮已结算、无人出局」继续推进(幂等,不重算票)
      this._log(st.round, 'repair', '结算被打断,按「本轮无人出局」继续');
      if (st.round >= st.config.rounds) this._endByRounds();
      else { st.round += 1; this._startRound(); }
      return 'reveal';
    }
    if (st.phase === 'describe' && this.currentSpeaker() === null) {
      this._log(st.round, 'repair', '描述轮没有当前发言者,直接进投票');
      st.phase = 'vote';
      return 'describe';
    }
    if (st.phase === 'vote' && !this.pendingVoters().length) {
      this._log(st.round, 'repair', '投票轮票已记满却没有结算,补一次结算');
      this._settleVote();
      return 'vote';
    }
    return null;
  }

  _end(winner, reason) {
    const st = this.state;
    st.phase = 'end';
    st.winner = winner;
    st.endReason = reason;
    const why = reason === 'undercoverOut' ? '卧底全部出局'
      : reason === 'threshold' ? `存活人数已到 ${winThreshold(st.config.seats)} 人`
        : reason === 'guessRight' ? '卧底猜中了平民的词'
          : reason === 'guessMiss' ? '卧底猜错了平民的词'
            : '轮次上限';
    this._log(st.round, 'end', winner === 'civilian' ? `平民胜(${why})` : `卧底胜(${why})`);
  }

  _log(round, kind, text) {
    this.state.log.push({ round, kind, text });
    // 日志只作展示,不参与判定;但要防它无限长(4 轮 × 8 人也就是几十条)
    if (this.state.log.length > 400) this.state.log.splice(0, this.state.log.length - 400);
  }

  /* ------------------------------------------------------------ 快照 */

  /**
   * 打一份快照(给 shared/gameStore.js 用,它只要求 engine.snapshot())。
   *
   * progress 里的 handNo 是**给宿主的通用字段**:shared/gameStore 的 snapshotInfo
   * 与主页「继续上一局(第 N 手)」都读它 —— 卧底这边它就是「第 N 轮」。
   * 不新造字段名,是为了让存档层保持游戏无关。
   */
  snapshot() {
    const st = JSON.parse(JSON.stringify(this.state));
    return {
      v: SNAPSHOT_VERSION,
      game: 'undercover',
      savedAt: Date.now(),
      progress: {
        handNo: st.round | 0,          // = 第几轮
        street: st.phase,              // = describe / vote / reveal / end
        handOver: st.phase === 'end',
        humanSeat: st.config.humanSeat ?? null,
        players: st.alive.filter(Boolean).length,
      },
      config: JSON.parse(JSON.stringify(this.config)),
      state: st,
    };
  }

  /** 从快照恢复(原位覆盖,不换实例 —— 界面的引用抓着这个 kernel) */
  restore(snap) {
    const { state, config } = UndercoverKernel.validateSnapshot(snap);
    this.state = state;
    this.config = config;
    return true;
  }

  /**
   * 校验快照。不合格**抛错**(宿主据此当场丢掉),通过时返回解析出来的
   * {state, config} —— 与 poker 的 validateSnapshot 同一个约定。
   */
  static validateSnapshot(snap) {
    const fail = (why) => { throw new Error(`谁是卧底的存档不可用:${why}`); };
    if (!snap || typeof snap !== 'object') fail('不是对象');
    if (snap.game !== 'undercover') fail(`这是别的游戏的存档(${String(snap.game)})`);
    if (snap.v !== SNAPSHOT_VERSION) fail(`版本不匹配(存档 v${snap.v},当前 v${SNAPSHOT_VERSION})`);
    const st = snap.state;
    if (!st || typeof st !== 'object') fail('缺少 state');
    if (!Array.isArray(st.alive) || st.alive.length < 4) fail('alive 缺失或人数不足');
    if (!Array.isArray(st.words) || st.words.length !== st.alive.length) fail('words 与座位数对不上');
    if (!Array.isArray(st.roles) || st.roles.length !== st.alive.length) fail('roles 与座位数对不上');
    // 白板在 words 里是**空串**,所以这里不能要求每个词都非空;但角色的取值必须认识。
    if (!st.roles.every((r) => r === 'civilian' || r === 'undercover' || r === 'blank')) {
      fail(`roles 里有认不出的角色(${JSON.stringify(st.roles)})`);
    }
    if (!Array.isArray(st.descriptions) || !Array.isArray(st.votes)) fail('descriptions / votes 缺失');
    // v2 起 guesses 必须存在:它是这一局的公开历史之一(谁猜过、猜没猜中)
    if (!Array.isArray(st.guesses)) fail('guesses 缺失(v1 的旧档?)');
    if (!['idle', 'describe', 'vote', 'reveal', 'end'].includes(st.phase)) fail(`phase 非法(${st.phase})`);
    if (st.winner !== null && st.winner !== 'civilian' && st.winner !== 'undercover') {
      fail(`winner 非法(${st.winner})`);
    }
    if (!st.config || typeof st.config !== 'object') fail('config 缺失');
    // 存档里**必须**带着词:否则恢复出来的局没有词可描述(静默变成空字符串)
    if (typeof st.civilianWord !== 'string' || !st.civilianWord) fail('civilianWord 缺失');
    if (typeof st.undercoverWord !== 'string' || !st.undercoverWord) fail('undercoverWord 缺失');
    return {
      state: st,
      config: normalizeConfig({ ...st.config, seats: st.alive.length }),
    };
  }
}

/** 建一个内核(工厂,宿主 / 测试都用它,不直接 new) */
export function createKernel(cfg, opts) {
  return new UndercoverKernel(cfg, opts);
}
