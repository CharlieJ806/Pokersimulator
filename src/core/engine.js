'use strict';
/**
 * 德州扑克规则引擎(完整无限注)。
 *
 * 职责边界:只负责规则与状态,不认识 AI,也不认识界面。
 * 对外暴露可序列化的 state,渲染进程按 state 画桌面。
 *
 * 已实现的规则要点:
 *  - 2~9 人,按钮位每手轮转;单挑时按钮位下小盲、翻前先行动、翻后后行动。
 *  - 盲注可升盲(everyNHands 手翻倍)。
 *  - 52 张标准 / 36 张短牌(短牌 A6789 为最小顺子,同花 < 葫芦)。
 *  - 无限注下注:最小加注额、短码全下不重开下注轮、未被跟的下注退回。
 *  - 多人全下自动切边池,平局按顺时针分池,余数给最近按钮左侧赢家。
 */

import { buildDeck, shuffle, cryptoRandom, rankOf, suitOf, cardText } from './cards.js';
import { evaluate, compare, describe, CAT } from './handEval.js';

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const STREET_LABEL = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

/**
 * 升盲表:每过 10 个完整「人回合」(按钮位转满 10 圈)上升一档。
 * 数值按需求给的表原样使用,从 100/200 一路到 50,000/100,000。
 * 起始盲注如果不在表里,会自动匹配最接近的一档,再从那一档往上走。
 */
export const BLIND_LEVELS = [
  [100, 200], [200, 400], [300, 600], [400, 800], [500, 1000],
  [600, 1200], [800, 1600], [1000, 2000], [1500, 3000], [2000, 4000],
  [3000, 6000], [4000, 8000], [5000, 10000], [6000, 12000], [8000, 16000],
  [10000, 20000], [15000, 30000], [20000, 40000], [25000, 50000], [30000, 60000],
  [50000, 100000],
];

/** 每多少个人回合升一档 */
export const BLIND_LEVEL_ORBITS = 10;

/** 从起始大盲找到最接近的一档下标 */
function nearestLevelIndex(bigBlind) {
  let best = 0;
  let bestDiff = Infinity;
  BLIND_LEVELS.forEach(([, bb], i) => {
    const d = Math.abs(bb - bigBlind);
    if (d < bestDiff) { bestDiff = d; best = i; }
  });
  return best;
}

/**
 * 升一级盲注。
 *
 * 关键点:如果起始盲注不是表里的档位(比如自定义成 10/20),**不能**直接跳到
 * 表里那一档 —— 那样盲注会突然暴涨(10/20 → 300/600)。做法是把这一档该有的
 * 倍数关系作用在「当前盲注」上:表里从第 i 档到第 i+1 档涨了几倍,当前盲注就乘几倍。
 * 起始盲注正好在表里时,结果和直接查表完全一致。
 */
function nextBlindLevel(smallBlind, bigBlind, level) {
  const from = BLIND_LEVELS[level] || BLIND_LEVELS[0];
  const to = BLIND_LEVELS[level + 1];
  if (!to) return null;                              // 已经到顶
  const ratio = to[1] / from[1];
  // 关键:倍率作用在**大盲**上。大盲至少是 2,乘 1.5 不会像小盲那样被取整吞掉。
  const newBb = Math.max(bigBlind + 1, Math.round(bigBlind * ratio));
  const newSb = Math.max(1, Math.round(newBb / 2));
  return [newSb, newSb * 2];
}

export function BLIND_LEVELS_PREVIEW() { return BLIND_LEVELS.map(([sb, bb]) => `${sb}/${bb}`); }

const DEFAULT_SETTINGS = {
  seats: 6,
  shortDeck: false,
  startingStack: 2000,
  smallBlind: 10,
  bigBlind: 20,
  ante: 0,
  bigBlindAnte: false,  // 大盲前注:大盲位额外拿出「一个当前大盲」当前注
  blindLevelUp: false,  // 每 10 个人回合按 BLIND_LEVELS 升一档
  blindUpEvery: 0,      // 老模式:每 N 手盲注翻倍(0 = 关闭)
  humanSeat: null,      // 玩家模式:人类坐哪个座位(荷官模式为 null)
  // 发牌一律用 crypto 随机(见 cards.js 的 cryptoRandom),不做种子复现。
  // 需要可复现的测试请在构造时传 opts.rand(例如 mulberry32),别指望 settings.seed。
};

class PokerEngine {
  constructor(settings = {}, opts = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    // 座位数必须在牌堆能支撑的范围内:9 人是上限(短牌 36 张发 9 人底牌 + 公共牌也够)。
    // 不夹取的话,seats 传大了会静默发出 undefined 牌。
    const seats = Number(this.settings.seats);
    if (!Number.isFinite(seats) || seats < 2 || seats > 9) {
      throw new Error(`座位数必须在 2~9 之间,收到 ${this.settings.seats}`);
    }
    this.settings.seats = Math.round(seats);
    this.rand = opts.rand || cryptoRandom;
    this.state = this._initialState();
  }

  /* ------------------------------------------------------------------ 初始化 */

  _initialState() {
    const s = this.settings;
    const players = [];
    for (let i = 0; i < s.seats; i++) {
      players.push({
        seat: i,
        name: `座位 ${i + 1}`,
        stack: s.startingStack,
        committed: 0,        // 本手牌累计投入(用于分池)
        betThisRound: 0,     // 本轮已下注
        hole: [null, null],
        inHand: false,
        folded: false,
        allIn: false,
        hasActed: false,
        totalBetThisHand: 0,
        lastAction: null,
        persona: null,
      });
    }
    return {
      handNo: 0,
      street: 'idle',
      button: -1,
      totalChips: s.seats * s.startingStack,
      smallBlind: s.smallBlind,
      bigBlind: s.bigBlind,
      ante: s.ante,
      bigBlindAnte: !!s.bigBlindAnte,
      blindLevelUp: !!s.blindLevelUp,
      blindLevel: s.blindLevelUp ? nearestLevelIndex(s.bigBlind) : -1,
      orbits: 0,               // 已经打过的完整「人回合」数(按钮位转一圈算一个)
      blindLevelSince: 0,      // 当前这一档是从第几手开始生效的
      // 最小加注规则的两个基准(见 startHand / act 里的说明):
      lastFullRaise: s.bigBlind,     // 本下注轮上一次完整下注/加注的「增量」
      lastFullRaiseTo: s.bigBlind,   // 上一次完整下注/加注的「目标额」
      humanSeat: (s.humanSeat === undefined || s.humanSeat === null)
        ? null : Math.max(0, Math.min(s.seats - 1, s.humanSeat | 0)),
      shortDeck: !!s.shortDeck,
      deck: [],
      board: [],
      burned: [],             // 烧掉的牌(荷官流程,正面朝下) 
      pot: 0,                 // 已收进底池的死钱(不含本轮台面下注)
      players,
      currentBet: 0,
      lastFullRaise: s.bigBlind,
      minRaiseTo: s.bigBlind,
      actor: null,
      pending: [],
      aggressor: null,
      lastResult: null,
      log: [],
      handOver: false,
      handStartStacks: players.map((p) => p.stack),
      // 跨手保留的「公开事件」——与每手清空的 log 分开。
      // AI 的记性靠它:牌桌记忆明细 + 写读人笔记时的素材都读这里。
      // ⚠️ 里面**只放公开信息**:弃牌时没亮过的底牌永远不进这个数组。
      handDeltas: [],
      // 本手的公开动作缓冲(跨过 showdown 保留,见 _noteAction)
      handActions: [],
    };
  }

