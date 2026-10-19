/**
 * 一局「谁是卧底」的流程驱动 —— 串行描述、逐个投票、淘汰、判胜负。
 *
 * 为什么它单独一层(而不是塞进 ui/screen.js):
 *   · 屏幕要处理 3D、DOM、按钮、玩家输入,已经很重了;流程本身是纯逻辑 + 回调,
 *     放一起会让「一局怎么走」淹没在渲染代码里;
 *   · 测试(纯 Node)要能**不开浏览器**跑完一整局:给它 kernel + 假 agent + 事件
 *     回调即可,不碰 DOM(见 tools/undercovertest.mjs 的完整对局用例)。
 *
 * 与 kernel 的分工:kernel 判「这一句/这一票合不合法、谁出局、谁赢」;
 * runner 只负责**按顺序去问、按顺序记、在中间做停顿与广播**。它自己不做任何判定 ——
 * 所以规则只有一份,runner 里没有第二套。
 */

import { buildView } from './view.js';
import { neutralSay } from './filter.js';
import { normalizeGuess } from './engine/kernel.js';
import { CANCEL_MESSAGE } from '../../shared/llmCaller.mjs';

/** 可被 abort 打断的等待(退出本局 / 重开时立刻停,不要睡完再发现已经取消) */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(CANCEL_MESSAGE)); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    const onAbort = () => { cleanup(); reject(new Error(CANCEL_MESSAGE)); };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class UndercoverRunner {
  /**
   * @param {object} opts
   * @param {object} opts.kernel 规则内核
   * @param {Map<number,object>} opts.agents 座位 → UndercoverAgent(**不含玩家自己的座位**)
   * @param {{seat:number, describe:(view)=>Promise<object>, vote:(view)=>Promise<object>}|null} opts.human
   *   玩家模式下的「我」。玩家座位不建 agent,由界面提供这两件事。
   * @param {object} opts.hooks 事件回调(onEvent / onThinking / names)
   * @param {number} [opts.delayMs] 每次描述/投票之间的停顿(观感用,不影响逻辑)
   * @param {(()=>({rounds:number,ranking:Array<{seat:number,name:string,score:number}>}))|null} [opts.matchStandings]
   *   本场积分榜的公开快照(屏幕提供)。传给 buildView → 提示词里的【你的最终目标】。
   *   用函数而不是数组:一场里每打完一局都会变,开局取一次会一直念旧排名。
   * @param {AbortSignal} [opts.signal]
   */
  constructor({
    kernel, agents = new Map(), human = null, hooks = {}, delayMs = 0, signal = null, matchStandings = null,
  } = {}) {
    if (!kernel) throw new Error('UndercoverRunner 需要 kernel');
    this.kernel = kernel;
    this.agents = agents;
    this.human = human;
    this.hooks = hooks;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.signal = signal;
    this.matchStandings = typeof matchStandings === 'function' ? matchStandings : null;
    this.running = false;
    this._stopped = false;
    this._lastRound = kernel.state.round;
    this._seenElims = kernel.state.eliminated.length;
  }

  get state() { return this.kernel.state; }

  /**
   * 建某个座位的视角,并挂上**本场积分榜**(公开信息)。
   * view.js 只认识内核 state,积分表在屏幕手里 —— 由 runner 这层把公开快照交过去。
   */
  _viewFor(seat) {
    return buildView(this.kernel.state, seat, {
      matchStandings: this.matchStandings ? this.matchStandings() : null,
    });
  }

  /** 只发一次的事件(避免 ui 重复塞日志) */
  _emit(type, payload) {
    try { this.hooks.onEvent?.({ type, ...payload }); } catch { /* 界面出错不影响对局 */ }
  }

  /** 「局面往前走了」的三个观察点:开新轮、有人出局、分出胜负 */
  _syncMilestones(prevRound = this._lastRound, prevElims = this._seenElims) {
    const st = this.kernel.state;
    if (st.round !== prevRound && st.phase !== 'end') {
      this._emit('round', { round: st.round, order: st.order.slice() });
    }
    while (this._seenElims < st.eliminated.length) {
      const e = st.eliminated[this._seenElims];
      this._seenElims += 1;
      this._emit('eliminate', { seat: e.seat, role: e.role, round: e.round });
    }
    if (st.phase === 'end' && st.winner) {
      // 只在第一次进入 end 时广播
      if (!this._ended) {
        this._ended = true;
        this._emit('end', { winner: st.winner, reason: st.endReason });
      }
    }
    this._lastRound = st.round;
  }

  /**
   * 跑(或**接着跑**)这一局。
   *
   * 「接着跑」是快照恢复的关键:恢复出来的 state 可能停在描述轮中间(orderIdx>0)
   * 或投票轮中间(有人已经投过了),这里一律从 kernel 的当前状态继续,
   * 不假设「一定从头开始」。所以恢复流程不需要第二套「重建到第几轮」的代码。
   */
  async run() {
    if (this.running) return;
    this.running = true;
    this._stopped = false;
    this._ended = false;
    try {
      // 已经开局但还没发词(phase==='idle'):先发词
      if (this.kernel.state.phase === 'idle') {
        this.kernel.start(this.hooks.names || []);
        this._emit('start', { round: this.kernel.state.round, seats: this.kernel.state.config.seats });
        this._syncMilestones();
      }
      for (;;) {
        if (this._shouldStop()) return;
        const cur = this.kernel.state;
        if (cur.phase === 'end') {
          this._syncMilestones();
          return;
        }
        if (cur.phase === 'describe') {
          const seat = this.kernel.currentSpeaker();
          if (seat === null) continue;                 // 防御:状态自相矛盾时别死循环
          const roundBefore = cur.round;
          await this._describe(seat);
          this._syncMilestones(roundBefore);
          await this._pause();
          continue;
        }
        if (cur.phase === 'vote') {
          const pending = this.kernel.pendingVoters();
          if (!pending.length) continue;               // 结算发生在 recordVote 内部
          const roundBefore = cur.round;
          await this._vote(pending[0]);
          this._syncMilestones(roundBefore);
          await this._pause();
          continue;
        }
        // idle / reveal 不该在这里停留:reveal 是 _settleVote 内部的瞬时状态
        throw new Error(`runner 停在了意外阶段:${cur.phase}`);
      }
    } finally {
      this.running = false;
    }
  }

  async _pause() {
    if (this.delayMs <= 0) return;
    await sleep(this.delayMs, this.signal);
  }

  /** 外部要求停(退出本局 / 重开) */
  stop() { this._stopped = true; }

  _shouldStop() {
    return this._stopped || !!this.signal?.aborted;
  }

  /* ------------------------------------------------------------ 描述 */

  async _describe(seat) {
    const view = this._viewFor(seat);
    if (this.human && seat === this.human.seat) {
      this._emit('speaker', { seat, human: true });
      const res = await this.human.describe(view);
      // 玩家可能在等输入时点「退出本局」—— 那之后**不许再改局面**
      if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);
      return this._recordDescribe(seat, res, 'human');
    }

    const agent = this.agents.get(seat);
    if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
    this._emit('speaker', { seat, human: false });
    this.hooks.onThinking?.(seat, '', true);
    const res = await agent.describe(view, { signal: this.signal });
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);
    return this._recordDescribe(seat, res, res.source);
  }

  _recordDescribe(seat, res, source) {
    // ★ 猜词:描述轮的另一种动作(规则与判定全在 kernel.recordGuess 里,
    //   这里只负责把「该谁猜」那个决定送进去、再把**能公开的部分**广播出去)。
    if (res?.action === 'guess') return this._recordGuess(seat, res, source);
    const say = String(res?.say ?? '').trim();
    if (!say) {
      // 正常情况下 agent 一定给了兜底句;玩家自己交来的空描述由界面挡住。
      // 走到这里说明调用方绕过了那一层 —— 用确定性中性句,绝不空着过。
      return this._recordDescribe(seat, {
        say: neutralSay(seat, this.kernel.state.round), quality: 'low', selfRead: 'unsure',
      }, 'fallback');
    }
    this.kernel.recordDescription(seat, say, {
      selfRead: res?.selfRead,
      quality: res?.quality,
    });
    this._emit('describe', {
      seat, say, selfRead: res?.selfRead || 'unsure', thinking: res?.thinking || '',
      source, quality: res?.quality === 'low' ? 'low' : 'ok', filtered: res?.filtered || null,
    });
  }

  /**
   * 记一次猜词。猜的词先过一遍 kernel 的 normalizeGuess(与裁判同一份清洗规则),
   * 空的/清理后没东西的,退回中性描述 —— 猜词是**能改胜负**的动作,
   * 绝不允许带着一个半截的字符串进裁判。
   */
  _recordGuess(seat, res, source) {
    const guess = normalizeGuess(res?.guess);
    if (!guess) {
      return this._recordDescribe(seat, {
        say: neutralSay(seat, this.kernel.state.round), quality: 'low', selfRead: 'unsure',
      }, 'fallback');
    }
    const r = this.kernel.recordGuess(seat, guess);
    // ⚠️ 只广播 public* 那两个字段:平民/白板猜的词**不能**公开(会把平民词
    //    送给还活着的卧底)。观看模式要看全量的话,去 god 视图里拿,不走事件。
    this._emit('guess', {
      seat,
      text: r.publicText,
      hit: r.publicHit,
      role: r.role,
      ended: r.ended,
      winner: r.winner,
      eliminated: r.eliminated,
      thinking: res?.thinking || '',
      source,
    });
  }

  /* ------------------------------------------------------------ 投票 */

  async _vote(seat) {
    const view = this._viewFor(seat);
    this._emit('voteStart', { seat });
    let res;
    if (this.human && seat === this.human.seat) {
      res = await this.human.vote(view);
    } else {
      const agent = this.agents.get(seat);
      if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
      this.hooks.onThinking?.(seat, '', true);
      res = await agent.vote(view, { signal: this.signal });
    }
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);
    let target = res?.target ?? null;
    // 最终一道合法性校验(agent 里已经判过一次,玩家输入也要过这里):
    // 非法目标一律**弃票**,不随机改投 —— 「随机兜底毁一致性」是研究文档明确的坑。
    if (target !== null) {
      const ok = Number.isInteger(target) && this.kernel.state.alive[target]
        && target !== seat && view.voteCandidates.includes(target);
      if (!ok) {
        this._emit('voteInvalid', { seat, target });
        target = null;
      }
    }
    this.kernel.recordVote(seat, target, String(res?.reason || ''));
    this._emit('vote', {
      from: seat, to: target, reason: String(res?.reason || ''),
      thinking: res?.thinking || '', source: res?.source || 'llm',
    });
  }
}

export { sleep };
