/**
 * 回合之间的「闸门」—— **自动推进 + 可暂停/单步**,三个回合制游戏共用一份。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么需要它
 *
 * 卧底 / 狼人杀 / 阿瓦隆都是**回合制**的:一轮(描述+投票 / 一夜+一天 / 一次任务)
 * 走完之后,下一次「该谁行动」由内核状态机自己决定,runner 的 for(;;) 会继续问下去。
 * 也就是说「一回合结束 → 下一回合开始」在逻辑上本来是**自动**的。真正缺的是两件事:
 *
 *   ① **观众看不到边界**。上一轮的票刚结算完,下一轮的描述就接上了,屏幕上只是
 *      轮次标签从 2 跳成 3 —— 看起来像「卡住了然后突然变了」。所以这层要留一段
 *      短暂停顿(默认 1.4s),并把「第 2 轮结束 → 第 3 轮开始」明确广播出去。
 *   ② **节奏不可控**。观看模式下 6 个人一轮打个几十秒,想停下来看看面板/想一想
 *      只能干瞪眼。所以这里再给一个「暂停 / 下一回合」的开关。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么闸门放在 runner 侧**(不放在内核/UI)**
 *
 *   · 内核只管规则,它不知道「观众要看的节奏」;给内核加 setTimeout 会把纯函数
 *     变成有副作用的东西,balance 模拟器和 277 条内核断言全得跟着改;
 *   · 放在 UI 侧则要 UI 去 push runner —— runner 的 for(;;) 正在 await 一个模型调用,
 *     UI 根本插不进去。唯一能「停在回合边界」的地方就是 runner 自己。
 *
 * ────────────────────────────────────────────────────────────────
 * ⚠️ 三个必须钉住的语义(都有测试盯着,见 tools/roundflowtest.mjs)
 *
 *   1. **幂等**:连续调两次 step() 只放行**一次**。第二下在没人等待时是空操作,
 *      绝不「攒」一次 —— 攒了就会在下一个边界直接跳过去一轮,而这正是
 *      「连点两下跳过了一轮」这类 bug 的来源。
 *   2. **暂停不能卡死对局**:stop()/abort/clear() 都必须把挂着的等待**立刻放掉**
 *      (抛 CANCEL_MESSAGE 或返回 'closed'),不然退出本局会挂在这里。
 *   3. **默认不停**:没传 holdMs 时 waitBoundary 立即返回(纯 Node 测试里
 *      一条 await 都不多),行为与加这个类之前完全一致。
 */

import { CANCEL_MESSAGE } from './llmCaller.mjs';

/** 默认停顿:1.4s。研究文档的「结果要让观众看清」区间是 1.2~2s,取中间偏短 */
export const ROUND_HOLD_MS = 1400;

export class RoundGate {
  /**
   * @param {object} [opts]
   * @param {number} [opts.holdMs] 自动推进时在回合边界的停顿时长(0 = 不停,测试用)
   * @param {AbortSignal} [opts.signal] 退出本局 / 重开时把它放掉
   * @param {(state:{paused:boolean,waiting:boolean})=>void} [opts.onChange]
   *   状态变化回调(界面用它改按钮文案:暂停中且停在边界 → 「下一回合」)
   */
  constructor({ holdMs = 0, signal = null, onChange = null } = {}) {
    this.holdMs = Math.max(0, Number(holdMs) || 0);
    this.signal = signal || null;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    /** 用户按下了「暂停」:下一个回合边界开始挂住 */
    this.paused = false;
    /** 此刻正停在回合边界上(界面据此把按钮变成「⏭ 下一回合」) */
    this.waiting = false;
    this._closed = false;
    /** 挂起中的那一次等待:{resolve} —— 只有一份,天然幂等 */
    this._waiter = null;
  }

  /** 界面用:按钮该显示什么 */
  get state() { return { paused: this.paused, waiting: this.waiting }; }

  _fire() {
    try { this.onChange?.({ paused: this.paused, waiting: this.waiting }); } catch { /* 界面出错不影响对局 */ }
  }

  /**
   * 暂停。**不打断当前这一步**:正在问模型/等玩家输入的那一下照常走完,
   * 停在下一个回合边界上。这样「写了一半的描述」不会因为暂停而丢掉。
   */
  pause() {
    if (this._closed) return this;
    this.paused = true;
    this._fire();
    return this;
  }

  /** 继续(等价于「放行当前这一次 + 恢复自动推进」) */
  resume() {
    if (this._closed) return this;
    this.paused = false;
    this._release('resume');
    this._fire();
    return this;
  }

  /**
   * 放行**一次**回合边界。没有等待时是空操作(不攒次数)。
   * @returns {boolean} 这次调用是否真的放行了一个边界(界面可据此做「已继续」反馈)
   */
  step() {
    if (this._closed) return false;
    const released = this._release('step');
    if (released) {
      // 单步之后仍然保持暂停:下一步走完还会停在下一个边界
      this.paused = true;
      this._fire();
    }
    return released;
  }

  /** 拆除(退出本局 / 重开 / 换局):把挂着的等待立刻放掉,别让 runner 留在 await 里 */
  clear() {
    this._closed = true;
    this._release('closed');
    this._fire();
  }

  /** 退出后重新用同一个闸门(重开一局时屏幕会复用自己) */
  reset({ holdMs = this.holdMs, signal = null } = {}) {
    this.holdMs = Math.max(0, Number(holdMs) || 0);
    this.signal = signal || null;
    this._closed = false;
    this.paused = false;
    this.waiting = false;
    this._waiter = null;
    this._fire();
    return this;
  }

  /**
   * 在回合边界上等一等。runner 在「轮次已经 +1,但还没开始问下一个人」时调它。
   * @param {{round?:number, next?:number, label?:string}} [info] 只用于调试/日志
   * @returns {Promise<'auto'|'step'|'resume'|'closed'>} 为什么继续往下走
   */
  async waitBoundary(info = {}) {
    if (this._closed) return 'closed';
    if (this.signal?.aborted) throw new Error(CANCEL_MESSAGE);
    if (!this.paused) {
      if (this.holdMs > 0) await this._sleep(this.holdMs);
      return 'auto';
    }
    this.waiting = true;
    this._fire();
    const why = await new Promise((resolve, reject) => {
      const onAbort = () => {
        this._waiter = null;
        this.waiting = false;
        this._fire();
        reject(new Error(CANCEL_MESSAGE));
      };
      this._waiter = {
        resolve: (reason) => {
          this._waiter = null;
          this.waiting = false;
          this.signal?.removeEventListener('abort', onAbort);
          this._fire();
          resolve(reason);
        },
      };
      this.signal?.addEventListener('abort', onAbort, { once: true });
    });
    void info;
    return why;
  }

  /** 放掉挂着的等待(没有就返回 false)—— step/resume/clear 共用这一条路 */
  _release(reason) {
    const w = this._waiter;
    if (!w) return false;
    this._waiter = null;
    this.waiting = false;
    w.resolve(reason);
    return true;
  }

  /** 可被 abort 打断的等待(与三个 runner 里的 sleep 同一个约定,不引第二套) */
  _sleep(ms) {
    return new Promise((resolve, reject) => {
      const signal = this.signal;
      if (signal?.aborted) { reject(new Error(CANCEL_MESSAGE)); return; }
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
      const onAbort = () => { cleanup(); reject(new Error(CANCEL_MESSAGE)); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** 建一个闸门(工厂,与其它模块的 createXxx 风格一致) */
export function createRoundGate(opts) {
  return new RoundGate(opts);
}