  /* ------------------------------------------------------------------ 工具 */

  get activePlayers() { return this.state.players.filter((p) => p.inHand && !p.folded); }
  get livePlayers() { return this.state.players.filter((p) => p.inHand && !p.folded && !p.allIn); }
  get seatedPlayers() { return this.state.players.filter((p) => p.stack > 0 || p.inHand); }

  _log(text, kind = 'info', extra = null) {
    this.state.log.push({ handNo: this.state.handNo, street: this.state.street, text, kind, extra, at: Date.now() });
    if (this.state.log.length > 500) this.state.log.splice(0, this.state.log.length - 500);
    this.onLog?.({ text, kind, extra, street: this.state.street, handNo: this.state.handNo });
  }

  /**
   * 记一条「公开动作事件」。
   *
   * 为什么不复用 st.log:log 在 `_showdown()` 里会被清空(那是为了不让上一手的
   * 摊牌日志串台),而一手结束时我们要拿**整手**的动作去做公开摘要 ——
   * 从 log 里取只能拿到摊牌之后的几条,动作全丢了(踩过)。
   * 所以单独维护一个缓冲,跨过 showdown 一直留到 _captureHandDelta()。
   */
  _noteAction(seat, kind, text) {
    this.state.handActions.push({ seat, kind, street: this.state.street, text });
  }

  seatName(seat) { return this.state.players[seat]?.name || `座位 ${seat + 1}`; }

  /**
   * 不变量检查:筹码守恒(手上筹码 + 本手已投入 + 底池 = 开局总筹码)。
   * 只在开发调试时调用,返回 null 表示正常,否则返回问题描述。
   */
  checkChips() {
    const st = this.state;
    const inPlay = st.players.reduce((s, p) => s + p.stack + p.committed, 0) + st.pot;
    return { inPlay, expected: st.totalChips, ok: inPlay === st.totalChips };
  }

  /** 清空台面(把手牌与底池归零),给测试和「重新开局」用 */
  _clearTable() {
    const st = this.state;
    st.board = []; st.burned = []; st.pot = 0; st.currentBet = 0; st.actor = null; st.pending = [];
    st.street = 'river'; st.handOver = false; st.log = [];
    st.lastResult = null; st.aggressor = null;
    for (const p of st.players) {
      p.hole = [null, null]; p.betThisRound = 0; p.committed = 0;
      p.folded = false; p.allIn = false; p.hasActed = false; p.lastAction = null;
      p.totalBetThisHand = 0; p.inHand = p.stack > 0;
    }
    return this;
  }

  /** 从 startSeat 开始(含)顺时针找下一个满足 pred 的座位 */
  _nextSeat(startSeat, pred) {
    const n = this.state.players.length;
    for (let i = 0; i < n; i++) {
      const s = (startSeat + i + n) % n;
      if (pred(this.state.players[s], s)) return s;
    }
    return -1;
  }

  /** 位置名(用于 AI prompt 与界面标签) */
  positionLabels() {
    const st = this.state;
    const inHand = st.players.filter((p) => p.inHand);
    const map = {};
    if (inHand.length === 0) return map;
    if (inHand.length === 2) {
      // 单挑:按钮位同时也是小盲。必须按**按钮位**判断谁是 BTN/SB,
      // 不能按数组顺序 —— inHand 是按座位号排的,按钮轮到另一边时就会标反。
      map[st.button] = 'BTN/SB';
      const other = inHand.find((p) => p.seat !== st.button);
      if (other) map[other.seat] = 'BB';
      return map;
    }
    const order = [];
    let s = this._nextSeat(st.button + 1, (p) => p.inHand);
    for (let i = 0; i < inHand.length; i++) { order.push(s); s = this._nextSeat(s + 1, (p) => p.inHand); }
    map[order[0]] = 'SB';
    map[order[1]] = 'BB';
    map[order[order.length - 1]] = 'BTN';
    if (order.length >= 4) map[order[order.length - 2]] = 'CO';
    if (order.length >= 5) map[order[order.length - 3]] = 'HJ';
    // 剩下的就是「枪口位」那一串,统一在这里按**行动顺序**依次编号。
    //
    // ⚠️ 以前是「先把 order[len-4] 定成 UTG,再给剩下没标的按索引补 UTG+1、UTG+2」——
    //    两套编号撞在一起,结果越来越靠后的位置反而编号更小,
    //    实测 9 人局的顺序印出来是 `UTG+1 → UTG+2 → UTG+3 → UTG`,完全反了。
    //    现在从左到右依次 UTG、UTG+1、UTG+2…,跟行动顺序一致。
    let utgIdx = 0;
    for (let i = 2; i < order.length - 1; i++) {
      if (map[order[i]]) continue;
      map[order[i]] = utgIdx === 0 ? 'UTG' : `UTG+${utgIdx}`;
      utgIdx++;
    }
    return map;
  }

  /**
   * 用一句人话说明这个座位的位置好坏。
   *
   * 为什么需要:位置是「翻后行动顺序」决定的,不是「翻前谁先说话」。
   * 模型很容易搞反 —— 实测出现过把盲注位(先行动、最差)说成好位置。
   * 与其让它自己推,不如直接把结论写进提示词。
   *
   * @param {number} seat
   * @returns {string} 例如「BTN(按钮位):翻后最后行动,位置最好」
   */
  positionHint(seat) {
    const label = this.positionLabels()[seat];
    if (!label) return '';
    if (label.startsWith('BTN')) {
      return label === 'BTN/SB'
        ? '单挑里你既是按钮又是小盲:翻前你先动,但翻后你**最后**行动,整体位置好'
        : '按钮位:翻后**最后**行动,能看到所有人怎么做再决定,位置最好';
    }
    if (label === 'CO') return '关煞位(按钮前一位):位置很好,只比按钮位差一点';
    if (label === 'HJ') return '劫位:位置偏好';
    if (label === 'BB') return '大盲:翻后**先**行动,位置最差(但已经投过盲注,跟注便宜)';
    if (label === 'SB') return '小盲:翻后**先**行动,位置最差(而且已经投了半个盲注)';
    if (label === 'UTG') return '枪口位:翻前第一个说话,翻后也早,位置差 —— 这里要更挑牌';
    return `${label}:翻前较早行动,位置偏差`;
  }

  /**
   * 一句话说清本手「谁先谁后」。
   *
   * 为什么需要:早先提示词里写的是「按钮位在 N 号位」,而对手列表每行也带座位号 ——
   * 两套编号放一起,模型会去比对,一旦它自己的座位号和按钮位撞上,就认为
   * 信息自相矛盾,然后**整段思考都在纠结这件事**(实测出现过,用户反馈
   * 「思考过程完全错乱」)。现在不给任何座位号,只给这一串位置顺序。
   *
   * @returns {string} 例如「UTG → HJ → CO → BTN → SB → BB」
   */
  orderText() {
    const st = this.state;
    const inHand = st.players.filter((p) => p.inHand);
    if (inHand.length === 0) return '';
    const pos = this.positionLabels();
    if (inHand.length === 2) {
      // 单挑:按钮/小盲先动,大盲后动
      const btn = pos[st.button] || 'BTN/SB';
      const other = inHand.find((p) => p.seat !== st.button);
      const otherPos = other ? (pos[other.seat] || 'BB') : 'BB';
      return `${btn}(先) → ${otherPos}(后)`;
    }
    const order = [];
    let s = this._nextSeat(st.button + 1, (p) => p.inHand);
    for (let i = 0; i < inHand.length; i++) {
      order.push(pos[s] || '?');
      s = this._nextSeat(s + 1, (p) => p.inHand);
    }
    return order.join(' → ');
  }

