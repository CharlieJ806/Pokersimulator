/**
 * 思考气泡(场景通用):「谁在想什么」那一块 DOM + 每帧的屏幕定位。
 *
 * 为什么它在 sceneCore 而不在某个游戏里:
 *   「一圈 AI 里现在是谁在想」是**所有**桌游都会有的东西 —— 狼人杀要说
 *   「3 号正在发言」,谁是卧底要显示描述者。差别只在文字,不在气泡本身。
 *   所以气泡的 DOM 结构、三种状态(思考中 / 说完之后接着显示动作 / 隐藏)、
 *   以及「跟着那个人头顶走、别被侧栏盖住」的定位逻辑都收在这里。
 *
 * ⚠️ 定位是**每帧**从人物的实际包围盒取的(见 Table3D#headAnchor),
 *    不能用建座位时缓存的锚点:座位重排(改人数 / 改窗口大小)之后缓存就失效了,
 *    气泡会跑到别人头上。
 *
 * 与游戏的分工:游戏只负责把 ctx 里的四个字段准备好
 *   thinkingSeat / revealThinking / thinkingText / thinkingLive(+ actionBubble),
 * 这里不判断信息隔离 —— 该不该给文字,由游戏层决定。
 */

/** 名字来自模型名(中转站里可以是任意字符串),拼进 innerHTML 前要转义 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 气泡的 HTML 片段。
 *
 * 为什么由这里提供字符串、而不是让游戏在自己的模板里手写一段:
 *   气泡的类名(.bubble--dots / --live / --anon / --action / --say)与样式表
 *   是一套约定,游戏自己抄一份迟早漏掉某个状态。游戏的屏幕模板把它插在
 *   `.hud` 里原来的位置即可(插在哪决定了层级,所以由游戏决定位置)。
 */
export function bubbleHtml() {
  return `
          <div class="hud__bubble bubble" id="bubbleEl" hidden>
            <span class="bubble__who"></span><span class="bubble__text"></span>
          </div>`;
}

export class ThinkingBubble {
  /**
   * @param {object} opts
   *   node    气泡元素(游戏的屏幕模板里那个 #bubbleEl)
   *   table   场景核心(要 headAnchor)
   *   anchorOf (seat)=>Vector3|null 备用锚点(座位重建前的旧锚点)
   *   rightLimit ()=>number 右边界(CSS 像素):侧栏展开时气泡要夹在它左边
   */
  constructor({ node, table, anchorOf, rightLimit } = {}) {
    this.node = node || null;
    this.table = table || null;
    this.anchorOf = anchorOf || (() => null);
    this.rightLimit = rightLimit || (() => Infinity);
    /** 当前气泡挂在哪个座位上(null = 不显示);定位逻辑读它 */
    this.seat = null;
  }

  get visible() {
    return !!(this.node && !this.node.hidden);
  }

  hide() {
    if (!this.node) return;
    this.seat = null;
    this.node.hidden = true;
    this.node.classList.remove('bubble--action');
  }

