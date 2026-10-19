/**
 * 一局「阿瓦隆」的流程驱动 —— 队长提名 → 全员投票 → 上车投卡 → 判胜负 / 下一轮。
 *
 * 为什么它单独一层(而不是塞进 ui/screen.js):
 *   · 屏幕要处理 3D、DOM、按钮、玩家输入,已经很重了;流程本身是纯逻辑 + 回调,
 *     放一起会让「一局怎么走」淹没在渲染代码里;
 *   · 测试(纯 Node)要能**不开浏览器**跑完一整局:给它 kernel + 假 agent + 事件
 *     回调即可,不碰 DOM(见 tools/avalonest.mjs 的完整对局用例);
 *   · 无头模拟器需要「不调 LLM 也能跑」的驱动 —— 把 agents 换成本地 bot 即可。
 *
 * 与 kernel 的分工:kernel 判「这一队合不合法、投票过没过、任务成没成、谁赢」;
 * runner 只负责**按顺序去问、按顺序记、在中间做停顿与广播**。它自己不做任何判定 ——
 * 所以规则只有一份,runner 里没有第二套。
 *
 * ⚠️ 两条节奏上的讲究(与狼人杀同一套,但有一处**相反**)
 *   · 队长提名是**串行**的(一次只有一个队长);
 *   · 投票是**并行**请求、**一起**记录 —— 标准玩法里所有人同时亮票,
 *     所以不能让后投的人看到前面的人的票(那是狼人杀那种逐票揭晓的节奏,在这里是规则错误);
 *   · 上车投卡也是**并行**(互不依赖),投完只公布合计。
 */

import { buildView } from './view.js';
import { fallbackSay } from './prompts.js';
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

export class AvalonRunner {
  /**
   * @param {object} opts
   * @param {object} opts.kernel 规则内核
   * @param {Map<number,object>} opts.agents 座位 → AvalonAgent(**不含玩家自己的座位**)
   * @param {{seat:number, proposeTeam?:(view)=>Promise<object>, vote?:(view)=>Promise<object>,
   *          playCard?:(view)=>Promise<object>, assassinate?:(view)=>Promise<object>}|null} opts.human
   *   玩家模式下的「我」。玩家座位不建 agent,由界面提供这几件事。
   * @param {object} opts.hooks 事件回调(onEvent / onThinking / names)
   * @param {number} [opts.delayMs] 每一步之间的停顿(观感用,不影响逻辑)
   * @param {boolean} [opts.revealSecrets] 是否允许把**私有**信息(谁出了失败卡、
   *   刺客的思考)写进事件(上帝视角 true;玩家模式 false —— 这是「渲染前就不取」
   *   在事件层的落点:false 时事件里根本没有 card 字段,屏幕不可能画出来)
   * @param {AbortSignal} [opts.signal]
   */
  constructor({
    kernel, agents = new Map(), human = null, hooks = {},
    delayMs = 0, revealSecrets = false, signal = null,
  } = {}) {
    if (!kernel) throw new Error('AvalonRunner 需要 kernel');
    this.kernel = kernel;
    this.agents = agents;
    this.human = human;
    this.hooks = hooks;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.revealSecrets = !!revealSecrets;
    this.signal = signal || null;
    this.running = false;
    this._stopped = false;
    this._ended = false;
    /** 已经广播到账本的哪一条(避免重复发事件) */
    this._seenEvents = 0;
  }

  get state() { return this.kernel.state; }

  /** 只发一次的事件(避免 ui 重复塞日志) */
  _emit(type, payload = {}) {
    try { this.hooks.onEvent?.({ type, ...payload }); } catch { /* 界面出错不影响对局 */ }
  }