  /* ---------------------------------------------------------- 筹码状况 */

  /** 按大盲数给筹码分档。扑克里 10BB / 25BB 是常用的两条线 */
  static stackStatus(stack, bb) {
    const n = stack / Math.max(1, bb);
    if (n < 10) return 'short';
    if (n < 25) return 'medium';
    return 'deep';
  }

  /**
   * 把筹码状况算成**可直接用来决策**的形式。
   *
   * 为什么不能只给原始数字:实测提示词里只写「你的筹码:60」时,模型不会
   * 自己去换算成「3 个大盲,快出局了」—— 它就把 60 当一个数字看。
   * 而筹码深度是扑克里最关键的决策依据之一(短码该收缩/该找机会翻倍、
   * 深码可以施压、领先时别送优势),所以这里统一算好:
   *   · 大盲数(唯一有意义的尺度,盲注会升级,绝对数字会骗人)
   *   · 在桌上的排名(我是领先还是垫底)
   *   · 短/中/深档位
   *   · 还有几个人活着(离冠军多远)
   *
   * @param {number} [forSeat] 想重点看谁的(通常是自己)
   */
  stackSituation(forSeat) {
    const st = this.state;
    const bb = Math.max(1, st.bigBlind);
    // 「活着」= 还有筹码。筹码归零就是出局,不再参与后面的手牌。
    const alive = st.players.filter((p) => p.stack > 0);
    const sorted = [...alive].sort((a, b) => b.stack - a.stack);
    const rankOf = {};
    sorted.forEach((p, i) => { rankOf[p.seat] = i + 1; });
    const per = {};
    for (const p of st.players) {
      per[p.seat] = {
        seat: p.seat,
        stack: p.stack,
        bbCount: Math.round((p.stack / bb) * 10) / 10,
        rank: rankOf[p.seat] || null,          // 筹码排名(1 = 最多);已出局为 null
        status: p.stack > 0 ? PokerEngine.stackStatus(p.stack, bb) : 'out',
        isMe: p.seat === forSeat,
      };
    }
    return { bb, aliveCount: alive.length, totalSeats: st.players.length, per, rankOf };
  }


  /* ------------------------------------------------------------------ 开局 / 发牌 */

  /**
   * 数「人回合」:按钮位每转满一圈算一个完整人回合。
   *
   * 这里不用「内部方法被调用」来驱动 —— 那样要求外部严格按顺序调用 startHand,
   * 中间插入一次 viewForDealer 就可能漏掉一圈。改成**按需推进**:任何一次读取
   * (界面渲染、AI 决策、测试断言)都会顺手把圈数补上,幂等且不会漏。
   * 判定方式:这一手的按钮位序号不比上一手大(说明绕回去了),就进入新的一圈。
   */
  orbitsNow() {
    const st = this.state;
    if (!st.blindLevelUp) return st.orbits || 0;
    if (st.handNo <= 0) return st.orbits || 0;

    // 同一手只结算一次(任何读取都可能触发这里,必须幂等)
    if (st._orbitCountedHand === st.handNo) return st.orbits || 0;
    const first = st._orbitCountedHand === undefined;
    st._orbitCountedHand = st.handNo;
    if (first) { st._lastButton = st.button; return st.orbits || 0; }

    if (st.button > (st._lastButton ?? -1)) {
      st._lastButton = st.button;
      return st.orbits || 0;
    }

    // 按钮位绕回去了 → 完成一个完整人回合
    st._lastButton = st.button;
    const next = (st.orbits || 0) + 1;
    st.orbits = next;

    // 每满 10 圈升一档
    if (next % BLIND_LEVEL_ORBITS === 0 && st._leveledAtOrbit !== next) {
      st._leveledAtOrbit = next;
      const lv = st.blindLevel + 1;
      const nxt = lv < BLIND_LEVELS.length
        ? nextBlindLevel(st.smallBlind, st.bigBlind, st.blindLevel)
        : null;
      if (nxt) {
        st.blindLevel = lv;
        st.smallBlind = nxt[0];
        st.bigBlind = nxt[1];
        this._log(`盲注升级(第 ${next} 个人回合,第 ${lv + 1} 档)→ ${nxt[0]}/${nxt[1]}`, 'level');
      }
    }
    return st.orbits || 0;
  }

