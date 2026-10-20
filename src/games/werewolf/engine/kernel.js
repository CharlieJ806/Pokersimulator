/**
 * 「狼人杀」的规则内核 —— **纯函数 + 纯数据**,不碰 LLM、不碰 DOM。
 *
 * 这一层是唯一的裁判:谁是什么身份、夜里谁死了、谁被投出去、哪一边赢,
 * 全部由这里算。AI 的输出一律当**提议**(研究文档「An Implementation of Werewolf
 * Agent That does not Truly Trust LLMs」的主张),非法就拒,
 * 不靠提示词求它守规矩。
 *
 * ────────────────────────────────────────────────────────────────
 * 规则(口径来自 docs/GAMES-RESEARCH.md 的「狼人杀」一章,MVP 口径)
 *
 *   人数     :**可选 6~12 人**(用户明确要求,和卧底一样不写死)。
 *              每个档位的配置见 ROSTER_TABLE —— 狼人恒占 1/3 左右,
 *              预言家、女巫各 1 个,其余全是平民。
 *   角色     :狼人 / 预言家 / 女巫 / 平民。**没有守卫、没有猎人、没有白痴**。
 *              ⚠️ 白痴(白板)在用户口径里**不属于狼人杀**,所以整套「翻牌不死 /
 *              失去投票权」的实现与字段都不存在 —— 不是留着没用,是根本没写。
 *   流程     :夜里(狼刀 → 验人 → 女巫用药)→ 天亮公布死讯(**不公开身份**)
 *              → 白天发言 → 放逐投票 → 判胜负 → 下一夜。
 *   平票     :本轮无人出局(研究文档建议砍掉 PK 重投,节奏更快)。
 *   出局不公开身份:只有「谁死了」是公开信息,死的是狼还是神只有主持人知道 ——
 *              这是整个游戏推理空间的来源,一旦公开立刻塌掉。
 *   胜负(★ **可切换**,用户要求实测哪种更接近五五开):
 *      · winCondition:'side'(屠边)= 杀光**全部平民** 或 杀光**全部神职**
 *        (神职 = 预言家 + 女巫;本 MVP 只有两个神,所以屠边比完整板子更容易达成);
 *      · winCondition:'all'(屠城)= 杀光**所有好人**(神职 + 平民一个不剩)。
 *   好人胜   :所有狼人出局(两种规则下都一样)。
 *   天数上限 :MAX_DAYS = 6 天。到时按「存活狼数 ≥ 存活好人数 → 狼胜,否则好人胜」判。
 *              为什么定 6 天:6~12 人局每天至少走 1~2 个人,第 6 天场上基本只剩
 *              2~3 人,再拖下去只是互相空过;而且这个上限同时是「AI 打不完」的
 *              安全阀(12 人局一天 20+ 次调用,6 天已经是成本上限)。
 *
 * ⚠️ 三个容易写错的地方(都有测试盯着)
 *
 *   · **夜里的刀口在白天任何发言之前就锁定了**:所以「他今天跳预言家,所以昨晚
 *     被刀」这种推理是时间线倒置(研究文档「坑 2」)。内核里刀口是 night 阶段
 *     算完就写进事件的,白天只读不改 —— 结构上就倒不过来。
 *   · **发言顺序每轮随机起始座位、方向固定**:固定从 1 号开始会让后说的人有
 *     「针对前面的人发言」的优势(研究文档「坑 10 位置偏置」)。随机源注入,
 *     测试里换成种子随机源即可复现。
 *   · **身份在 start() 里一次定死**:roles 之后不再变,snapshot / restore 原样搬运。
 *     中途重算会出现「同一个人上半场是狼下半场是民」这种静默的灾难。
 */

/** 快照版本。结构一变就 +1,旧档会被 validateSnapshot 丢掉。 */
export const SNAPSHOT_VERSION = 1;

/** 人数范围(用户要求可选,不写死;与卧底同一个口径) */
export const MIN_SEATS = 6;
export const MAX_SEATS = 12;

/** 天数上限(见文件头说明:既是规则收尾,也是成本安全阀) */
export const DEFAULT_MAX_DAYS = 6;

/** 两种胜负规则 —— 提示词里必须写清当前用的是哪一种(研究文档硬要求) */
export const WIN_CONDITIONS = ['side', 'all'];

/** 本 MVP 存在的四个角色(白痴/守卫/猎人**不在其中**) */
export const ROLES = ['werewolf', 'seer', 'witch', 'villager'];

/**
 * 人数 → 角色构成。
 *
 * 为什么预热一张表而不是「按比例算」:狼人杀的板子是**人为调过平衡的整数**,
 * 用比例取整会出现「7 人 2.33 个狼」这种没法落地的结果,而且改一档人数就可能
 * 连带把别的档位也改了 —— 平衡实测(tools/werewolfbalance.mjs)要对得上具体数字,
 * 表比公式好复核。
 *
 * 狼人恒约占 1/3;神职固定「预言家 + 女巫」各 1(研究文档:MVP 只保留
 * 夜刀 / 验人 / 发言 / 投票 / 不公开身份,女巫是第二个该加的角色)。
 */
