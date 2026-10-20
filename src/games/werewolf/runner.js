/**
 * 一局「狼人杀」的流程驱动 —— 夜里并行问、白天串行说、逐个投票、判胜负。
 *
 * 为什么它单独一层(而不是塞进 ui/screen.js):
 *   · 屏幕要处理 3D、DOM、按钮、玩家输入,已经很重了;流程本身是纯逻辑 + 回调,
 *     放一起会让「一局怎么走」淹没在渲染代码里;
 *   · 测试(纯 Node)要能**不开浏览器**跑完一整局:给它 kernel + 假 agent + 事件
 *     回调即可,不碰 DOM(见 tools/werewolftest.mjs 的完整对局用例);
 *   · 无头平衡模拟器(tools/werewolfbalance.mjs)更是需要一个「不调 LLM 也能跑」
 *     的驱动 —— 它把 agents 换成本地 bot,流程一行都不用改。
 *
 * 与 kernel 的分工:kernel 判「这一刀/这一票合不合法、谁出局、谁赢」;
 * runner 只负责**按顺序去问、按顺序记、在中间做停顿与广播**。它自己不做任何判定 ——
 * 所以规则只有一份,runner 里没有第二套。
 *
 * ⚠️ 两条节奏上的讲究(研究文档「5. 发言长度与节奏」)
 *   · 夜里三个角色**并行**请求(互不依赖),白天发言**串行**(后者要听前者);
 *   · 投票串行、按座位顺序揭晓 —— 保留「谁先投」的戏剧性,也让画面好读。
 *
 * ⚠️ 回合推进(一天 = 一夜 + 一个白天 + 一次放逐)的三条硬规矩
 *   1. 天数只有内核会改(_settleVote 里 day += 1 + _startNight);runner 只观察,
 *      发现天数变了就广播「第 N 天结束」→ 过闸门 → 广播「第 N+1 天开始」。
 *   2. 一次结算只推进一天:游标是 `_lastDay`,单调递增,重放/异常都不会跳两天。
 *   3. 任何一步问不出来都不许把对局停死:发言降级成中性句、投票降级成弃票、
 *      夜里降级成 none,状态坏到没有下一步就 kernel.repairTurn() 修一次。
 *      (用户实测的「一回合结束后画面完全不动」就是这条路走死了。)
 */

import { buildView } from './view.js';
import { fallbackSpeech } from './prompts.js';
import { CANCEL_MESSAGE } from '../../shared/llmCaller.mjs';
import { RoundGate } from '../../shared/roundGate.mjs';

/** 这次错误是不是「本局被取消/退出」—— 那种错误要原样往上抛,不能当普通失败吞掉 */
function isCancel(err, signal) {
  return !!signal?.aborted || err?.message === CANCEL_MESSAGE || !!err?.canceled;
}

/** 中文回合名:狼人杀里一轮 = 一天(夜 + 白天) */
export function roundLabel(n) {
  return `第 ${n} 天`;
}

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

/** 夜间三步的中文名(事件与界面共用一份) */
export const NIGHT_STEP_LABEL = { wolves: '狼人', seer: '预言家', witch: '女巫', done: '结束' };