  startHand() {
    const st = this.state;
    if (st.handNo > 0 && !st.handOver) throw new Error('上一手还没结束');

    // 老的升盲模式:每 N 手盲注翻倍
    const upEvery = this.settings.blindUpEvery | 0;
    if (upEvery > 0 && st.handNo > 0 && st.handNo % upEvery === 0) {
      st.smallBlind *= 2;
      st.bigBlind *= 2;
      this._log(`盲注升级 → ${st.smallBlind}/${st.bigBlind}`, 'level');
    }

    st.handNo += 1;
    st.board = [];
    st.burned = [];
    st.pot = 0;
    st.currentBet = 0;
    st.lastFullRaise = st.bigBlind;
    st.minRaiseTo = st.bigBlind;
    st.aggressor = null;
    st.lastResult = null;
    st.handOver = false;
    st.handStartStacks = st.players.map((p) => p.stack);
    st.handActions = [];             // 本手的公开动作缓冲(要跨过 showdown 留到收尾)
    // ⚠️ 必须在这里清 log。
    //    `_showdown()` 只在**它开始时**清一次,之后又把摊牌结果写回 log;
    //    而这里以前从不清 —— 结果下一手的「本手到目前为止的过程」开头
    //    挂着上一手的摊牌记录(实测:AI 看到的「本手过程」里出现
    //    「—— 摊牌 —— 老陈: 4♥7♥ → 高牌 K」这种上一手的东西)。
    //    那会让 AI 把上一手的结果当成这一手已经发生的事,是「认知混乱」的来源之一。
    st.log = [];

    // 重置玩家,淘汰没筹码的
    for (const p of st.players) {
      // 底牌在这里清(上一手结束后要留给回顾,所以不能更早清)
      p.committed = 0; p.betThisRound = 0; p.hole = [null, null];
      p.folded = false; p.allIn = false; p.hasActed = false; p.lastAction = null;
      p.totalBetThisHand = 0;
      p.inHand = p.stack > 0;
    }
    const seated = st.players.filter((p) => p.inHand);
    if (seated.length < 2) throw new Error('至少需要 2 名有筹码的玩家');

    // 按钮位轮转
    st.button = this._nextSeat(st.button + 1, (p) => p.inHand);

    // 人回合与升盲:按需推进(见 orbitsNow)
    this.orbitsNow();

    // 洗牌(纯随机)
    st.deck = shuffle(buildDeck({ shortDeck: st.shortDeck }), this.rand);

    // 收前注(前注是死钱,不算本轮下注)
    if (st.ante > 0) {
      for (const p of seated) this._commit(p, Math.min(st.ante, p.stack), { ante: true });
    }

    // 盲注
    const headsUp = seated.length === 2;
    const sbSeat = headsUp ? st.button : this._nextSeat(st.button + 1, (p) => p.inHand);
    const bbSeat = this._nextSeat(sbSeat + 1, (p) => p.inHand);
    st.sbSeat = sbSeat; st.bbSeat = bbSeat;
    this._commit(st.players[sbSeat], Math.min(st.smallBlind, st.players[sbSeat].stack));
    this._commit(st.players[bbSeat], Math.min(st.bigBlind, st.players[bbSeat].stack));
    st.players[sbSeat].lastAction = { type: 'post', amount: st.players[sbSeat].betThisRound, label: '小盲' };
    st.players[bbSeat].lastAction = { type: 'post', amount: st.players[bbSeat].betThisRound, label: '大盲' };

    // 大盲前注:大盲位额外拿出「一个当前大盲」放进底池(算死钱,不算本轮下注)
    st.bbAnte = 0;
    if (st.bigBlindAnte) {
      const bbPlayer = st.players[bbSeat];
      const amt = Math.min(st.bigBlind, bbPlayer.stack);
      if (amt > 0) {
        this._commit(bbPlayer, amt, { ante: true });
        st.bbAnte = amt;
        this._log(`大盲前注:${bbPlayer.name} 额外投入 ${amt}(死钱,不计入本轮注额)`, 'info');
      }
    }

    st.currentBet = Math.max(...seated.map((p) => p.betThisRound));
    // 最小加注规则:任何加注的增量,至少要等于本下注轮里上一次下注/加注的额度。
    // 翻前视大盲为「上一次下注」,所以:
    //   lastFullRaiseTo   = 上一次完整下注/加注的「目标额」(翻前就是大盲)
    //   lastFullRaise     = 上一次完整下注/加注的「增量」
    //   minRaiseTo        = lastFullRaiseTo + lastFullRaise
    st.lastFullRaise = st.bigBlind;
    st.lastFullRaiseTo = st.bigBlind;
    st.minRaiseTo = st.bigBlind + st.bigBlind;

    // 发底牌:从小盲开始,每人一张,两轮
    const dealOrder = [];
    let s = sbSeat;
    for (let i = 0; i < seated.length; i++) { dealOrder.push(s); s = this._nextSeat(s + 1, (p) => p.inHand); }
    for (let round = 0; round < 2; round++) {
      for (const seat of dealOrder) {
        const p = st.players[seat];
        const card = st.deck.pop();
        p.hole[round] = card;
      }
    }

    st.street = 'preflop';
    st.pending = [];
    st.actor = null;

    const pos = this.positionLabels();
    this._log(`—— 第 ${st.handNo} 手开始,盲注 ${st.smallBlind}/${st.bigBlind} ——`, 'hand');
    this._log(`按钮位:${this.seatName(st.button)} | ${seated.map((p) => `${p.name}(${pos[p.seat] || '?'}, ${p.stack})`).join('、')}`, 'hand');
    if (st.shortDeck) this._log('短牌模式(36 张):A6789 为最小顺子,同花小于葫芦', 'hand');

    // 翻前行动:单挑时按钮位(小盲)先动,多人时大盲左侧先动
    const first = headsUp ? sbSeat : this._nextSeat(bbSeat + 1, (p) => p.inHand);
    this._beginRound(first, { preflop: true });
    return this.viewForDealer();
  }

  /** 把筹码从玩家手上放进本手投入。ante=true 表示这是前注:不计入本轮下注。 */
  _commit(player, amount, { ante = false } = {}) {
    const amt = Math.max(0, Math.min(amount, player.stack));
    player.stack -= amt;
    player.committed += amt;
    if (!ante) player.betThisRound += amt;      // 前注是死钱,不该抬高「本轮注额」
    player.totalBetThisHand += amt;
    if (player.stack === 0) player.allIn = true;
    return amt;
  }

  _beginRound(firstSeat, { preflop = false } = {}) {
    const st = this.state;
    for (const p of st.players) p.hasActed = false;
    // 已全下的玩家不算在行动队列里
    const order = [];
    let s = firstSeat;
    const total = st.players.filter((p) => p.inHand).length;
    for (let i = 0; i < total; i++) {
      const p = st.players[s];
      if (p.inHand && !p.folded && !p.allIn) order.push(s);
      s = this._nextSeat(s + 1, (q) => q.inHand);
    }
    st.pending = order;
    // 大盲在翻前即使所有人跟注也有最后说话权(option)
    if (preflop) st.pending = order;
    this._advanceActor();
  }

  /** 选下一个还没行动的玩家;没有则进入下一街 */
  _advanceActor() {
    const st = this.state;
    if (this._settleIfHandEnded()) return;

    while (st.pending.length) {
      const seat = st.pending[0];
      const p = st.players[seat];
      if (!p.inHand || p.folded || p.allIn) { st.pending.shift(); continue; }
      if (p.hasActed && p.betThisRound >= st.currentBet) { st.pending.shift(); continue; }
      st.actor = seat;
      return;
    }
    st.actor = null;
    this._endRound();
  }

  /* ------------------------------------------------------------------ 合法动作 */

  /** 当前行动者的可选项;非行动者返回 null */
  legalActions(seat = this.state.actor) {
    const st = this.state;
    if (seat === null || seat !== st.actor) return null;
    const p = st.players[seat];
    const toCall = Math.max(0, st.currentBet - p.betThisRound);
    const callAmount = Math.min(toCall, p.stack);
    const canCheck = toCall === 0;
    const canCall = toCall > 0 && p.stack > 0;
    const maxTo = p.betThisRound + p.stack;         // 全下的目标额
    // 完整加注所需的「加注到」目标额(可能超出他的手牌,超了就只可能全下)
    const fullMinTo = st.lastFullRaiseTo + st.lastFullRaise;
    const minTo = Math.min(fullMinTo, maxTo);
    const canRaise = p.stack > toCall;              // 还有多余筹码才能加注
    return {
      toCall, callAmount, canCheck, canCall,
      canRaise,
      canAllIn: p.stack > 0,
      minRaiseTo: minTo,
      fullMinRaiseTo: fullMinTo,                    // 想构成「完整加注」至少要加到这个数
      maxRaiseTo: maxTo,
      // 筹码不够做完整加注 → 只能全下,而全下增量不足时按「跟注」处理
      isAllInRaise: fullMinTo >= maxTo,
      currentBet: st.currentBet,
      lastFullRaise: st.lastFullRaise,
      pot: this.totalPot(),
      stack: p.stack,
    };
  }

  /** 把 AI/UI 给的动作规范化成合法动作;非法则抛出可读错误 */
  normalizeAction(seat, action) {
    const st = this.state;
    if (seat !== st.actor) throw new Error('还没轮到该玩家行动');
    const p = st.players[seat];
    const la = this.legalActions(seat);
    const type = String(action?.type || action?.action || '').toLowerCase();
    let amount = Number(action?.amount ?? action?.raiseTo ?? action?.to ?? 0);

    if (type === 'fold') return { type: 'fold' };
    if (type === 'check') {
      if (!la.canCheck) return { type: 'call', amount: la.callAmount, downgraded: 'check→call' };
      return { type: 'check' };
    }
    if (type === 'call') {
      if (la.toCall === 0) return { type: 'check', downgraded: 'call→check' };
      return { type: 'call', amount: la.callAmount };
    }
    if (type === 'allin' || type === 'all-in' || type === 'shove') {
      return { type: 'raise', amount: la.maxRaiseTo, allIn: true };
    }
    if (type === 'bet' || type === 'raise') {
      if (!la.canRaise) return { type: 'call', amount: la.callAmount, downgraded: 'raise→call(筹码不足)' };
      if (!Number.isFinite(amount) || amount <= 0) amount = la.minRaiseTo;
      let to = Math.round(amount);
      if (to >= la.maxRaiseTo) return { type: 'raise', amount: la.maxRaiseTo, allIn: true };
      // 最小加注规则:加注增量必须 >= 本下注轮上一次下注/加注的额度。
      // 低于这个数就直接抛错,让调用方自己修正 —— 不静默改成跟注,
      // 否则「想加注」会悄悄变成「只跟注」,意图被吞掉。
      if (to < la.minRaiseTo) {
        throw new Error(`加注到 ${to} 低于最小加注 ${la.minRaiseTo}`
          + `(本下注轮上一次下注/加注额为 ${la.lastFullRaise},加注增量至少要这么多)`);
      }
      return { type: 'raise', amount: to };
    }
    throw new Error(`无法识别的动作:${JSON.stringify(action)}`);
  }