  /**
   * 跑(或**接着跑**)这一局。
   *
   * 「接着跑」是快照恢复的关键:恢复出来的 state 可能停在投票中间(有人已经投过了)、
   * 或任务卡投到一半,这里一律从 kernel 的当前状态继续,不假设「一定从头开始」。
   */
  async run() {
    if (this.running) return;
    this.running = true;
    this._stopped = false;
    this._ended = false;
    try {
      if (this.kernel.state.phase === 'idle') {
        this.kernel.start(this.hooks.names || []);
        this._emit('start', {
          round: this.kernel.state.round,
          seats: this.kernel.state.config.seats,
          roster: { ...this.kernel.state.roster },
          leader: this.kernel.state.leader,
        });
        // 把 start/round 这两条账本事件也放出去(界面的「第 1 轮」就是从这里来的)
        this._drainLedger();
      }
      let guard = 0;
      for (;;) {
        if (this._shouldStop()) return;
        if (guard++ > 400) throw new Error('阿瓦隆流程没有推进(状态机出错)');
        const st = this.kernel.state;
        if (st.phase === 'end') { this._emitEnd(); return; }

        if (st.phase === 'team') {
          const leader = this.kernel.currentLeader();
          if (leader === null) continue;
          await this._propose(leader);
          await this._pause();
          continue;
        }
        if (st.phase === 'vote') {
          const pending = this.kernel.pendingVoters();
          if (!pending.length) continue;
          await this._vote(pending);
          await this._pause();
          continue;
        }
        if (st.phase === 'mission') {
          const actors = this.kernel.pendingMissionActors();
          if (!actors.length) continue;
          await this._mission(actors);
          await this._pause();
          continue;
        }
        if (st.phase === 'assassinate') {
          await this._assassinate();
          await this._pause();
          continue;
        }
        throw new Error(`runner 停在了意外阶段:${st.phase}`);
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

  _emitEnd() {
    if (this._ended) return;
    this._ended = true;
    const st = this.kernel.state;
    this._emit('end', {
      winner: st.winner, reason: st.endReason,
      round: st.round, successes: st.successes, fails: st.fails,
      assassinTarget: st.assassinTarget,
    });
  }

  /** 广播账本里**新出现的**那几条关键事件(票型/任务结果/强制上车) */
  _drainLedger() {
    const st = this.kernel.state;
    const fresh = st.events.slice(this._seenEvents);
    this._seenEvents = st.events.length;
    for (const e of fresh) {
      if (e.kind === 'votes') {
        this._emit('votes', {
          round: e.round, proposalNo: e.proposalNo,
          yes: e.yes, no: e.no, passed: e.passed,
          votes: (e.votes || []).map((v) => ({ seat: v.seat, approve: v.approve, reason: v.reason })),
        });
      } else if (e.kind === 'rejected') {
        this._emit('rejected', { round: e.round, leader: e.leader, proposalNo: e.proposalNo });
      } else if (e.kind === 'forced') {
        this._emit('forced', { round: e.round, team: (e.team || []).slice() });
      } else if (e.kind === 'missionStart') {
        this._emit('missionStart', {
          round: e.round, team: (e.team || []).slice(), failNeed: this.kernel.failNeed(),
        });
      } else if (e.kind === 'quest') {
        this._emit('quest', {
          round: e.round, team: (e.team || []).slice(), size: e.size,
          failNeed: e.failNeed, fails: e.fails, result: e.result,
          successes: e.successes, failsTotal: e.failsTotal,
        });
      } else if (e.kind === 'assassinateStart') {
        this._emit('assassinateStart', { round: e.round });
      } else if (e.kind === 'round') {
        this._emit('round', {
          round: this.kernel.state.round,
          teamSize: this.kernel.teamSize(),
          failNeed: this.kernel.failNeed(),
          leader: this.kernel.state.leader,
        });
      }
    }
  }

  /* ------------------------------------------------------------ 组队 */

  async _propose(seat) {
    const view = buildView(this.kernel.state, seat);
    const round = this.kernel.state.round;
    this._emit('leader', { seat, round, proposalNo: this.kernel.state.proposalNo });
    this.hooks.onThinking?.(seat, '', true);
    let res;
    try {
      if (this.human && seat === this.human.seat && typeof this.human.proposeTeam === 'function') {
        res = await this.human.proposeTeam(view);
      } else {
        const agent = this.agents.get(seat);
        if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
        res = await agent.proposeTeam(view, { signal: this.signal });
      }
    } finally {
      this.hooks.onThinking?.(null, '', false);
    }
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);

    // 最终一道合法性校验(agent 里已经判过一次,玩家输入也要过这里):
    // 队伍非法一律换成**确定性队伍**,不随机补人 ——「随机兜底毁一致性」是明确的坑。
    let team = Array.isArray(res?.team) ? res.team : [];
    const size = this.kernel.teamSize();
    const legal = team.length === size
      && team.every((t) => Number.isInteger(t) && t >= 0 && t < this.kernel.state.alive.length)
      && new Set(team).size === size;
    if (!legal) {
      this._emit('teamInvalid', { seat, team: team.slice(), want: size });
      const others = view.seats.map((s) => s.seat).filter((s) => s !== seat).sort((a, b) => a - b);
      team = others.concat([seat]).slice(0, size).sort((a, b) => a - b);
    }
    let say = Array.isArray(res?.say) ? res.say.filter(Boolean) : [res?.say].filter(Boolean);
    if (!say.length) {
      // 队长必须说点什么:空着会让「他为什么带这几个人」完全无迹可寻,
      // 而这是后面几轮唯一的推理材料。
      say = fallbackSay(seat, round);
    }
    this.kernel.proposeTeam(seat, team, say);
    this._emit('proposal', {
      seat, round, proposalNo: this.kernel.state.proposalNo,
      team: team.slice(), say: say.slice(),
      thinking: res?.thinking || '',
      source: res?.source || 'llm',
      quality: res?.quality === 'low' ? 'low' : 'ok',
      filtered: res?.filtered || null,
    });
    this._drainLedger();
  }

  /* ------------------------------------------------------------ 投票 */

  /** 全体投票:**并行**问、**一起**记(标准玩法是同时亮票) */
  async _vote(voters) {
    const st = this.kernel.state;
    const round = st.round;
    this._emit('voteStart', { round, proposalNo: st.proposalNo, team: st.team.slice() });
    for (const seat of voters) this.hooks.onThinking?.(seat, '', true);

    const results = await Promise.all(voters.map(async (seat) => {
      const view = buildView(this.kernel.state, seat);
      try {
        if (this.human && seat === this.human.seat && typeof this.human.vote === 'function') {
          const res = await this.human.vote(view);
          return { seat, res: res || { approve: false } };
        }
        const agent = this.agents.get(seat);
        if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
        const res = await agent.vote(view, { signal: this.signal });
        return { seat, res: res || { approve: false } };
      } catch (err) {
        // 单个座位失败不该毁掉这一轮:降级成**反对**(与 agent 内的策略一致)
        return { seat, res: { approve: false }, error: err };
      }
    }));
    this.hooks.onThinking?.(null, '', false);
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);

    for (const { seat, res, error } of results) {
      if (error) this.hooks.onDebug?.(`[${seat + 1}号] 投票失败:${error?.message || error}`);
      // 记录顺序不影响结果(票是同时亮出的),但按座位号记能让账本可读
      try {
        this.kernel.recordVote(seat, !!res?.approve, String(res?.reason || ''));
      } catch (err) {
        this.hooks.onDebug?.(`[${seat + 1}号] 这一票记不进去:${err?.message || err}`);
      }
    }
    const bySeat = new Map(results.map((r) => [r.seat, r]));
    this._drainLedger();
    // 「每个人投票时的私密理由」只给调试用:界面在 **观看模式** 下把它当一条
    // 可选的旁白(见 ui/screen.js 的 voteThoughts 分支),玩家模式下不读。
    this._emit('voteThoughts', {
      round,
      thoughts: results.map((r) => ({
        seat: r.seat, thinking: bySeat.get(r.seat)?.res?.thinking || '',
        source: r.res?.source || 'llm',
      })),
    });  }

  /* ------------------------------------------------------------ 任务 */

  /** 车上的人**并行**投卡;记完只公布合计(kernel 的 quest 事件) */
  async _mission(actors) {
    const st = this.kernel.state;
    const round = st.round;
    for (const seat of actors) this.hooks.onThinking?.(seat, '', true);

    const results = await Promise.all(actors.map(async (seat) => {
      const view = buildView(this.kernel.state, seat);
      try {
        if (this.human && seat === this.human.seat && typeof this.human.playCard === 'function') {
          const res = await this.human.playCard(view);
          return { seat, res: res || { card: 'success' } };
        }
        const agent = this.agents.get(seat);
        if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
        const res = await agent.playCard(view, { signal: this.signal });
        return { seat, res: res || { card: 'success' } };
      } catch (err) {
        // 降级 = success(确定性):不随机、不送分
        return { seat, res: { card: 'success' }, error: err };
      }
    }));
    this.hooks.onThinking?.(null, '', false);
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);

    for (const { seat, res, error } of results) {
      if (error) this.hooks.onDebug?.(`[${seat + 1}号] 投卡失败:${error?.message || error}`);
      // 谁出了什么卡**只有上帝视角才写进事件**(玩家模式连字段都没有)
      if (this.revealSecrets) {
        this._emit('card', {
          round, seat,
          card: res?.card === 'fail' ? 'fail' : 'success',
          thinking: res?.thinking || '',
          source: res?.source || 'llm',
        });
      }
      try {
        this.kernel.playCard(seat, res?.card === 'fail' ? 'fail' : 'success');
      } catch (err) {
        // 「好人投失败」这类违规:用 success 重记一次,把这一步推进下去。
        // **不随机换卡**,也不吞掉 —— 事件里留一条 invalid 让人看得见。
        this._emit('cardInvalid', { round, seat, message: String(err?.message || err) });
        try { this.kernel.playCard(seat, 'success'); } catch { /* 兜到这儿说明状态真坏了 */ }
      }
    }
    this._drainLedger();
  }