  /**
   * 同步气泡内容。
   *
   * 三种状态,优先级从高到低:
   *   1. 正在思考   → 「正在思考中…」(荷官模式给思考内容,玩家模式不给)
   *   2. 思考刚结束 → 原地接着显示「他做了什么」(ctx.actionBubble,有时效)
   *   3. 都没有     → 隐藏
   *
   * 为什么要有第 2 种:玩家模式看不到别人的思考,气泡一消失就只剩
   * 「刚才有人动了但不知道动了什么」,还得去翻日志。现在气泡会接着显示
   * 「跟注 20」这样的结果,看完自然消失 —— 不用盯着日志看。
   *
   * @param {object} ctx  { thinkingSeat, revealThinking, thinkingText, thinkingLive, actionBubble }
   * @param {Map} personaMap 座位 → 性格(取名字用)
   */
  update(ctx = {}, personaMap) {
    const bubble = this.node;
    if (!bubble) return;

    const canRevealText = ctx.revealThinking !== false;
    const actionBubble = ctx.actionBubble;
    if (ctx.thinkingSeat !== null && ctx.thinkingSeat !== undefined) {
      this.seat = ctx.thinkingSeat;
      const persona = personaMap?.get(ctx.thinkingSeat);
      bubble.hidden = false;
      bubble.classList.remove('bubble--action');
      bubble.classList.toggle('bubble--live', !!ctx.thinkingLive);
      bubble.classList.toggle('bubble--anon', !canRevealText);
      bubble.querySelector('.bubble__who').textContent = persona ? `${persona.name}: ` : '';
      const txt = bubble.querySelector('.bubble__text');
      const shown = canRevealText ? ctx.thinkingText : '';
      if (shown) {
        bubble.classList.remove('bubble--dots');
        txt.textContent = shown;
      } else {
        // 还没拿到可读文本(或玩家模式不给看内容)→ 显示带动画的「正在思考中…」
        bubble.classList.add('bubble--dots');
        txt.innerHTML = '<span class="dots"><i></i><i></i><i></i></span> 正在思考中…';
      }
    } else if (actionBubble && (actionBubble.text || actionBubble.say)) {
      // 思考收掉之后接着显示「他说了什么 / 他做了什么」。锚点仍挂在那个人头上
      // (定位逻辑读的是 this.seat,所以这里也把它指过去)。
      //
      // say 是模型**主动说出口**的牌桌发言(可真可诈),摆在主位、加引号;
      // 动作结果(「跟注 20」)退到下面一行小字当注脚 —— 这样读起来像
      // 「他说了句话,然后跟了 20」,而不是两个平级的信息堆在一起。
      this.seat = actionBubble.seat;
      const persona = personaMap?.get(actionBubble.seat);
      bubble.hidden = false;
      bubble.classList.remove('bubble--dots', 'bubble--live', 'bubble--anon');
      bubble.classList.add('bubble--action');
      bubble.classList.toggle('bubble--say', !!actionBubble.say);
      bubble.querySelector('.bubble__who').textContent = persona ? `${persona.name}: ` : '';
      const at = bubble.querySelector('.bubble__text');
      if (actionBubble.say) {
        at.innerHTML = `<span class="bubble__quote">「${esc(actionBubble.say)}」</span>`
          + (actionBubble.text ? `<span class="bubble__act">${esc(actionBubble.text)}</span>` : '');
      } else {
        at.textContent = actionBubble.text;
      }
    } else {
      this.hide();
    }
  }

  /**
   * 每帧定位。参数里的 camera / canvas 由调用方给(场景核心的渲染循环)。
   * @param {object} camera
   * @param {HTMLCanvasElement} canvas
   * @param {{x:number,y:number}} tmp 复用的向量(避免每帧 new)
   */
  layout(camera, canvas, tmp) {
    if (!this.visible || this.seat === null) return;
    if (!camera || !canvas || !tmp) return;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;

    const anchor = this.table?.headAnchor?.(this.seat) || this.anchorOf(this.seat);
    if (!anchor) return;
    tmp.copy(anchor).project(camera);
    let x = (tmp.x * 0.5 + 0.5) * w;
    const y = (-tmp.y * 0.5 + 0.5) * h;
    const bw = this.node.offsetWidth || 220;
    // 侧栏开着时右边那块被它盖住:最右侧座位的气泡要夹在侧栏左边,
    // 否则只露出一个字(实测宽屏 6 人桌最右那位就是这样)。
    // 「侧栏在不在、占多宽」由游戏侧的 rightLimit() 回答,这里只做夹取。
    let right = w;
    const limit = this.rightLimit();
    if (Number.isFinite(limit)) right = Math.min(right, limit);
    x = Math.max(bw / 2 + 8, Math.min(right - bw / 2 - 8, x));
    const by = Math.max(80, y - 44);           // 再往上一点,别压住头顶的指示器
    this.node.style.transform =
      `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${by.toFixed(1)}px)`;
  }
}