  /* ------------------------------------------------------------------ 执行动作 */

  act(seat, action) {
    const st = this.state;
    const norm = this.normalizeAction(seat, action);
    const p = st.players[seat];
    const wasCurrentBet = st.currentBet;

    if (norm.type === 'fold') {
      p.folded = true;
      p.hasActed = true;
      p.lastAction = { type: 'fold', label: '弃牌' };
      this._log(`${p.name} 弃牌`, 'fold', { seat });
      this._noteAction(seat, 'fold', `${p.name} 弃牌`);
    } else if (norm.type === 'check') {
      p.hasActed = true;
      p.lastAction = { type: 'check', label: '看牌' };
      this._log(`${p.name} 看牌`, 'check', { seat });
      this._noteAction(seat, 'check', `${p.name} 看牌`);
    } else if (norm.type === 'call') {
      const paid = this._commit(p, norm.amount);
      p.hasActed = true;
      p.lastAction = paid > 0
        ? { type: 'call', amount: paid, allIn: p.allIn, label: p.allIn ? `跟注全下 ${paid}` : `跟注 ${paid}` }
        : { type: 'check', label: '看牌' };
      this._log(`${p.name} ${p.lastAction.label}${p.allIn ? '(全下)' : ''}`, 'call', { seat, amount: paid });
      this._noteAction(seat, 'call', `${p.name} ${p.lastAction.label}${p.allIn ? '(全下)' : ''}`);
    } else if (norm.type === 'raise') {
      const target = norm.amount;
      const paid = this._commit(p, target - p.betThisRound);

      // 最小加注规则:加注增量 >= 本下注轮上一次下注/加注的额度,才算「完整加注」。
      //   · 完整加注 → 更新基准、重开下注轮
      //   · 增量不足   → 只有「全下」才允许(短码全下),不重开下注轮,只能算跟注
      const prevBet = wasCurrentBet;
      const increment = target - prevBet;
      const isBet = prevBet === 0;
      const fullIncrement = st.lastFullRaise;
      const isFullRaise = increment >= fullIncrement;

      if (target <= prevBet) {
        // 连当前注额都没超过(纯粹是筹码不够):当跟注处理
        p.hasActed = true;
        p.lastAction = {
          type: 'call', amount: paid, allIn: p.allIn,
          label: p.allIn ? `跟注全下 ${paid}` : `跟注 ${paid}`,
        };
        this._log(`${p.name} ${p.lastAction.label}`, 'call', { seat, amount: paid });
        this._noteAction(seat, 'call', `${p.name} ${p.lastAction.label}`);
      } else if (isFullRaise) {
        // —— 完整下注 / 完整加注 ——
        st.lastFullRaise = isBet ? target : increment;
        st.lastFullRaiseTo = target;
        st.minRaiseTo = st.lastFullRaiseTo + st.lastFullRaise;
        st.currentBet = target;
        st.aggressor = seat;
        // 重开下注轮:其他还能行动的人都重新获得加注权
        for (const q of st.players) {
          if (q.inHand && !q.folded && !q.allIn && q.seat !== seat) q.hasActed = false;
        }
        p.hasActed = true;
        p.lastAction = {
          type: 'raise', amount: target, allIn: p.allIn, paid,
          label: `${isBet ? '下注' : '加注到'} ${target}${p.allIn ? ' (全下)' : ''}`,
        };
        this._log(`${p.name} ${p.lastAction.label}`, 'raise', { seat, amount: target, allIn: p.allIn });
        this._noteAction(seat, 'raise', `${p.name} ${p.lastAction.label}`);
      } else {
        // —— 增量不足,只可能是全下(短码全下)——
        // 规则上它不够「加注」,按跟注对待;但它确实抬高了 currentBet,
        // 所以:① 不重开下注轮(不重置别人的 hasActed)② 基准 minRaiseTo 不变。
        st.currentBet = target;
        const label = `全下 ${target}(增量 ${increment} 不足最小加注 ${fullIncrement},按跟注处理)`;
        p.hasActed = true;
        p.lastAction = { type: 'call', amount: paid, allIn: true, label };
        this._log(`${p.name} ${label}`, 'call', { seat, amount: paid, allIn: true });
        this._noteAction(seat, 'call', `${p.name} ${label}`);
      }
    }
    this.onAction?.({ seat, action: norm, player: this.publicPlayer(p) });

    // 行动过的先从队列移除
    st.pending = st.pending.filter((s) => s !== seat);

    // 关键:只要有人抬高了 currentBet,就必须重建行动队列。
    // 队列代表「谁还欠钱」—— 之前只有「完整加注」才重建,导致短码全下时
    // 已经行动过、但因此重新欠钱的人回不到队列里,本轮被提前关闭,
    // 少跟的筹码被免掉。(这是本次审查发现的 Bug 2)
    if (st.currentBet > wasCurrentBet) this._rebuildPending(seat);

    this._advanceActor();
    return this.viewForDealer();
  }

  _rebuildPending(fromSeat) {
    const st = this.state;
    const order = [];
    let s = fromSeat;
    const total = st.players.filter((p) => p.inHand).length + 1;
    for (let i = 0; i < total; i++) {
      s = this._nextSeat(s + 1, (p) => p.inHand);
      const p = st.players[s];
      if (p.inHand && !p.folded && !p.allIn && !order.includes(s)) order.push(s);
    }
    st.pending = order;
  }

  /* ------------------------------------------------------------------ 轮次收尾 */

  _settleIfHandEnded() {
    const st = this.state;
    const alive = this.activePlayers;
    if (alive.length <= 1) {
      if (st.handOver) return true;
      const winner = alive[0];
      st.pending = [];
      st.actor = null;
      this._refundUncalled(true);   // 只剩一家时,弃牌玩家多押的部分也算「没人跟」
      const amount = this.totalPot();
      if (winner) {
        this._award(winner.seat, amount);
        this._log(`其他人都弃牌了,${winner.name} 直接赢得底池 ${amount}`, 'win', { seat: winner.seat, amount });
        st.lastResult = { type: 'fold-win', winners: [{ seat: winner.seat, amount }], pot: amount, board: [] };
      }
      // 同摊牌路径:底池已变成筹码发出,committed 必须归零
      for (const p of st.players) p.committed = 0;
      st.pot = 0;
      this._finishHand();
      return true;
    }
    // 所有人都全下且下注额已拉平 → 直接发完公共牌摊牌
    const live = this.livePlayers;
    if (live.length === 0) { this._runOut(); return true; }
    if (live.length === 1 && live[0].betThisRound >= st.currentBet) {
      // 只剩一个能行动的玩家且已跟平 → 不再需要他行动
      const others = this.activePlayers.filter((p) => p.seat !== live[0].seat);
      if (others.every((p) => p.allIn)) { this._runOut(); return true; }
    }
    return false;
  }