  /* ------------------------------------------------------------ 刺杀 */

  async _assassinate() {
    const st = this.kernel.state;
    const seat = this.kernel.assassinSeat();
    if (seat === null) throw new Error('到了刺杀阶段却找不到刺客(角色构成有问题)');
    const view = buildView(st, seat);
    this.hooks.onThinking?.(seat, '', true);
    let res;
    try {
      if (this.human && seat === this.human.seat && typeof this.human.assassinate === 'function') {
        res = await this.human.assassinate(view);
      } else {
        const agent = this.agents.get(seat);
        if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
        res = await agent.assassinate(view, { signal: this.signal });
      }
    } finally {
      this.hooks.onThinking?.(null, '', false);
    }
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);

    // 最终一道合法性校验:必须是一个别的座位(刺杀不能空着,也不能刺自己)
    let target = res?.target ?? null;
    const pool = view.seats.map((s) => s.seat).filter((s) => s !== seat);
    if (!Number.isInteger(target) || !pool.includes(target)) {
      this._emit('assassinateInvalid', { seat, target });
      // 确定性兜底:座位号最小的别人(与 agent 内的降级同一条)
      target = pool.length ? pool.slice().sort((a, b) => a - b)[0] : null;
    }
    if (target === null) throw new Error('刺杀阶段没有可刺的人');
    this.kernel.recordAssassination(seat, target);
    // 刺杀结果**是公开的**(桌上所有人都看到谁被刺了、是不是梅林),
    // 但「刺客是谁」要到结算横幅/上帝视角才揭 —— 见 ui/screen.js 的说明。
    this._emit('assassinate', {
      target,
      hit: st.endReason === 'assassin-hit',
      thinking: res?.thinking || '',
      source: res?.source || 'llm',
    });
    this._drainLedger();
    this._emitEnd();
  }
}

export { sleep };