export class WerewolfRunner {
  /**
   * @param {object} opts
   * @param {object} opts.kernel 规则内核
   * @param {Map<number,object>} opts.agents 座位 → WerewolfAgent(**不含玩家自己的座位**)
   * @param {{seat:number, speak:(view)=>Promise<object>, vote:(view)=>Promise<object>,
   *          nightAct?:(view,step)=>Promise<object>}|null} opts.human
   *   玩家模式下的「我」。玩家座位不建 agent,由界面提供这几件事。
   * @param {object} opts.hooks 事件回调(onEvent / onThinking / names)
   * @param {number} [opts.delayMs] 每次发言/投票之间的停顿(观感用,不影响逻辑)
   * @param {boolean} [opts.revealSecrets] 是否允许把**私有**夜间行动写进事件
   *   (上帝视角 true;玩家模式 false —— 这是「渲染前就不取」在事件层的落点:
   *    false 时事件里根本没有目标座位这个字段,屏幕不可能画出来)
   * @param {(()=>({rounds:number,ranking:Array<{seat:number,name:string,score:number}>}))|null} [opts.matchStandings]
   *   本场积分榜的公开快照(屏幕提供)。传给 buildView → 提示词里的【你的最终目标】。
   *   返回函数而不是数组,是因为**每一局都会变**:开局时取一次会一直念旧排名。
   * @param {RoundGate} [opts.roundGate] 回合(天)之间的闸门:自动停顿 + 暂停/单步。
   *   不传就建一个 holdMs:0 的 —— 纯 Node 测试与平衡模拟器的行为与以前完全一致。
   * @param {AbortSignal} [opts.signal]
   */
  constructor({
    kernel, agents = new Map(), human = null, hooks = {},
    delayMs = 0, revealSecrets = false, signal = null, matchStandings = null,
    roundGate = null,
  } = {}) {
    if (!kernel) throw new Error('WerewolfRunner 需要 kernel');
    this.kernel = kernel;
    this.agents = agents;
    this.human = human;
    this.hooks = hooks;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.revealSecrets = !!revealSecrets;
    this.signal = signal || null;
    this.matchStandings = typeof matchStandings === 'function' ? matchStandings : null;
    this.roundGate = roundGate instanceof RoundGate
      ? roundGate
      : new RoundGate({ holdMs: 0, signal: this.signal });
    this.running = false;
    this._stopped = false;
    this._ended = false;
    this._lastDay = kernel.state.day;
  }

  get state() { return this.kernel.state; }

  /**
   * 建某个座位的视角,并挂上**本场积分榜**(公开信息)。
   *
   * 为什么由 runner 挂、而不是 view.js 自己去取:view.js 只认识内核 state,
   * 积分榜在屏幕手里(它是纯内存的 MatchStandings)。runner 是两者之间那层,
   * 由它把「公开快照」交给 view —— 每次取最新的一版(每一局都会变)。
   * 还没打完一局时给 null,提示词里就只说目标、不报排名(见 matchGoalBlock)。
   */
  _viewFor(seat) {
    return buildView(this.kernel.state, seat, {
      matchStandings: this.matchStandings ? this.matchStandings() : null,
    });
  }

  /** 只发一次的事件(避免 ui 重复塞日志) */
  _emit(type, payload = {}) {
    try { this.hooks.onEvent?.({ type, ...payload }); } catch { /* 界面出错不影响对局 */ }
  }