  /**
   * 结束一条街:把本轮下注收进底池。
   * 注意 committed 里已经包含 betThisRound,所以这里必须先清零 betThisRound 再累加 pot,
   * 否则同一笔筹码会被重复计入底池(筹码凭空变多)。
   */
  _endRound() {
    const st = this.state;
    for (const p of st.players) p.betThisRound = 0;
    st.currentBet = 0;
    // 新的一条街:下注/加注基准归零。
    // 翻后第一个人的「下注」额度不限(可以下任意大小,上限就是他的筹码),
    // 所以基准额先记 0;等他下注之后才成为后面加注的最低增量。
    st.lastFullRaise = 0;
    st.lastFullRaiseTo = 0;
    st.minRaiseTo = 0;
    st.aggressor = null;

    if (st.street === 'preflop') {
      this._dealBoard(3);
      st.street = 'flop';
    } else if (st.street === 'flop') {
      this._dealBoard(1);
      st.street = 'turn';
    } else if (st.street === 'turn') {
      this._dealBoard(1);
      st.street = 'river';
    } else {
      this._showdown();
      return;
    }
    this._log(`【${STREET_LABEL[st.street]}】 ${st.board.map((c) => cardText(c)).join(' ')}`, 'street');

    const alive = this.activePlayers;
    if (alive.length <= 1 || this.livePlayers.length <= 1) { this._runOut(); return; }
    // 翻后:从按钮左侧第一个还能行动的玩家开始
    const first = this._nextSeat(st.button + 1, (p) => p.inHand && !p.folded && !p.allIn);
    this._beginRound(first);
  }

  _dealBoard(n) {
    // 烧牌后发牌(真实的荷官流程:翻牌/转牌/河牌前各烧一张)
    if (this.state.deck.length > n) this.state.burned.push(this.state.deck.pop());
    for (let i = 0; i < n; i++) this.state.board.push(this.state.deck.pop());
  }

  /**
   * 退回未被跟注的多余下注。
   * committed 与 betThisRound 必须同步减少,否则 totalPot() 会把退回的筹码又算一次。
   *
   * @param {boolean} foldedCountsAsCaller
   *   true —— 算上已弃牌玩家的投入。只剩一家没弃牌时必须这样算:
   *           弃牌玩家多押出去的部分没人跟,属于他自己的钱,要退给他。
   *   false —— 只跟「还在牌局里」的玩家比较(全下摊牌前用)。
   */
  _refundUncalled(foldedCountsAsCaller = false) {
    const st = this.state;
    const alive = st.players.filter((p) => p.inHand && !p.folded);
    if (alive.length === 0) return 0;
    let sorted;
    if (alive.length === 1 && !foldedCountsAsCaller) {
      // 只剩一家:没人跟他的注,全部退回
      sorted = [alive[0], { committed: 0 }];
    } else {
      const pool = foldedCountsAsCaller ? st.players.filter((p) => p.inHand) : alive;
      sorted = [...pool].sort((a, b) => b.committed - a.committed);
    }
    if (sorted.length < 2) return 0;
    const top = sorted[0], second = sorted[1];
    const excess = top.committed - second.committed;
    if (excess > 0) {
      top.committed -= excess;
      top.betThisRound = Math.max(0, top.betThisRound - excess);
      top.stack += excess;
      top.totalBetThisHand -= excess;
      this._log(`${top.name} 未被跟注的 ${excess} 退回`, 'info');
      return excess;
    }
    return 0;
  }

  /** 底池总额 = 已收集的 pot + 本手各家的总投入(committed 已含本轮) */
  totalPot() {
    const st = this.state;
    return st.pot + st.players.reduce((sum, p) => sum + p.committed, 0);
  }

  /** 剩余玩家全部全下 → 逐街发完公共牌并摊牌 */
  _runOut() {
    const st = this.state;
    for (const p of st.players) p.betThisRound = 0;
    st.currentBet = 0;
    this._refundUncalled();
    st.pending = [];
    st.actor = null;
    while (st.board.length < 5) {
      const need = st.board.length === 0 ? 3 : 1;
      this._dealBoard(need);
      st.street = st.board.length === 3 ? 'flop' : st.board.length === 4 ? 'turn' : 'river';
      this._log(`【${STREET_LABEL[st.street]}】 ${st.board.map((c) => cardText(c)).join(' ')}`, 'street');
    }
    this._log('所有玩家已全下,公共牌直接发完', 'info');
    this._showdown();
  }

  /* ------------------------------------------------------------------ 摊牌与分池 */