const ROSTER_TABLE = {
  6: { werewolf: 2, seer: 1, witch: 1, villager: 2 },
  7: { werewolf: 2, seer: 1, witch: 1, villager: 3 },
  8: { werewolf: 2, seer: 1, witch: 1, villager: 4 },
  9: { werewolf: 3, seer: 1, witch: 1, villager: 4 },
  10: { werewolf: 3, seer: 1, witch: 1, villager: 5 },
  11: { werewolf: 3, seer: 1, witch: 1, villager: 6 },
  12: { werewolf: 4, seer: 1, witch: 1, villager: 6 },
};

/**
 * 按人数取角色构成(纯函数,不碰实例状态)。
 * @param {number} seats
 * @returns {{werewolf:number, seer:number, witch:number, villager:number}}
 */
export function rosterFor(seats) {
  const n = Math.max(MIN_SEATS, Math.min(MAX_SEATS, Math.round(Number(seats) || MIN_SEATS)));
  return { ...ROSTER_TABLE[n] };
}

/** 神职:预言家 + 女巫(屠边的两条线之一) */
export function isGod(role) {
  return role === 'seer' || role === 'witch';
}

/** 好人 = 不是狼 */
export function isGood(role) {
  return role !== 'werewolf';
}

/**
 * 胜负规则的**中文说明** —— 这一句会原样进提示词。
 *
 * ⚠️ 研究文档明确点名:「当前用哪种必须写进提示词,否则狼队会乱刀」。
 *    所以这段文案放在内核里、由 view.js 拼进 view,agent.js 直接抄 ——
 *    规则在哪儿定义,提示词就跟着在哪儿说,不会出现「代码改了提示词没改」。
 * @param {string} cond 'side' | 'all'
 */
export function winConditionText(cond) {
  return cond === 'all'
    ? '屠城:狼人要把**所有好人**(神职 + 平民)全部杀光才赢;好人只要把狼全部投出去就赢。'
    : '屠边:狼人只要**杀光全部平民** 或 **杀光全部神职**(预言家 + 女巫)就赢 —— '
      + '两条线达成任意一条即胜;好人只要把狼全部投出去就赢。';
}

/** 提示词里给狼队看的「该刀谁」一句话(屠边与屠城完全不同) */
export function winConditionHint(cond) {
  return cond === 'all'
    ? '屠城局:目标是**减少好人总数**,优先刀身份最稳的好人,不要为了「针对神职」而放过更容易刀到的平民。'
    : '屠边局:目标是**打穿一条边**——要么把平民全杀光,要么把预言家和女巫都杀掉;'
      + '两条线里挑进展更快的那一条,不要两边都开一半(那是屠城打法,在屠边局里等于白刀)。';
}

/** Fisher–Yates 洗牌,随机源注入(与卧底同一套:sort(()=>rand()-0.5) 分布有偏) */
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 把配置夹到合法范围 —— 手改配置写出 seats:99 / winCondition:'xxx' 也不该把局开崩 */
function normalizeConfig(cfg = {}) {
  const seats = Math.max(MIN_SEATS, Math.min(MAX_SEATS, Math.round(Number(cfg.seats) || MIN_SEATS)));
  const winCondition = WIN_CONDITIONS.includes(cfg.winCondition) ? cfg.winCondition : 'side';
  const maxDays = Math.max(2, Math.min(20, Math.round(Number(cfg.maxDays) || DEFAULT_MAX_DAYS)));
  const humanSeat = Number.isInteger(cfg.humanSeat) && cfg.humanSeat >= 0 && cfg.humanSeat < seats
    ? cfg.humanSeat : null;
  const speakDelayMs = Math.max(0, Math.min(8000, Math.round(Number(cfg.speakDelayMs) || 900)));
  return { seats, winCondition, maxDays, humanSeat, speakDelayMs };
}

