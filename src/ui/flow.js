/**
 * 节奏控制器:决定「什么时候轮到下一个 AI 行动」。
 *
 * 三种模式:
 *   manual —— 每看完一个 AI 的思考,要点「下一位」才继续(思考气泡一直留着)
 *   manualNext —— 同上,另外一手结束后自动发下一手(需 ui.autoNextHand,现在默认关)
 *   auto   —— 全自动,气泡至少停留 minBubbleMs 毫秒(默认 5 秒)再继续
 *
 * 这样「看清他说了什么」和「放手让它自己打」两种需求都能满足。
 */

export const MODES = ['manual', 'manualNext', 'auto'];

export const MODE_INFO = {
  manual: { label: '手动', icon: '👆', hint: '点「下一位」继续' },
  manualNext: { label: '手动+连打', icon: '👆🔁', hint: '点「下一位」继续,一手结束后自动发牌' },
  auto: { label: '自动', icon: '▶️', hint: '自动进行,气泡至少停留 5 秒' },
};

export class FlowController {
  constructor(opts = {}) {
    this.mode = opts.mode || 'manual';
    this.thinkDelayMs = opts.thinkDelayMs ?? 500;
    this.bubbleDelayMs = opts.bubbleDelayMs ?? 1200;   // 手动模式下读完再点
    this.minBubbleMs = opts.minBubbleMs ?? 5000;       // 自动模式下气泡最短停留
    /**
     * 手动模式等「下一位」的上限。
     *
     * **默认 0 = 不超时,一直等**,因为「手动」的语义就是「我不点它就不动」。
     * 早先这里默认 60000:结果你想在某一手多想一会儿,一分钟后它自己就往下走了 ——
     * 看起来就像「明明选了手动却还是自动下一位」。
     *
     * 那个兜底当初是为了防「按钮被隐藏导致永久挂住」,但那是**别的 bug**
     * (玩家模式曾把「下一位」藏起来)。用「一分钟后自动继续」去兜,
     * 代价是把这个模式的核心语义破坏掉了。现在改成:按钮该在就在,
     * 不在了就去修按钮,而不是让手动模式自己变自动。
     *
     * 需要旧行为的话传一个毫秒数即可。
     */
    this.manualTimeoutMs = opts.manualTimeoutMs ?? 0;
    this.speed = opts.speed ?? 1;
    this.onWaitChange = opts.onWaitChange || (() => {});
    this.onModeChange = opts.onModeChange || (() => {});
    this._resolver = null;
    this._aborted = false;
  }

  get isAuto() { return this.mode === 'auto'; }
  get waiting() { return !!this._resolver; }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.mode = mode;
    this.onModeChange(mode);
    this.advance();     // 切到自动时,立刻放行正在等待的那一步
  }

  cycleMode() {
    const i = MODES.indexOf(this.mode);
    this.setMode(MODES[(i + 1) % MODES.length]);
    return this.mode;
  }

  setSpeed(mult) {
    this.speed = Math.max(0.25, Math.min(4, mult));
    this.advance();
  }

  /** 放行当前等待(按钮点击 / 切模式 / 变速时调用) */
  advance() {
    if (this._resolver) {
      const r = this._resolver;
      this._resolver = null;
      this.onWaitChange(false);
      r();
    }
  }

  /** 牌局重开:把等待解开,并让后续的等待直接返回 */
  abort() {
    this._aborted = true;
    this.advance();
  }

  reset() {
    this._aborted = false;
    this.advance();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(0, ms));
      if (this._aborted) { clearTimeout(t); resolve(); }
    });
  }

  /**
   * 等一个 AI 思考完并展示后,再决定是否放行下一步。
   * @param {number} dwellMs 气泡已经/需要展示的时长
   */
  async waitAfterThink(dwellMs = 0) {
    if (this._aborted) return;
    if (this.mode === 'auto') {
      // 自动模式:保证气泡至少完整展示 minBubbleMs
      const remain = Math.max(0, this.minBubbleMs - dwellMs);
      await this._sleep(remain / this.speed);
      return;
    }
    // 手动模式:一直等,直到有人点「下一位」。
    // 注意:**默认没有超时** —— 「手动」的语义就是「我不点它就不动」。
    // 只有在明确传了 manualTimeoutMs > 0 时才会兜底放行(见构造函数注释)。
    if (this._aborted) return;
    await new Promise((resolve) => {
      this._resolver = resolve;
      this.onWaitChange(true);
      const limit = Number(this.manualTimeoutMs) || 0;
      if (limit > 0) {
        // 只有显式配置了超时才会走到这里。兜底放行时留一条痕迹,
        // 免得以后有人看到「自己走了」却查不出原因(这个坑踩过)。
        this._guard = setTimeout(() => {
          if (this._resolver === resolve) {
            console.warn(`[flow] 手动模式等待超过 ${limit}ms,按兜底配置自动放行`);
            this._resolver = null;
            this.onWaitChange(false);
            resolve();
          }
        }, limit);
      } else {
        this._guard = null;
      }
    });
    clearTimeout(this._guard);
    this._guard = null;
    this._resolver = null;
    this.onWaitChange(false);
  }

  /** 下一次行动之前的停顿(让人看清是谁在动) */
  async pauseBeforeAct() {
    if (this._aborted) return;
    await this._sleep((this.thinkDelayMs + Math.random() * 120) / this.speed);
  }

  /** 一手结束后的停顿(自动连打时用) */
  async pauseBetweenHands() {
    await this._sleep(1600 / this.speed);
  }

  /** 给界面用的状态快照 */
  snapshot() {
    return {
      mode: this.mode,
      waiting: this.waiting,
      minBubbleMs: this.minBubbleMs,
      speed: this.speed,
      ...MODE_INFO[this.mode],
    };
  }
}