  /**
   * 构建主池 + 边池。
   * 每一层(level)只有「投入 >= level」的玩家参与,金额 = (level - 上一层) × 该层参与人数。
   * 相邻两层如果参与者完全相同,就合并成一个池展示(注意不能直接累加金额,
   * 因为每人的份额 slice 不同,必须分别算好再相加)。
   */
  buildPots() {
    const st = this.state;
    const contributors = st.players.filter((p) => p.committed > 0);
    const levels = [...new Set(contributors.map((p) => p.committed))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      const slice = level - prev;
      const participants = st.players.filter((p) => p.committed >= level);
      const amount = slice * participants.length;
      // 资格 = 本手参与者(含已弃牌者:他们是被动投入的死钱,必须有人能赢走这些筹码)
      const eligible = participants.filter((p) => p.inHand).map((p) => p.seat);
      prev = level;
      if (amount <= 0 || eligible.length === 0) continue;
      const last = pots[pots.length - 1];
      if (last && last.eligible.join(',') === eligible.join(',')) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    return pots;
  }

  _award(seat, amount) {
    const p = this.state.players[seat];
    p.stack += amount;
  }

  _showdown() {
    const st = this.state;
    st.street = 'showdown';
    st.log = [];                       // 清掉上一手的记录,避免摊牌日志串台
    if (globalThis.__leakDebug) globalThis.__leakDebug('showdown:进入', this, 0);
    const alive = this.activePlayers;
    const opts = { shortDeck: st.shortDeck };

    for (const p of alive) {
      const all = [...p.hole, ...st.board];
      const best = evaluate(all, opts);
      p._score = best;
      p._handName = describe(best, opts);
      this.onDebug?.(`座位${p.seat} ${p.hole.map(cardText).join(' ')} + ${st.board.map(cardText).join(' ')} = ${p._handName}`);
    }

    this._log('—— 摊牌 ——', 'showdown');
    for (const p of alive) {
      this._log(`${p.name}: ${p.hole.map((c) => cardText(c)).join(' ')} → ${p._handName}`, 'showdown', { seat: p.seat });
    }

    const pots = this.buildPots();
    const payouts = new Map();      // seat -> total
    const detail = [];
    const n = st.players.length;
    let carry = 0;                  // 极端情况下无人可赢的池,滚入下一个池,保证筹码不丢

    pots.forEach((pot, idx) => {
      const contenders = pot.eligible.map((s) => st.players[s]).filter((p) => p.inHand && !p.folded);
      if (contenders.length === 0) { carry += pot.amount; return; }
      let bestScore = null;
      for (const p of contenders) if (!bestScore || compare(p._score, bestScore) > 0) bestScore = p._score;
      const winners = contenders.filter((p) => compare(p._score, bestScore) === 0);
      const totalAmount = pot.amount + carry;
      carry = 0;
      const share = Math.floor(totalAmount / winners.length);
      let remainder = totalAmount - share * winners.length;
      // 余数从**按钮左侧第一家**开始顺时针发。
      // 注意距离要从 button+1 起算 —— 用 (seat - button) 的话按钮位自己算出 0,
      // 会永远排第一、把余数拿走(那是错的:按钮位并不是「按钮左侧最近的人」)。
      const ordered = [...winners].sort((a, b) => {
        const da = (a.seat - st.button - 1 + n * 2) % n;
        const db = (b.seat - st.button - 1 + n * 2) % n;
        return da - db;
      });
      for (const w of ordered) {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder -= 1; }
        payouts.set(w.seat, (payouts.get(w.seat) || 0) + amt);
      }
      detail.push({
        index: idx, amount: totalAmount, eligible: pot.eligible,
        winners: winners.map((w) => w.seat),
        handName: describe(bestScore, opts),
        label: idx === 0 ? '主池' : `边池 ${idx}`,
      });
      this._log(`${idx === 0 ? '主池' : '边池 ' + idx} ${totalAmount} → ${winners.map((w) => w.name).join('、')} (${describe(bestScore, opts)})`, 'pot');
    });

    // 兜底:如果还有滚存的金额(理论上只在「所有人都弃牌但已进入摊牌」这类病态情形出现),
    // 发给本手参与者中牌力最强者,保证筹码永远不凭空消失。
    if (carry > 0) {
      const pool = st.players.filter((p) => p.inHand);
      let best = null;
      for (const p of pool) if (p._score && (!best || compare(p._score, best._score) > 0)) best = p;
      if (!best) best = pool[0];
      payouts.set(best.seat, (payouts.get(best.seat) || 0) + carry);
      this._log(`尾池 ${carry} 无人认领,判给 ${best.name}`, 'pot');
      carry = 0;
    }

    for (const [seat, amt] of payouts) this._award(seat, amt);
    // 底池已经变成筹码发回给玩家,committed 必须归零,否则会被重复计入筹码总量
    for (const p of st.players) p.committed = 0;
    st.pot = 0;
    const reveal = alive.map((p) => ({
      seat: p.seat, name: p.name, hole: p.hole.slice(), handName: p._handName, score: p._score,
      won: payouts.get(p.seat) || 0,
    }));

    st.lastResult = {
      type: 'showdown', pot: pots.reduce((s, p, i) => s + (detail[i]?.amount ?? p.amount), 0), board: st.board.slice(),
      pots: detail, payouts: [...payouts.entries()].map(([seat, amount]) => ({ seat, amount })), reveal,
      winners: [...payouts.entries()].map(([seat, amount]) => ({ seat, amount })),
    };
    this._finishHand();
  }

  _finishHand() {
    const st = this.state;
    st.street = st.lastResult?.type === 'showdown' ? 'showdown' : 'river';
    st.handOver = true;
    st.actor = null;
    st.pending = [];
    st.pot = 0;
    for (const p of st.players) {
      p.betThisRound = 0;
      p.allIn = false;        // 全下是「手牌中」的状态,分池后必须清掉
      p.hasActed = false;
      // 注意:这里**不能**清底牌。
      // 筹码打光的玩家只是「下一手不参与了」,但这一手的牌还要留着 ——
      // 玩家模式的「上一手回顾」要能翻出他到底拿的是什么。
      // 真正清底牌的地方在 startHand()(每手重置玩家的那一步)。
      if (p.stack === 0) p.inHand = false;
    }
    // 记录本手净输赢
    const deltas = st.players.map((p, i) => ({
      seat: i,
      delta: p.stack - st.handStartStacks[i],
      stack: p.stack,
      inHand: p.inHand,
    }));
    for (const p of st.players) { delete p._score; delete p._handName; }
    st.lastResult = { ...(st.lastResult || { type: 'unknown' }), deltas };
    const busted = st.players.filter((p) => p.stack === 0 && p.inHand);
    if (busted.length) this._log(`淘汰出局:${busted.map((p) => p.name).join('、')}`, 'bust');
    const left = st.players.filter((p) => p.stack > 0);
    if (left.length === 1) this._log(`🏆 ${left[0].name} 赢下全场!`, 'champion');

    // 记下这一手的「公开摘要」,给 AI 的记性用(跨手保留)。
    // 必须在 onHandEnd 之前 —— 写读人笔记是那个回调里触发的。
    this._captureHandDelta();
    this.onHandEnd?.(st.lastResult);
  }

  /**
   * 把刚结束的这一手压成一条**公开摘要**,追加到 st.handDeltas。
   *
   * 这里刻意**只用公开信息**:
   *   · 谁做了什么动作、金额多少(牌桌上所有人都看得到);
   *   · 谁在摊牌时亮了什么牌(亮过就是公开的);
   *   · 公共牌、底池、谁赢、输赢多少。
   * ⚠️ **弃牌时没亮过的底牌绝不写进来** —— 这是信息隔离的底线:
   *    AI 的记性只能建立在「真人也能看到」的信息上,否则它就是在作弊。
   *    (有专门的测试守着这条,见 tools/notetest.mjs)
   *
   * 只保留最近 KEEP 手:AI 的长期认知靠它自己写的读人笔记,
   * 明细只是「最近发生了什么」,不需要无限堆积。
   */
  _captureHandDelta() {
    const st = this.state;
    const res = st.lastResult || {};
    const KEEP = 5;
    const actions = [];
    // 用 _noteAction 记下的结构化事件(不是 st.log —— 那个在 showdown 被清过)
    for (const a of st.handActions) actions.push(a.text);
    // 街的推进也带上,让摘要看得出「翻牌圈发生了什么」
    for (const l of st.log) {
      if (l.kind === 'street') actions.push(l.text);
    }
    // 摊牌亮过的牌(亮过才算公开)
    const showdown = [];
    if (res.type === 'showdown') {
      for (const p of st.players) {
        if (p.folded || !p.inHand) continue;
        if (!p.hole.every((c) => c !== null)) continue;
        showdown.push({ seat: p.seat, name: p.name, hole: p.hole.slice() });
      }
    }
    const deltas = (res.deltas || []).map((d) => ({ seat: d.seat, delta: d.delta }));
    st.handDeltas.push({
      handNo: st.handNo,
      type: res.type || 'unknown',
      board: st.board.slice(),
      pot: res.pot || 0,
      actions,
      showdown,
      winners: (res.winners || []).map((w) => ({ seat: w.seat, amount: w.amount })),
      deltas,
    });
    while (st.handDeltas.length > KEEP) st.handDeltas.shift();
  }

  /**
   * 取最近的公开手牌摘要(给 AI 的牌桌记忆 / 写笔记用)。
   * @param {number} [n] 取最近几手,默认全部(引擎内部已只保留最近 5 手)
   */
  recentHands(n) {
    const arr = this.state.handDeltas || [];
    return (n && n > 0) ? arr.slice(-n) : arr.slice();
  }

  /* ------------------------------------------------------------------ 对外视图 */

  publicPlayer(p) {
    return {
      seat: p.seat, name: p.name, stack: p.stack, committed: p.committed,
      betThisRound: p.betThisRound, folded: p.folded, allIn: p.allIn, inHand: p.inHand,
      lastAction: p.lastAction, persona: p.persona, cards: p.hole.filter((c) => c !== null).length,
    };
  }