/** 一局的初始状态(还没发身份)。restore 与 start 共用同一个形状。 */
function blankState(config) {
  return {
    game: 'werewolf',
    config,
    /** 公开的角色构成(只有数量,不含座位)—— 提示词只发这一份 */
    roster: rosterFor(config.seats),
    /** 第几天(1 起)。夜里就等于「即将到来的那个白天」的编号。 */
    day: 0,
    /** idle | night | day | vote | end */
    phase: 'idle',
    /** 夜晚子阶段:wolves | seer | witch | done */
    nightStep: 'wolves',
    /** 今晚这一步的狼人提案 { 座位: 目标|null } —— 提完票才结算 */
    nightProps: {},
    /** 今晚的结果(私有):刀口 / 是否被救 / 毒口 */
    night: { kill: null, saved: false, poison: null },
    /** 白天发言顺序与进行到第几个 */
    order: [],
    orderIdx: 0,
    /** 存活标记、真实身份、显示名 */
    alive: new Array(config.seats).fill(true),
    roles: [],
    names: [],
    /** 预言家查验历史:[{day, by, target, result}] —— 私有 */
    checks: [],
    /** 女巫的药物状态 —— 私有 */
    witch: { antidote: true, poison: true },
    /**
     * 事件账本(唯一真相源,追加不修改)。
     * visibility 三档,这是**信息隔离在数据层的落点**(研究文档「共同工程问题 · 2」):
     *   · 'public'  —— 所有人可见:天亮死讯、发言、票型、放逐、胜负;
     *   · 'faction' —— 仅狼队(以及上帝视角):今晚狼队商定的刀口;
     *   · 'secret'  —— 仅本人(以及上帝视角):验人结果、用药。
     * 只有 'public' 事件会进别人的视图 —— 见 view.js 的 publicEvents()。
     */
    events: [],
    winner: null,      // null | 'werewolf' | 'good'
    endReason: null,   // wolvesOut | side-villager | side-god | all | timeout
  };
}