  /**
   * 跑(或**接着跑**)这一局。
   *
   * 「接着跑」是快照恢复的关键:恢复出来的 state 可能停在夜里第二步、发言中间、
   * 或投票中间(有人已经投过了),这里一律从 kernel 的当前状态继续,
   * 不假设「一定从头开始」。所以恢复流程不需要第二套「重建到第几步」的代码。
   *
   * ⚠️ for(;;) 里**没有一条 `continue` 是空转**:每个分支要么 await 一次真正的
   *    调用/停顿,要么先 repairTurn() 把状态推进一步,两者都不成立就抛错。
   *    (以前 `if (seat === null) continue;` / `if (!pending.length) continue;`
   *     在坏状态下是死转 —— 主线程被吃满,表现就是「画面完全不动」。)
   */
  async run() {
    if (this.running) return;
    this.running = true;
    this._stopped = false;
    this._ended = false;
    try {
      if (this.kernel.state.phase === 'idle') {
        this.kernel.start(this.hooks.names || []);
        this._lastDay = this.kernel.state.day;
        this._emit('start', {
          day: this.kernel.state.day,
          seats: this.kernel.state.config.seats,
          roster: { ...this.kernel.state.roster },
        });
      }
      // 恢复出来的局面可能停在「夜里最后一步刚记完」/「发言轮空了」/「票满了」
      this._repair('开局');
      let steps = 0;
      for (;;) {
        if (this._shouldStop()) return;
        if (steps++ > this._stepBudget()) {
          throw new Error('狼人杀的对局没有推进(天数上限与步数上限都过了还没终局)');
        }
        const st = this.kernel.state;
        if (st.phase === 'end') {
          this._emitEnd();
          return;
        }
        if (st.phase === 'night') {
          await this._nightLoop();
          continue;
        }
        if (st.phase === 'day') {
          const seat = this.kernel.currentSpeaker();
          if (seat === null) {
            // 发言轮却没有当前发言者 → 让内核直接进投票
            if (!this._repair('发言轮没有当前发言者')) throw new Error('发言轮没有当前发言者,内核也修不了');
            continue;
          }
          const dayBefore = st.day;
          await this._speak(seat);
          await this._afterStep(dayBefore);
          continue;
        }
        if (st.phase === 'vote') {
          const pending = this.kernel.pendingVoters();
          if (!pending.length) {
            // 票记满了却没有结算 → 让内核补一次结算(它会自己进下一夜 / 终局)
            if (!this._repair('投票轮票已记满')) throw new Error('投票轮没有待投的人,内核也修不了');
            continue;
          }
          const dayBefore = st.day;
          await this._vote(pending[0]);
          await this._afterStep(dayBefore);
          continue;
        }
        // 走到这里说明存档/外部代码把状态写坏了 → 先修,修不了才抛
        if (!this._repair(`意外阶段 ${st.phase}`)) {
          throw new Error(`runner 停在了意外阶段:${st.phase}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * 一步走完之后:天数变了就先报边界、等闸门、再报新一天开始,最后才是常规停顿。
   * 顺序:`exile`(谁出局)→ `roundEnd`(第 N 天结束)→ 闸门 → `round` + `roundStart`。
   */
  async _afterStep(prevDay) {
    const st = this.kernel.state;
    if (st.phase !== 'end' && st.day !== prevDay) await this._roundBoundary(prevDay);
    await this._pause();
  }

  /** 回合(天)边界:广播「结束」→ 闸门 → 广播「开始」 */
  async _roundBoundary(prevDay) {
    const st = this.kernel.state;
    if (st.day === prevDay) return;
    const exiled = st.events.filter((e) => e.kind === 'exile' && e.day === prevDay).map((e) => e.seat);
    this._emit('roundEnd', {
      round: prevDay,
      next: st.day,
      label: roundLabel(prevDay),
      nextLabel: roundLabel(st.day),
      eliminated: exiled,
      alive: st.alive.filter(Boolean).length,
      tie: exiled.length === 0,
    });
    this._lastDay = st.day;
    await this.roundGate.waitBoundary({ round: st.day, label: roundLabel(st.day) });
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);
    this._emit('round', { round: st.day, label: roundLabel(st.day), day: st.day });
    this._emit('roundStart', { round: st.day, label: roundLabel(st.day), phase: st.phase });
  }

  /** 步数预算:正常一局是 天数 × (夜 3 步 + 发言 N + 投票 N),给足余量后必须停下 */
  _stepBudget() {
    const st = this.kernel.state;
    const seats = st.config?.seats || st.alive.length || 6;
    const days = st.config?.maxDays || 6;
    return Math.max(200, seats * (days + 1) * 6);
  }

  /** 状态自相矛盾时做一次确定性修复;修不了返回 false(由调用方抛错) */
  _repair(why) {
    const fixed = this.kernel.repairTurn?.();
    if (!fixed) return false;
    this._emit('repair', { why, fix: fixed, day: this.kernel.state.day, phase: this.kernel.state.phase });
    return true;
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
    this._emit('end', { winner: st.winner, reason: st.endReason, day: st.day });
  }

  /* ------------------------------------------------------------ 夜晚 */

  /**
   * 把「狼 → 预 → 女」三步走完,然后天亮。
   * 每一步:取该行动的座位 → **并行**问 → 逐个记(非法的用 none 兜住,绝不让某一步卡住)。
   */
  async _nightLoop() {
    const st = this.kernel.state;
    this._emit('night', { day: st.day });
    let guard = 0;
    while (this.kernel.state.phase === 'night' && this.kernel.nightStep() !== 'done') {
      if (this._shouldStop()) return;
      if (guard++ > 12) throw new Error('夜间步骤没有推进(内核状态机出错)');
      const step = this.kernel.nightStep();
      const actors = this.kernel.pendingNightActors();
      if (!actors.length) {
        // 该角色已经出局 / 女巫两瓶药都用完 → 直接跳过这一步
        this._emit('nightSkip', { step, why: '没有可行动的角色' });
        this.kernel.skipNightStep();
        continue;
      }
      this._emit('nightStep', { step, actors: actors.slice(), label: NIGHT_STEP_LABEL[step] || step });
      for (const seat of actors) this.hooks.onThinking?.(seat, '', true);

      // ★ 并行:夜里三个角色互不依赖(研究文档「节奏控制」)
      const results = await Promise.all(actors.map(async (seat) => {
        const view = this._viewFor(seat);
        try {
          if (this.human && seat === this.human.seat && typeof this.human.nightAct === 'function') {
            const res = await this.human.nightAct(view, step);
            return { seat, res: res || { action: 'none', target: null } };
          }
          const agent = this.agents.get(seat);
          if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
          const res = await agent.nightAct(view, step, { signal: this.signal });
          return { seat, res: res || { action: 'none', target: null } };
        } catch (err) {
          // 单个座位失败不该毁掉整夜:降级成 none(kernel 仍会校验合法性)
          return { seat, res: { action: 'none', target: null }, error: err };
        }
      }));
      if (this._shouldStop()) return;

      for (const { seat, res, error } of results) {
        // 这一晚的行动**只有上帝视角才写进事件**(玩家模式连字段都没有)
        if (this.revealSecrets) {
          this._emit('nightAct', {
            step, seat,
            action: res?.action || 'none',
            target: res?.target ?? null,
            thinking: res?.thinking || '',
            source: res?.source || 'llm',
            error: error ? String(error?.message || error) : '',
          });
        }
        try {
          this.kernel.recordNightAction(seat, {
            action: res?.action || 'none',
            target: res?.target ?? null,
          });
        } catch (err) {
          // 模型给了一个「看起来合法但内核不认」的组合(例如救自己):
          // 用 none 再记一次,把这一步推进下去。**不随机换目标**。
          this._emit('nightInvalid', { step, seat, message: String(err?.message || err) });
          try { this.kernel.recordNightAction(seat, { action: 'none', target: null }); } catch { /* 兜到这儿说明状态真坏了 */ }
        }
      }
      // ⚠️ **每一步之间要停顿**。夜里三步(狼 → 预 → 女)是模型调用的空档,
      //    不喘一口气的话三个动作会叠在同一帧里,观众只看到「刷刷刷」;
    //    而研究文档明确要求「每人行动之间的停顿 0.6~1.2s,让观众看得清」。
      //    delayMs=0 的测试里这是个空操作,不影响对局逻辑。
      await this._pause();
    }
    if (this.kernel.state.phase !== 'night') return;
    const { deaths, peaceful } = this.kernel.dawn();
    this._emit('dawn', {
      day: this.kernel.state.day,
      deaths: deaths.slice(),
      peaceful,
      // ⚠️ 死讯只有「谁」,没有身份 —— 这是规则,不是裁剪
    });
    this.hooks.onThinking?.(null, '', false);
    if (this.kernel.state.phase === 'end') this._emitEnd();
    else this._emit('speechOrder', { day: this.kernel.state.day, order: this.kernel.state.order.slice() });
  }

  /* ------------------------------------------------------------ 发言 */

  async _speak(seat) {
    const view = this._viewFor(seat);
    this._emit('speaker', { seat, human: !!(this.human && seat === this.human.seat) });
    this.hooks.onThinking?.(seat, '', true);
    let res;
    try {
      if (this.human && seat === this.human.seat) {
        res = await this.human.speak(view);
      } else {
        const agent = this.agents.get(seat);
        if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
        res = await agent.speak(view, { signal: this.signal });
      }
    } catch (err) {
      // ★ 一次发言问不出来(超时/网络/解析)不能把整局停死,否则上一轮打完
      //   之后画面就再也不动了 —— 降级成确定性中性句,事件里留一条 stepError。
      if (isCancel(err, this.signal) || this._shouldStop()) throw err;
      this._emit('stepError', { seat, step: 'speak', message: String(err?.message || err) });
      res = { say: fallbackSpeech(seat, this.kernel.state.day), quality: 'low' };
    } finally {
      this.hooks.onThinking?.(null, '', false);
    }
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);
    // 最终一道防线:空发言用确定性中性句(绝不空着过 —— 少一个人发言等于少一条信息)
    let say = Array.isArray(res?.say) ? res.say.filter(Boolean) : [res?.say].filter(Boolean);
    if (!say.length) {
      say = fallbackSpeech(seat, this.kernel.state.day);
      res = { ...res, quality: 'low' };
    }
    this.kernel.recordSpeech(seat, say, { quality: res?.quality, stake: res?.stake ?? null });
    this._emit('speech', {
      seat, say, stake: res?.stake ?? null,
      thinking: res?.thinking || '',
      source: res?.source || 'llm',
      quality: res?.quality === 'low' ? 'low' : 'ok',
      filtered: res?.filtered || null,
    });
  }

  /* ------------------------------------------------------------ 投票 */

  async _vote(seat) {
    const view = this._viewFor(seat);
    this._emit('voteStart', { seat });
    this.hooks.onThinking?.(seat, '', true);
    let res;
    try {
      if (this.human && seat === this.human.seat) {
        res = await this.human.vote(view);
      } else {
        const agent = this.agents.get(seat);
        if (!agent) throw new Error(`${seat + 1} 号既不是玩家也没有 AI —— 这一局开不起来`);
        res = await agent.vote(view, { signal: this.signal });
      }
    } catch (err) {
      // 与发言同一条规矩:这一票问不出来就**弃票**(规则内合法的动作),
      // 不随机改投,也不让整局停在这一票上。
      if (isCancel(err, this.signal) || this._shouldStop()) throw err;
      this._emit('stepError', { seat, step: 'vote', message: String(err?.message || err) });
      res = { target: null, reason: '' };
    } finally {
      this.hooks.onThinking?.(null, '', false);
    }
    if (this._shouldStop()) throw new Error(CANCEL_MESSAGE);
    let target = res?.target ?? null;
    // 最终一道合法性校验(agent 里已经判过一次,玩家输入也要过这里):
    // 非法目标一律**弃票**,不随机改投 ——「随机兜底毁一致性」是研究文档明确的坑。
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
      from: seat, to: target,
      reason: String(res?.reason || ''),
      thinking: res?.thinking || '',
      source: res?.source || 'llm',
      consistency: res?.consistency || null,
    });
    // 票型结算可能已经发生(最后一票 → _settleVote 内部进了下一夜或 end)
    this._drainSettle();
    if (this.kernel.state.phase === 'end') this._emitEnd();
  }

  /**
   * 把账本里**新出现的**「放逐 / 平票」事件广播出去。
   *
   * 为什么扫账本而不是在 _vote 里直接判断:结算发生在 kernel.recordVote 内部
   * (最后一票时),而且「放逐」与「平票」是同一个函数的不同分支 ——
   * 在这里各写一次判断,迟早和内核那份漂移。账本是唯一真相源,读它就不会错。
   */
  _drainSettle() {
    const st = this.kernel.state;
    const fresh = st.events.slice(this._seenEvents || 0);
    this._seenEvents = st.events.length;
    for (const e of fresh) {
      if (e.kind === 'exile') {
        this._emit('exile', { day: e.day, seat: e.seat, votes: e.votes });
      } else if (e.kind === 'tie') {
        this._emit('tie', { day: e.day, text: e.text });
      }
    }
  }
}

export { sleep };