  /** 荷官视角:包含所有底牌(界面默认不渲染) */
  viewForDealer() {
    const st = this.state;
    const human = st.humanSeat;
    return {
      handNo: st.handNo, street: st.street, streetLabel: STREET_LABEL[st.street] || st.street,
      button: st.button, smallBlind: st.smallBlind, bigBlind: st.bigBlind, ante: st.ante,
      bigBlindAnte: !!st.bigBlindAnte, bbAnte: st.bbAnte || 0,
      blindLevelUp: !!st.blindLevelUp, blindLevel: st.blindLevel,
      blindLevelCount: BLIND_LEVELS.length, orbits: this.orbitsNow(),
      orbitsPerLevel: BLIND_LEVEL_ORBITS,
      shortDeck: st.shortDeck, board: st.board.slice(), pot: this.totalPot(), currentBet: st.currentBet,
      burned: (st.burned || []).length,
      minRaiseTo: st.minRaiseTo, lastFullRaise: st.lastFullRaise,
      actor: st.actor, pending: st.pending.slice(), handOver: st.handOver,
      positions: this.positionLabels(),
      deckLeft: st.deck.length,
      // 玩家模式下:别人的底牌不下发,只给张数。这样即使有人打开开发者工具也看不到。
      // 想看别人的牌,只能等这一手结束后走 reviewHand()。
      humanSeat: human,
      players: st.players.map((p) => (human === null || p.seat === human
        ? { ...this.publicPlayer(p), hole: p.hole.slice() }
        : { ...this.publicPlayer(p), hole: [null, null] })),
      lastResult: st.lastResult,
      pots: st.handOver && st.lastResult?.pots ? st.lastResult.pots : null,
    };
  }

  /**
   * 玩家模式下「上一手回顾」:这一手结束之后才允许调用。
   *
   * 为什么单独开一个方法而不是直接放宽 viewForDealer:
   * 视图对象一旦带着别人的底牌下发,前端任何一处 console.log 都会泄露。
   * 所以底牌只在「这一手确实结束了」并且界面明确请求回顾时才拿得到。
   */
  reviewHand() {
    const st = this.state;
    if (st.humanSeat === null || st.humanSeat === undefined) {
      throw new Error('当前不是玩家模式');
    }
    if (!st.handOver) throw new Error('这一手还没结束,不能查看别家手牌');
    const opts = { shortDeck: st.shortDeck };
    return {
      handNo: st.handNo,
      streetLabel: STREET_LABEL[st.street] || st.street,
      board: st.board.slice(),
      pot: this.totalPot(),
      result: st.lastResult,
      players: st.players.map((p) => {
        // 我自己那一手牌永远看得到(本来就是我拿过的);
        // 别人只有「参与了这一手而且没弃牌」才亮牌 —— 弃牌的人本来就没亮过。
        // 注意还要算上「这一手把筹码打光、已经出局」的人:他的牌也该能回顾。
        const isMe = p.seat === st.humanSeat;
        const busted = p.stack <= 0 && p.hole.some((c) => c !== null);
        const revealed = isMe || ((p.inHand || busted) && !p.folded);
        let handName = null;
        if (revealed && p.hole.every((c) => c !== null) && st.board.length >= 5) {
          const best = evaluate([...p.hole, ...st.board], opts);
          handName = describe(best, opts);
        }
        // 我自己如果弃牌了,成牌名会误导(没参与摊牌),所以标一下
        if (isMe && p.folded) handName = null;
        return {
          seat: p.seat,
          name: p.name,
          isMe,
          folded: p.folded,
          inHand: p.inHand,
          busted,
          hole: revealed ? p.hole.slice() : [null, null],
          handName,
        };
      }),
    };
  }

  /** 某个座位的视角(严格信息隔离:只有自己的底牌 + 公共信息) */
  viewForSeat(seat) {
    const st = this.state;
    const me = st.players[seat];
    const opts = { shortDeck: st.shortDeck };
    const myBest = me.hole.every((c) => c !== null) && st.board.length >= 3
      ? evaluate([...me.hole, ...st.board], opts) : null;
    const sit = this.stackSituation(seat);
    return {
      me: {
        seat, name: me.name, stack: me.stack, hole: me.hole.slice(),
        betThisRound: me.betThisRound, committed: me.committed, folded: me.folded, allIn: me.allIn,
        myHandNow: myBest ? describe(myBest, opts) : null,
        // 筹码状况(可操作的解读,不只是原始数字):
        // 大盲数 / 桌上排名 / 短中深档位 / 离出局还有多远
        ...sit.per[seat],
      },
      handNo: st.handNo, street: st.street, streetLabel: STREET_LABEL[st.street] || st.street,
      board: st.board.slice(), pot: this.totalPot(), currentBet: st.currentBet, minRaiseTo: st.minRaiseTo,
      button: st.button, smallBlind: st.smallBlind, bigBlind: st.bigBlind, shortDeck: st.shortDeck,
      // 盲注尺度:提示词里金额一律「换算成大盲」来讲,因为盲注会升级,
      // 绝对数字会骗人(第 1 档的 200 和第 20 档的 200 完全不是一回事)
      blindUnit: st.bigBlind,
      ante: st.ante, bbAnte: st.bbAnte || 0, bigBlindAnte: !!st.bigBlindAnte,
      blindLevelUp: !!st.blindLevelUp, blindLevel: st.blindLevel, orbits: st.orbits || 0,
      // 还有几个人活着 / 总共几个座位 —— 用来判断「离冠军多远」
      aliveCount: sit.aliveCount, totalSeats: sit.totalSeats,
      // 全场筹码排名一览(谁是筹码王、谁快死了)
      stackTable: st.players
        .filter((p) => p.stack > 0)
        .sort((a, b) => b.stack - a.stack)
        .map((p) => ({ seat: p.seat, name: p.name, ...sit.per[p.seat] })),
      position: this.positionLabels()[seat] || '?',
      // 位置好坏说成人话。模型经常把「先行动」和「位置好」搞反
      // (实测出现过把盲注位当好位置的说法),所以直接把结论给它。
      positionHint: this.positionHint(seat),
      // 本手的行动顺序(例如「UTG → HJ → CO → BTN → SB → BB」)。
      // 给了这个就不必再给「按钮位在几号位」—— 那正是让模型认知错乱的东西。
      orderText: this.orderText(),
      toCall: Math.max(0, st.currentBet - me.betThisRound),
      players: st.players.map((p) => ({
        seat: p.seat, name: p.name, stack: p.stack, betThisRound: p.betThisRound,
        folded: p.folded, allIn: p.allIn, inHand: p.inHand, lastAction: p.lastAction,
        position: this.positionLabels()[p.seat] || null,
        // 每个对手的筹码也换算成大盲数 + 档位 + 排名
        ...sit.per[p.seat],
        isMe: p.seat === seat,
      })),
      legal: this.legalActions(seat),
      handOver: st.handOver,
    };
  }

  /** 本手到目前为止的行动历史(文字,给 AI 看) */
  actionHistory(limit = 40) {
    return this.state.log
      .filter((l) => ['fold', 'call', 'raise', 'check', 'street', 'hand', 'showdown', 'win', 'pot'].includes(l.kind))
      .slice(-limit)
      .map((l) => l.text);
  }
}

export { PokerEngine, DEFAULT_SETTINGS, STREET_LABEL, CAT, evaluate, compare, describe };