export class WerewolfKernel {
  /**
   * @param {object} cfg { seats, winCondition, maxDays, humanSeat, speakDelayMs }
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
   * 发身份 + 进入第 1 夜。只能调一次(重复调会重发身份)。
   * @param {string[]} names 座位显示名(由界面给,内核只存不解释)
   */
  start(names = []) {
    const st = this.state;
    if (st.phase !== 'idle') throw new Error('这局已经开始了(start 只能调一次)');
    const { seats } = this.config;
    const roster = st.roster;

    // 身份牌:先按人数铺一份,再洗牌发下去。
    // ⚠️ 顺序要紧:先洗牌再分配座位,不能「按座位顺序填」—— 那样 1 号永远是狼。
    let deck = [];
    for (const role of ROLES) {
      for (let i = 0; i < (roster[role] || 0); i++) deck.push(role);
    }
    if (deck.length !== seats) {
      // 构成表与人数对不上是**内核自己的错**(ROSTER_TABLE 写错了),必须当场炸
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
    st.day = 1;
    this._startNight();
    this._log('public', 'start', {
      text: `已发身份:${seats} 人局,角色构成 ${rosterText(roster)}(身份不公开,只有主持人知道)`,
    });
    return this;
  }

  /* ------------------------------------------------------------ 夜晚 */

  _startNight() {
    const st = this.state;
    st.phase = 'night';
    st.nightStep = 'wolves';
    st.nightProps = {};
    st.night = { kill: null, saved: false, poison: null };
    st.order = [];
    st.orderIdx = 0;
    this._log('public', 'night', { text: `第 ${st.day} 夜开始,天黑请闭眼` });
  }

  /**
   * 现在该哪个角色行动(夜里的子阶段)。不在夜里返回 null。
   *
   * ⚠️ 三步走完返回的是字符串 **'done'**(不是 null):
   *    runner 的判断是「夜里 && nightStep() !== 'done'」——
   *    如果这里把 done 也返回 null,`null !== 'done'` 恒真,循环会一直转
   *    (踩过一次:表现是夜里无限空转,最后在 skipNightStep 里抛「不是夜晚」)。
   */
  nightStep() {
    const st = this.state;
    if (st.phase !== 'night') return null;
    return st.nightStep;
  }

  /**
   * 这个子阶段「应当行动」的座位。
   *   · 狼人:所有存活狼人**各提一次**(并行),内核按多数收敛 —— 每只狼都说话,
   *     不需要内核替它们「选一个队长」,也不给某一只狼额外的信息;
   *   · 预言家 / 女巫:各一个座位;该角色已经出局、或女巫两瓶药都用完 → 空数组
   *     (runner 见到空数组就把这一步跳过,无需特判)。
   */
  pendingNightActors() {
    const st = this.state;
    const step = this.nightStep();
    if (!step || !['wolves', 'seer', 'witch'].includes(step)) return [];
    if (step === 'wolves') {
      return aliveSeatsOf(st).filter((s) => st.roles[s] === 'werewolf');
    }
    if (step === 'seer') {
      return aliveSeatsOf(st).filter((s) => st.roles[s] === 'seer');
    }
    if (step === 'witch') {
      const w = aliveSeatsOf(st).filter((s) => st.roles[s] === 'witch');
      if (!w.length) return [];
      // 两瓶药都没了 → 女巫这一夜无事可做(不叫她,省一次调用)
      if (!st.witch.antidote && !st.witch.poison) return [];
      return w;
    }
    return [];
  }

  /**
   * 记一次夜间行动。
   *
   * 校验写在最前面:座位必须是本步该行动的人,目标必须合法。
   * 非法一律**抛错**(由 agent/runner 那边保证不会传非法值;真传进来了说明有 bug,
   * 静默吞掉会让局面在没人察觉的情况下走偏)。
   *
   * @param {number} seat
   * @param {{action:string, target:number|null}} act
   *   wolves: action 恒为 'kill',target = 想刀的人(null = 空刀)
   *   seer  : 'check' + target(必须是存活、非自己)
   *   witch : 'save' | 'poison' | 'none' + target
   * @returns {{done:boolean, step:string}} done=true 表示这一步的人都行动完了
   */
  recordNightAction(seat, act = {}) {
    const st = this.state;
    const step = this.nightStep();
    if (!step || step === 'done') throw new Error('现在不是夜晚行动阶段');
    if (!['wolves', 'seer', 'witch'].includes(step)) throw new Error(`未知的夜间步骤(${step})`);
    const actors = this.pendingNightActors();
    if (!actors.includes(seat)) throw new Error(`${seat + 1} 号现在不该行动(该行动的是 ${actors.map((s) => s + 1).join('、') || '无'})`);
    const action = String(act.action || '').trim();

    if (step === 'wolves') {
      if (action !== 'kill' && action !== 'none') throw new Error(`狼人的动作只能是 kill / none(收到 ${action})`);
      let target = null;
      if (action === 'kill' && act.target !== null && act.target !== undefined) {
        target = this._legalTarget(act.target, seat, { allowSelf: false });
      }
      st.nightProps[seat] = target;
      const all = actors.every((s) => s in st.nightProps);
      if (!all) return { done: false, step };
      // 多数决;平票时取**座位号最小的那只狼**的选择(确定性,可复现)。
      // 为什么不用 Math.random 破平:同一份存档重放会得到不同的刀口。
      const tally = new Map();
      for (const s of actors) {
        const t = st.nightProps[s];
        if (t === null) continue;
        tally.set(t, (tally.get(t) || 0) + 1);
      }
      let best = 0;
      for (const n of tally.values()) if (n > best) best = n;
      let kill = null;
      if (best > 0) {
        const top = [...tally.entries()].filter(([, n]) => n === best).map(([t]) => t).sort((a, b) => a - b);
        if (top.length === 1) kill = top[0];
        else {
          // 平票:看座位号最小的那只狼投了谁,如果它就在平票集合里就用它的
          const first = actors.slice().sort((a, b) => a - b)[0];
          const its = st.nightProps[first];
          kill = top.includes(its) ? its : top[0];
        }
      }
      st.night.kill = kill;
      this._log('faction', 'wolfKill', kill === null
        ? { text: '狼队今晚选择空刀(没人被刀)' }
        : { text: `狼队今晚刀了 ${kill + 1} 号`, target: kill });
      st.nightStep = 'seer';
      return { done: true, step };
    }

    if (step === 'seer') {
      if (action !== 'check' && action !== 'none') throw new Error(`预言家的动作只能是 check / none(收到 ${action})`);
      if (action === 'check') {
        const target = this._legalTarget(act.target, seat, { allowSelf: false });
        const result = st.roles[target] === 'werewolf' ? 'wolf' : 'good';
        st.checks.push({ day: st.day, by: seat, target, result });
        this._log('secret', 'seerCheck', {
          // ⚠️ result 必须一起记进账本:积分(scoring.js)要按它数「验出狼人」,
          //    上帝视角也要显示它。只写在 state.checks 里的话,读账本的那一侧
          //    永远数不到 —— 踩过一次,表现是「预言家验了一整局狼,积分 0」。
          seat, target, result,
          text: `你查验了 ${target + 1} 号:${result === 'wolf' ? '狼人' : '好人'}`,
        });
      } else {
        this._log('secret', 'seerCheck', { seat, text: '你这一晚没有验人' });
      }
      st.nightStep = 'witch';
      return { done: true, step };
    }

    // step === 'witch'
    if (!['save', 'poison', 'none'].includes(action)) {
      throw new Error(`女巫的动作只能是 save / poison / none(收到 ${action})`);
    }
    if (action === 'save') {
      if (!st.witch.antidote) throw new Error('解药已经用掉了');
      if (st.night.kill === null) throw new Error('今晚没有人被刀,没有可救的人');
      // 解药只能救**今晚的刀口**,而且不能自救(研究文档:女巫不能自救)
      const t = this._legalTarget(act.target ?? st.night.kill, seat, { allowSelf: false });
      if (t !== st.night.kill) throw new Error('解药只能用在今晚被刀的那个人身上');
      st.night.saved = true;
      st.witch.antidote = false;
      this._log('secret', 'witchAction', {
        seat, target: t, text: `你用解药救了 ${t + 1} 号`,
      });
    } else if (action === 'poison') {
      if (!st.witch.poison) throw new Error('毒药已经用掉了');
      const t = this._legalTarget(act.target, seat, { allowSelf: false });
      st.night.poison = t;
      st.witch.poison = false;
      this._log('secret', 'witchAction', { seat, target: t, text: `你对 ${t + 1} 号用了毒药` });
    } else {
      this._log('secret', 'witchAction', { seat, text: '你这一晚没有用药' });
    }
    st.nightStep = 'done';
    return { done: true, step };
  }

  /**
   * 跳过当前夜间子阶段(该角色已出局 / 女巫没有药了)。
   *
   * 为什么要一个显式方法而不是让 runner 直接塞一个 none 动作:
   * 那一步**根本没有该行动的人**,硬塞一个动作会往账本里写一条「某座位放弃了」
   * —— 查日志的人会以为那个人还活着。
   */
  skipNightStep() {
    const st = this.state;
    const step = this.nightStep();
    if (!step || step === 'done') throw new Error('现在不是夜晚行动阶段');
    if (step === 'wolves') {
      // 没有人可以刀(理论上狼全死了,局早该结束)→ 空刀
      st.night.kill = null;
      this._log('faction', 'wolfKill', { text: '狼队无人可行动,今晚空刀' });
      st.nightStep = 'seer';
    } else if (step === 'seer') {
      st.nightStep = 'witch';
    } else {
      st.nightStep = 'done';
    }
    return this;
  }

  /** 目标合法性:存活、不是自己;allowSelf=false 时连自己也不能选 */
  _legalTarget(raw, from, { allowSelf = false } = {}) {
    const st = this.state;
    const t = Math.round(Number(raw));
    if (!Number.isInteger(t) || t < 0 || t >= st.alive.length) throw new Error(`目标非法(${raw})`);
    if (!st.alive[t]) throw new Error(`${t + 1} 号已经出局,不能选他`);
    if (!allowSelf && t === from) throw new Error('不能选自己');
    return t;
  }

  /**
   * 夜里三步都走完 → 结算天亮。
   *
   * 死讯**只公布「谁」,不公布身份**(研究文档「必须保留」清单里的一条:
   * 一旦公开身份,推理空间立刻塌掉)。
   * @returns {{deaths:number[], peaceful:boolean}}
   */
  dawn() {
    const st = this.state;
    if (st.phase !== 'night') throw new Error('现在不是夜晚');
    if (st.nightStep !== 'done') throw new Error(`夜里还有步骤没走完(${st.nightStep})`);
    const deaths = [];
    const kill = st.night.kill;
    if (kill !== null && !st.night.saved && st.alive[kill]) deaths.push(kill);
    if (st.night.poison !== null && st.alive[st.night.poison] && !deaths.includes(st.night.poison)) {
      deaths.push(st.night.poison);
    }
    for (const s of deaths) st.alive[s] = false;
    st.phase = 'day';
    st.nightStep = 'done';

    if (!deaths.length) {
      this._log('public', 'dawn', { text: `第 ${st.day} 天天亮了:平安夜,昨晚没有人出局` });
    } else {
      this._log('public', 'dawn', {
        text: `第 ${st.day} 天天亮了:昨晚 ${deaths.map((s) => `${s + 1}号`).join('、')} 出局`
          + '(身份不公开)',
        deaths,
      });
    }
    // 天亮之后立刻判一次:夜刀可能直接打穿一条边
    const win = this.checkWin();
    if (win) {
      this._end(win.winner, win.reason);
      return { deaths, peaceful: deaths.length === 0 };
    }
    this._startSpeech();
    return { deaths, peaceful: deaths.length === 0 };
  }

  /* ------------------------------------------------------------ 白天发言 */

  /** 白天发言顺序:随机起始座位,方向固定(+1 座位号,跳过出局者) */
  _startSpeech() {
    const st = this.state;
    const alive = aliveSeatsOf(st);
    const start = alive[Math.floor(this.rand() * alive.length)] ?? 0;
    const order = [];
    for (let k = 0; k < st.alive.length; k++) {
      const s = (start + k) % st.alive.length;
      if (st.alive[s]) order.push(s);
    }
    st.order = order;
    st.orderIdx = 0;
    st.phase = 'day';
    this._log('public', 'speechOrder', {
      text: `发言顺序:${order.map((s) => `${s + 1}号`).join(' → ')}`,
      order,
    });
  }

  /** 现在该谁发言;不在发言阶段(或说完了)返回 null */
  currentSpeaker() {
    const st = this.state;
    if (st.phase !== 'day') return null;
    return st.order[st.orderIdx] ?? null;
  }

  /**
   * 记一段公开发言。**只接受当前该说话的那个人**。
   * @param {number} seat
   * @param {string[]|string} say 2~4 条气泡(数组)或一句话
   * @param {{quality?:string, stake?:number|null}} [meta]
   *   quality:'low' = 这是确定性兜底句;
   *   stake = 这段发言里**公开表态**要投的人(null = 没表态)。
   *   ⚠️ stake 是「投票必须与发言一致」的锚点(wolfcha 的做法):投票阶段
   *   view 会把它交给 agent,改票就必须写 changed_from 与新证据。
   */
  recordSpeech(seat, say, meta = {}) {
    const st = this.state;
    const cur = this.currentSpeaker();
    if (cur === null) throw new Error('现在不是发言阶段');
    if (seat !== cur) throw new Error(`现在该 ${cur + 1} 号发言,不是 ${seat + 1} 号`);
    const bubbles = normalizeBubbles(say);
    if (!bubbles.length) throw new Error('发言不能为空');
    const stakeRaw = meta.stake;
    const stake = Number.isInteger(stakeRaw) && stakeRaw >= 0 && stakeRaw < st.alive.length
      ? stakeRaw : null;
    this._log('public', 'speech', {
      seat, say: bubbles, stake,
      text: `${seat + 1}号:${bubbles.join(' ')}`,
      quality: meta.quality === 'low' ? 'low' : 'ok',
    });
    st.orderIdx += 1;
    if (st.orderIdx >= st.order.length) {
      st.phase = 'vote';
      this._log('public', 'voteStart', { text: `第 ${st.day} 天发言结束,开始放逐投票` });
    }
    return this;
  }

  /* ------------------------------------------------------------ 放逐投票 */

  /** 某座位能投的人(存活、且不是自己)。已投过的人不再返回。 */
  voteCandidates(seat) {
    const st = this.state;
    if (st.phase !== 'vote') return [];
    if (!st.alive[seat]) return [];
    const voted = new Set(votesOf(st, st.day).map((e) => e.seat));
    if (voted.has(seat)) return [];
    const out = [];
    for (let s = 0; s < st.alive.length; s++) if (s !== seat && st.alive[s]) out.push(s);
    return out;
  }

  /** 这一轮还没投票的座位 */
  pendingVoters() {
    const st = this.state;
    if (st.phase !== 'vote') return [];
    const voted = new Set(votesOf(st, st.day).map((e) => e.seat));
    const out = [];
    for (let s = 0; s < st.alive.length; s++) if (st.alive[s] && !voted.has(s)) out.push(s);
    return out;
  }

  /**
   * 记一票。
   * @param {number} from
   * @param {number|null} to 目标座位;**null = 弃票**(解析失败时的确定性降级)
   * @param {string} [reason] 公开理由(≤25 字,已过 filter)
   */
  recordVote(from, to, reason = '') {
    const st = this.state;
    if (st.phase !== 'vote') throw new Error('现在不是投票轮');
    if (!st.alive[from]) throw new Error(`${from + 1} 号已经出局,不能投票`);
    if (votesOf(st, st.day).some((e) => e.seat === from)) {
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
    this._log('public', 'vote', {
      seat: from, target,
      reason: String(reason || '').slice(0, 40),
      text: target === null
        ? `${from + 1}号弃票`
        : `${from + 1}号 → ${target + 1}号${reason ? `(${String(reason).slice(0, 24)})` : ''}`,
    });
    if (!this.pendingVoters().length) this._settleVote();
    return this;
  }

  /**
   * 统计当天的票数。抽成纯函数是为了让测试能**单独验平票**,
   * 也让「谁被投出去了」只有一份算法。
   * @param {number} [day]
   * @returns {{tally:number[], top:number[], abstain:number}}
   */
  tallyVotes(day = this.state.day) {
    const st = this.state;
    const tally = new Array(st.alive.length).fill(0);
    let abstain = 0;
    for (const e of votesOf(st, day)) {
      if (e.target === null || e.target === undefined) { abstain += 1; continue; }
      tally[e.target] += 1;
    }
    let best = 0;
    for (const n of tally) if (n > best) best = n;
    const top = [];
    if (best > 0) for (let s = 0; s < tally.length; s++) if (tally[s] === best) top.push(s);
    return { tally, top, abstain };
  }

  /**
   * 结算放逐:淘汰 / 平票 / 判胜负 / 进下一夜。
   * @returns {{exiled:number|null, tie:boolean, winner:string|null}}
   */
  _settleVote() {
    const st = this.state;
    const { top, tally } = this.tallyVotes();
    const record = { exiled: null, tie: false, winner: null };

    if (top.length === 1) {
      const seat = top[0];
      st.alive[seat] = false;
      record.exiled = seat;
      // ⚠️ 只公布「谁出局」,不公布身份 —— 被放逐的人自己也只知道自己是啥,
      //    别人只能靠发言推理。这就是整个游戏的推理空间。
      this._log('public', 'exile', {
        seat, votes: tally[seat],
        text: `${seat + 1}号以 ${tally[seat]} 票被放逐出局(身份不公开)`,
      });
      const win = this.checkWin();
      if (win) {
        this._end(win.winner, win.reason);
        record.winner = win.winner;
        return record;
      }
    } else {
      record.tie = top.length > 1;
      this._log('public', 'tie', {
        text: top.length > 1
          ? `${top.map((s) => `${s + 1}号`).join('、')} 平票,本轮无人出局`
          : '本轮没人得票,无人出局',
      });
    }

    // 天数上限:到时按存活人数判(研究文档:超时按人数判定)
    if (st.day >= st.config.maxDays) {
      const wolves = aliveSeatsOf(st).filter((s) => st.roles[s] === 'werewolf').length;
      const goods = aliveSeatsOf(st).length - wolves;
      this._end(wolves >= goods ? 'werewolf' : 'good', 'timeout');
      record.winner = st.winner;
      return record;
    }

    st.day += 1;
    this._startNight();
    return record;
  }

  /* ------------------------------------------------------------ 胜负 */

  /**
   * 判胜负。**规则只有这一份**(两种 winCondition 都在这里)。
   * @returns {{winner:'werewolf'|'good', reason:string}|null}
   */
  checkWin() {
    const st = this.state;
    if (st.phase === 'end') return null;
    const alive = aliveSeatsOf(st);
    const wolves = alive.filter((s) => st.roles[s] === 'werewolf');
    const goods = alive.filter((s) => isGood(st.roles[s]));
    // 好人胜:狼全部出局(两种规则下都一样)
    if (wolves.length === 0) return { winner: 'good', reason: 'wolvesOut' };
    if (st.config.winCondition === 'all') {
      // 屠城:所有好人死光
      if (goods.length === 0) return { winner: 'werewolf', reason: 'all' };
      return null;
    }
    // 屠边:杀光全部平民 或 杀光全部神职
    const villagers = alive.filter((s) => st.roles[s] === 'villager');
    const gods = alive.filter((s) => isGod(st.roles[s]));
    if (villagers.length === 0) return { winner: 'werewolf', reason: 'side-villager' };
    if (gods.length === 0) return { winner: 'werewolf', reason: 'side-god' };
    return null;
  }

  _end(winner, reason) {
    const st = this.state;
    st.phase = 'end';
    st.winner = winner;
    st.endReason = reason;
    const why = {
      wolvesOut: '狼人全部出局',
      'side-villager': '平民被屠光(屠边)',
      'side-god': '神职被屠光(屠边)',
      all: '好人被屠城',
      timeout: `打到第 ${st.config.maxDays} 天上限,按存活人数判`,
    }[reason] || reason;
    this._log('public', 'win', {
      text: `${winner === 'good' ? '好人胜' : '狼人胜'}(${why})`,
      winner, reason,
    });
  }

  /**
   * 「回合推进卡住了」的**确定性修复**。runner 发现「状态没往前走」时调它。
   *
   * 为什么需要(与卧底那份同一个理由,但狼人杀的坏法不一样):
   *   · `night` 且三步都走完了却没天亮:runner 的循环只认 `nightStep() !== 'done'`,
   *     一旦这个条件在 done 上成立不了(存档死在「夜里最后一步刚记完」那一刻),
   *     就再也没有人调 dawn() —— **整夜卡在那里**;
   *   · `day` 却没有当前发言者(order 空 / orderIdx 越界):原代码是 `continue`,
   *     那是**死转**(主线程被吃满,画面完全不动);
   *   · `vote` 却没有人待投:票记满了却没结算(同样来自坏存档)。
   *
   * 修复原则:**不猜结果**。夜里该天亮就天亮(死讯按已经记下的刀口/毒药算),
   * 发言轮空了就直接进投票,票满了就结算。这样即便存档是坏的,也能走到一个
   * 规则允许的终局,而不是永远停在某一夜/某一天。
   *
   * @returns {string|null} 修了什么;无事可修返回 null
   */
  repairTurn() {
    const st = this.state;
    if (st.phase === 'end') return null;
    if (st.phase === 'night' && this.nightStep() === 'done') {
      this.dawn();
      return 'night-done';
    }
    if (st.phase === 'day' && this.currentSpeaker() === null) {
      st.phase = 'vote';
      this._log('public', 'voteStart', { text: '发言顺序已空(修复),直接开始放逐投票' });
      return 'day-empty';
    }
    if (st.phase === 'vote' && !this.pendingVoters().length) {
      this._settleVote();
      return 'vote-idle';
    }
    return null;
  }

  /* ------------------------------------------------------------ 账本 */

  /**
   * 追加一条事件。events 是**唯一真相源**:界面、提示词、测试全都从这里读,
   * 所以「谁说了一句什么」只有一份记录,不会出现两套历史。
   */
  _log(visibility, kind, data = {}) {
    const st = this.state;
    st.events.push({
      seq: st.events.length + 1,
      day: st.day,
      phase: st.phase,
      visibility,
      kind,
      ...data,
    });
    // 防御:12 人 × 6 天大约几百条;真出 bug 无限追加时别把内存吃光
    if (st.events.length > 4000) st.events.splice(0, st.events.length - 4000);
  }

  /** 某座位有权读到的账本(public + 自己的 faction/secret)—— 给测试与调试用 */
  eventsFor(seat) {
    const st = this.state;
    const role = st.roles[seat];
    return st.events.filter((e) => {
      if (e.visibility === 'public') return true;
      if (e.visibility === 'faction') return role === 'werewolf';
      if (e.visibility === 'secret') return e.seat === seat;
      return false;
    });
  }

  /* ------------------------------------------------------------ 快照 */

  /**
   * 打一份快照(给存档层用)。
   * progress 里的 handNo 是**给宿主的通用字段**(存档层与主页「继续上一局」
   * 都读它)—— 狼人杀这边它就是「第几天」,不新造字段名是为了让存档层保持游戏无关。
   */
  snapshot() {
    const st = JSON.parse(JSON.stringify(this.state));
    return {
      v: SNAPSHOT_VERSION,
      game: 'werewolf',
      savedAt: Date.now(),
      progress: {
        handNo: st.day | 0,
        street: st.phase,
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
    const { state, config } = WerewolfKernel.validateSnapshot(snap);
    this.state = state;
    this.config = config;
    return true;
  }

  /**
   * 校验快照。不合格**抛错**(宿主据此当场丢掉),通过时返回解析出来的
   * {state, config} —— 与扑克 / 卧底的 validateSnapshot 同一个约定。
   */
  static validateSnapshot(snap) {
    const fail = (why) => { throw new Error(`狼人杀的存档不可用:${why}`); };
    if (!snap || typeof snap !== 'object') fail('不是对象');
    if (snap.game !== 'werewolf') fail(`这是别的游戏的存档(${String(snap.game)})`);
    if (snap.v !== SNAPSHOT_VERSION) fail(`版本不匹配(存档 v${snap.v},当前 v${SNAPSHOT_VERSION})`);
    const st = snap.state;
    if (!st || typeof st !== 'object') fail('缺少 state');
    if (!Array.isArray(st.alive) || st.alive.length < MIN_SEATS) fail('alive 缺失或人数不足');
    if (!Array.isArray(st.roles) || st.roles.length !== st.alive.length) fail('roles 与座位数对不上');
    if (!Array.isArray(st.events)) fail('events 缺失');
    if (!['idle', 'night', 'day', 'vote', 'end'].includes(st.phase)) fail(`phase 非法(${st.phase})`);
    if (st.winner !== null && st.winner !== 'werewolf' && st.winner !== 'good') {
      fail(`winner 非法(${st.winner})`);
    }
    if (!st.config || typeof st.config !== 'object') fail('config 缺失');
    if (!WIN_CONDITIONS.includes(st.config.winCondition)) fail(`winCondition 非法(${st.config.winCondition})`);
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

/** 存活座位列表(升序) */
export function aliveSeatsOf(st) {
  const out = [];
  for (let s = 0; s < st.alive.length; s++) if (st.alive[s]) out.push(s);
  return out;
}

/** 某一天的全部投票事件(按发生顺序) */
export function votesOf(st, day) {
  return st.events.filter((e) => e.kind === 'vote' && e.day === day);
}

/** 某一天的全部发言事件 */
export function speechesOf(st, day) {
  return st.events.filter((e) => e.kind === 'speech' && e.day === day);
}

/** 某一天的天亮死讯 */
export function dawnOf(st, day) {
  return st.events.filter((e) => e.kind === 'dawn' && e.day === day);
}

/** 角色构成的中文一句话(公开配置,只有数量) */
export function rosterText(roster) {
  return `狼人×${roster.werewolf}、预言家×${roster.seer}、女巫×${roster.witch}、平民×${roster.villager}`;
}

/** 身份的中文名 */
export function roleLabel(role) {
  return {
    werewolf: '狼人', seer: '预言家', witch: '女巫', villager: '平民',
  }[role] || String(role || '');
}

/**
 * 把模型给的发言收敛成「2~4 条气泡」。
 * 允许直接给字符串(模型偶尔会这么回),按句号/换行切开 ——
 * 不让「一次糊一大段」毁掉逐条打字机的节奏(研究文档:多气泡 say 远好于一次糊）。
 */
export function normalizeBubbles(say, max = 4) {
  let list = [];
  if (Array.isArray(say)) list = say.map((s) => String(s ?? ''));
  else if (typeof say === 'string') {
    // 先按换行切,再把过长的句子按中文句末标点切 —— 一条气泡最好 15~40 字
    list = say.split(/[\r\n]+/);
  }
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
  return new WerewolfKernel(cfg, opts);
}
