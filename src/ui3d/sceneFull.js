/**
 * 3D 场景总装:把 three.js 渲染循环、投影 HUD、日志面板、底部操作条接在一起。
 *
 * 对外提供的方法与旧的 2D 版 table.js 保持一致(updateTopbar / updateSeats / updateBoard …),
 * 这样 app.js 里的引擎与 AI 逻辑完全不用动。
 *
 * HUD 是 DOM 叠在 canvas 上的:每个座位的名牌每帧用 camera.project() 投影到屏幕坐标,
 * 所以文字始终清晰,而牌桌、人物、牌、筹码都是真 3D。
 *
 * ────────────────────────────────────────────────────────────
 * 这个文件里有**所有 HUD 的 DOM 结构**(一个大模板字符串),想加/删界面元素先看这里。
 * 想改什么:
 *   · 顶栏有哪些按钮       → 模板里的 <header class="topbar">
 *   · 侧栏(记录/思考)结构 → 模板里的 <aside class="sidepanel">
 *   · 手牌一览长什么样     → 模板里的 <section class="handstrip"> + renderHandStrip()
 *   · 公共牌那一行         → renderBoardRow()
 *   · 底池标签 / 思考气泡  → 模板里的 .hud 部分 + render() 里的气泡逻辑
 *   · 摊牌横幅             → showBanner()
 *   · 下注条的位置         → layoutPlayerBar()(⚠️ 位置是算出来的,不是 CSS 写死的)
 *   · 动画推进             → _loop() 里的 updateCardAnimations()
 * ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { createStage, addLights, addRoom } from './scene.js';
import { Table3D } from './table3d.js';
import { chipBreakdown, updateCardAnimations, clearCardAnimations } from './cards3d.js';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function fmt(n) {
  const v = Math.round(n || 0);
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(v);
}

export function chipStackDom(amount, small = false) {
  const wrap = el('div', 'chips' + (small ? ' chips--sm' : ''));
  wrap.title = `${amount} 筹码`;
  chipBreakdown(amount, 5).forEach((tier, i) => {
    const c = el('div', `chip chip--${tier.cls || 'white'}`);
    c.style.setProperty('--i', String(i));
    wrap.appendChild(c);
  });
  return wrap;
}

const LOG_ICON = {
  hand: '🎴', street: '🃏', fold: '✕', check: '✓', call: '◦', raise: '↑',
  win: '🏆', pot: '💰', showdown: '👁', level: '📈', bust: '💀', champion: '👑', info: '·',
};

export class SceneTable {
  constructor(root, hooks = {}) {
    this.hooks = hooks;
    this.root = root;
    this.thinkingText = '';
    this.thinkingSeat = null;
    this.thinkingLive = false;
    this.running = true;

    root.innerHTML = `
      <div class="screen screen--3d">
        <canvas id="gl"></canvas>
        <div class="grid-vignette"></div>

        <header class="topbar">
          <div class="topbar__left">
            <span class="brand">德州荷官</span>
            <span class="topbar__tag" id="handTag">第 0 手</span>
            <span class="topbar__tag" id="blindTag">盲注 10 / 20</span>
            <span class="topbar__tag" id="deckTag">52 张</span>
          </div>
          <div class="topbar__center"><span class="street" id="streetTag">等待开局</span></div>
          <div class="topbar__right">
            <button class="btn btn--ghost" id="btnPeek" title="切换底牌可见度:盖着 → 只看公共牌 → 全部翻开">🂠 底牌 <b>盖着</b></button>
            <button class="btn btn--ghost" id="btnThink" title="是否显示 AI 的思考气泡">💭 气泡 <b>开</b></button>
            <button class="btn btn--ghost" id="btnThinkLog" title="完整的思考记录">🧠 思考记录</button>
            <button class="btn btn--ghost" id="btnModels" title="给每个 AI 分配不同的模型">🤖 模型</button>
            <button class="btn btn--ghost" id="btnLog" title="牌局日志">📜 <span id="logBtnLabel">荷官记录</span></button>
            <button class="btn btn--ghost" id="btnSetup" title="牌局设置 / 退出本局">⚙ 设置</button>
          </div>
        </header>

        <div class="hud" id="hudEl">
          <!-- 头顶名牌已经去掉了:改用 3D 里的三角指示器(轮到谁谁高亮 + 大小盲标注)。
               每个人的名字/筹码/名次在看牌区「手牌一览」里,不挡画面。 -->
          <div class="hud__bubble bubble" id="bubbleEl" hidden>
            <span class="bubble__who"></span><span class="bubble__text"></span>
          </div>
          <div class="hud__pot" id="potEl" hidden>
            <span class="pot__label">底池</span><b id="potValue">0</b>
          </div>

          <!-- 手牌一览:3D 里牌小看不清,这里用清晰的正面牌列出来 -->
          <section class="handstrip" id="handStrip">
            <header class="handstrip__head">
              <span class="handstrip__title">手牌一览</span>
              <span class="handstrip__note" id="handStripNote"></span>
              <button class="btn btn--tiny" id="btnHandStrip" title="收起 / 展开">收起</button>
            </header>
            <!-- 公共牌单独来一份:桌面上是 3D 小模型,斜着看看不清牌面 -->
            <div class="handstrip__board" id="handStripBoard">
              <span class="handstrip__boardLabel">公共牌</span>
              <span class="handstrip__street" id="boardStreet">未开始</span>
              <!-- 一手结束后出现的「第 N 手记录」。
                   放在这里而不是操作条里:操作条上那几个块位置都是算出来的,
                   塞进去会互相压住(实测按钮盖在提示行上、文字还被截断)。
                   这个位置紧挨着「本手结束」,而且荷官/玩家两种模式都看得到。 -->
              <button class="btn btn--pill handstrip__review" id="btnReview" hidden>📋 第 1 手记录</button>
              <span class="handstrip__boardCards" id="boardCards"></span>
              <span class="handstrip__boardHint" id="boardHint"></span>
            </div>
            <div class="handstrip__body" id="handStripBody"></div>
          </section>
        </div>

        <aside class="sidepanel" id="sidePanel">
          <div class="sidepanel__tabs">
            <button class="tab is-active" data-panel="log" id="tabLog">荷官记录</button>
            <button class="tab" data-panel="think">思考记录</button>
            <button class="btn btn--tiny" id="btnClearLog">清空</button>
          </div>
          <div class="log" id="logEl"></div>
          <div class="thinklog" id="thinkLogEl" hidden></div>
          <div class="sidepanel__foot" id="statLine">—</div>
        </aside>

        <footer class="actionbar">
          <div class="actionbar__follow">
            <button class="btn btn--primary" id="btnNext" disabled>👉 下一位</button>
            <button class="btn btn--ghost" id="btnMode" title="手动 / 手动+连打 / 自动">👆 手动</button>
            <button class="btn btn--ghost" id="btnSpeed" title="节奏快慢">⏱ 1.0x</button>
          </div>
          <div class="actionbar__hint" id="hintEl"></div>
          <div class="actionbar__btns">
            <button class="btn btn--primary btn--big" id="btnDeal">🂠 发牌 / 下一手</button>
          </div>
        </footer>

        <div class="toast" id="toastEl"></div>
      </div>
    `;

    const q = (id) => root.querySelector('#' + id);
    this.canvas = q('gl');
    const stage = createStage(this.canvas);
    this.THREE = THREE;
    this.renderer = stage.renderer;
    this.scene = stage.scene;
    this.camera = stage.camera;
    const baseResize = stage.resize;
    this.resize = () => {
      baseResize();
      this.fitCamera();
      // 座位半径跟画面宽度有关(窄屏要往中间收),所以窗口变化时要重排一次
      if (this.plates.size) {
        this.table.buildSeats(this.plates.size);
        this.table.resync?.();
      }
    };

    addRoom(this.scene);
    addLights(this.scene);
    this.table = new Table3D(this.scene, { getPersona: (seat) => hooks.getPersona?.(seat) });

    this.dom = {
      topbar: root.querySelector('.topbar'),
      handTag: q('handTag'), blindTag: q('blindTag'), deckTag: q('deckTag'),
      street: q('streetTag'), statLine: q('statLine'),
      log: q('logEl'), thinkLog: q('thinkLogEl'),
      plates: q('platesEl'), bubble: q('bubbleEl'), pot: q('potEl'), potValue: q('potValue'),
      handStrip: q('handStrip'), handStripBody: q('handStripBody'),
      handStripNote: q('handStripNote'), btnHandStrip: q('btnHandStrip'),
      boardRow: q('handStripBoard'), boardCards: q('boardCards'),
      boardStreet: q('boardStreet'), boardHint: q('boardHint'), btnReview: q('btnReview'),
      hint: q('hintEl'), toast: q('toastEl'), sidePanel: q('sidePanel'),
      actionbar: root.querySelector('.actionbar'),
      btnDeal: q('btnDeal'), btnNext: q('btnNext'), btnMode: q('btnMode'), btnSpeed: q('btnSpeed'),
      btnPeek: q('btnPeek'), btnThink: q('btnThink'), btnThinkLog: q('btnThinkLog'),
      btnModels: q('btnModels'), btnLog: q('btnLog'), btnSetup: q('btnSetup'),
      logBtnLabel: q('logBtnLabel'), tabLog: q('tabLog'),
      btnClearLog: q('btnClearLog'),
      tabs: [...root.querySelectorAll('.tab')],
    };

    this.plates = new Map();     // seat -> {node, anchor}
    this._tmp = new THREE.Vector3();
    this._pending = null;        // 待渲染的 view/ctx
    this._clock = new THREE.Clock();

    for (const t of this.dom.tabs) {
      t.addEventListener('click', () => this.setPanel(t.dataset.panel));
    }

    // 手牌一览可以收起
    this.handStripOpen = true;
    this.dom.btnHandStrip.addEventListener('click', () => {
      this.handStripOpen = !this.handStripOpen;
      this.dom.handStrip.classList.toggle('is-collapsed', !this.handStripOpen);
      this.dom.btnHandStrip.textContent = this.handStripOpen ? '收起' : '展开';
    });

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /** 窄窗口时把相机往后拉一点,保证整张桌子都在画面里(名牌也不会挤在一起) */
  fitCamera() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const aspect = Math.max(0.6, w / Math.max(1, h));
    const ref = 1.56;                                  // 参考宽高比
    // 座位跟着人数外扩,相机也要相应后退,不然最外侧的人会被裁掉
    const seats = this.plates.size || 6;
    const spread = 0.9 + seats * 0.028;
    const k = Math.min(1.5, Math.max(1, Math.sqrt(ref / aspect))) * spread;
    this.camBaseY = 4.3 * k;
    this.camBaseZ = 8.4 * k;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /* ---------------- 渲染循环 ---------------- */

  _loop() {
    if (!this.running) return;
    const dt = this._clock.getDelta();
    const t = this._clock.elapsedTime;
    void dt;

    // 相机轻微呼吸感,让画面不像静止图片
    if (!this.camBaseY) this.fitCamera();
    if (!this._frozen) {
      this.camera.position.y = this.camBaseY + Math.sin(t * 0.5) * 0.03;
      this.camera.position.z = this.camBaseZ;
      this.camera.lookAt(0, 0.3, -1.0);
    }
    // 发牌 / 飞牌动画:每帧推进一次(内部自己清理已结束的,不会越积越多)
    updateCardAnimations(performance.now());
    this._projectPlates(Math.min(0.05, dt || 0.016));
    // 玩家模式:下注条的位置跟着底部两条的实际布局走
    if (this.mode === 'player') this.layoutPlayerBar();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._loop);
  }

  /**
   * 每帧的 HUD 定位。
   * 头顶名牌已经去掉了(改用 3D 三角指示器),这里只剩两件事:
   *   · 底池标签跟着底池位置走;
   *   · 思考气泡跟着说话那个座位的头顶走,并夹在可见范围内。
   */
  _projectPlates(dt = 0.016) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    void dt;

    // 底池标签
    if (this.dom.pot && !this.dom.pot.hidden) {
      this._tmp.set(0.82, 0.72, -0.48).project(this.camera);
      const x = (this._tmp.x * 0.5 + 0.5) * w;
      const y = (-this._tmp.y * 0.5 + 0.5) * h;
      this.dom.pot.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
    // 思考气泡:锚点**每帧**从人物的实际包围盒取,不能用建座位时的缓存 ——
    // 座位重排(改人数 / 改窗口大小)之后缓存就失效了,气泡会跑到别人头上。
    if (this.dom.bubble && !this.dom.bubble.hidden && this.thinkingSeat !== null) {
      const p = this.plates.get(this.thinkingSeat);
      const anchor = this.table.headAnchor(this.thinkingSeat) || p?.anchor;
      if (anchor) {
        this._tmp.copy(anchor).project(this.camera);
        let x = (this._tmp.x * 0.5 + 0.5) * w;
        const y = (-this._tmp.y * 0.5 + 0.5) * h;
        const bw = this.dom.bubble.offsetWidth || 220;
        x = Math.max(bw / 2 + 8, Math.min(w - bw / 2 - 8, x));
        const by = Math.max(80, y - 44);           // 再往上一点,别压住头顶的指示器
        this.dom.bubble.style.transform =
          `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${by.toFixed(1)}px)`;
      }
    }
  }


  /**
   * 手牌一览:3D 里的小牌看不清牌面,这里用清晰的正面牌再列一遍。
   * 显示规则跟 3D 场景完全一致(盖着 / 只看公共牌 / 全部翻开 + 摊牌自动亮牌)。
   * 头顶名牌去掉之后,名字/筹码/位置(大小盲、按钮位)也都在这里显示。
   */
  renderHandStrip(view, ctx) {
    const body = this.dom.handStripBody;
    const personaOf = (seat) => ctx.personaMap?.get(seat);
    let faceUpCount = 0;
    const parts = [];

    this.renderBoardRow(view);

    for (const p of view.players) {
      const persona = personaOf(p.seat);
      const isShowdown = view.handOver && !p.folded && p.inHand && ctx.showdownReveal;
      // 玩家模式:我自己那一行亮牌(自己的牌当然看得见),但弃牌之后也盖上 ——
      // 跟别家规则保持一致,不然「已弃牌还亮着牌」看着很奇怪。
      const isMe = ctx.humanSeat !== null && ctx.humanSeat !== undefined
        && p.seat === ctx.humanSeat && p.inHand && !p.folded;
      const faceUp = (isMe || ctx.revealAll || isShowdown) && p.hole?.some((c) => c !== null);
      const cards = (p.hole || []).filter((c) => c !== null);
      if (faceUp) faceUpCount += cards.length;

      const cardsHtml = faceUp && cards.length
        ? cards.map((c) => SceneTable.cardHtml(c)).join('')
        : '<span class="handrow__back"></span><span class="handrow__back"></span>';

      const state = !p.inHand ? 'out'
        : p.folded ? 'folded'
          : p.allIn ? 'allin'
            : view.actor === p.seat ? 'actor' : '';

      // 位置标签:只在「这一手还在牌局里」时显示(弃牌/淘汰的座位没有位置可言,
      // 否则会看到好几个 seat 都顶着 D)
      const pos = p.inHand ? (view.positions?.[p.seat] || '') : '';
      const posCls = pos === 'BTN' ? 'pos--btn' : pos === 'SB' ? 'pos--sb' : pos === 'BB' ? 'pos--bb' : '';
      const delta = ctx.deltas?.find((d) => d.seat === p.seat);
      const deltaTxt = delta && view.handOver
        ? `<span class="handrow__delta ${delta.delta > 0 ? 'is-up' : delta.delta < 0 ? 'is-down' : ''}">${delta.delta > 0 ? '+' : ''}${fmt(delta.delta)}</span>`
        : '';

      parts.push(`
        <div class="handrow handrow--${state}" data-seat="${p.seat}">
          <div class="handrow__who">
            <span class="plate__name">${persona?.name || p.name || `座位${p.seat + 1}`}</span>
            ${pos ? `<span class="posbadge ${posCls}">${pos === 'BTN' ? 'D' : pos}</span>` : ''}
          </div>
          <div class="handrow__cards">${cardsHtml}</div>
          <div class="handrow__meta">
            <span class="handrow__stack">${fmt(p.stack)}</span>
            ${deltaTxt}
            ${p.lastAction?.label && !view.handOver ? `<span class="handrow__act">${p.lastAction.label}</span>` : ''}
          </div>
        </div>`);
    }

    body.innerHTML = parts.join('');
    const total = view.players.filter((p) => p.inHand).length * 2;
    const inPlayerMode = ctx.humanSeat !== null && ctx.humanSeat !== undefined;
    // 说明性文字尽量少:能一眼看懂的就不写。
    // 荷官模式只留「亮了几张」这种确实有用的计数;玩家模式连计数都不用写。
    this.dom.handStripNote.textContent = inPlayerMode
      ? ''
      : ctx.revealAll
        ? `${faceUpCount}/${total} 张`
        : faceUpCount > 0
          ? `${faceUpCount}/${total} 张`
          : '';
  }

  /**
   * 公共牌单独渲染一行。
   * 桌面上的公共牌是 3D 小模型,坐着斜看容易看不清牌面,所以在这里再来一份正面牌。
   */
  renderBoardRow(view) {
    if (!this.dom.boardCards) return;
    const board = view.board || [];
    const streetText = view.handOver
      ? '本手结束'
      : (this.boardStreetText || view.streetLabel || '未开始');
    this.dom.boardStreet.textContent = streetText;
    const slots = [];
    for (let i = 0; i < 5; i++) {
      if (i < board.length) slots.push(SceneTable.cardHtml(board[i]).replace('minicard', 'boardcard'));
      else slots.push('<span class="boardcard boardcard--empty">·</span>');
    }
    this.dom.boardCards.innerHTML = slots.join('');
    // 空位本身已经说明了还差几张,不用再写一句
    this.dom.boardHint.textContent = '';
  }

  /**
   * 显示 / 隐藏「第 N 手记录」按钮。
   *
   * 这个按钮挂在手牌一览的公共牌行上(紧挨着「本手结束」那个标签),
   * 而不是操作条里 —— 操作条上的块位置都是按实际高度算出来的,
   * 硬塞一个进去会跟提示行重叠,而且窄屏下文字会被截断(实测踩过)。
   *
   * @param {boolean} on
   * @param {string} [label] 按钮文字,例如「📋 第 3 手记录」
   */
  setReviewEnabled(on, label) {
    const b = this.dom.btnReview;
    if (!b) return;
    b.hidden = !on;
    if (on && label) b.textContent = label;
  }

  /** 点「第 N 手记录」时通知外面(由 app.js 绑定到回顾面板) */
  onReviewClick(fn) {
    const b = this.dom.btnReview;
    if (!b) return;
    b.addEventListener('click', () => fn?.());
  }

  /** 一张牌的正面 HTML(点数 + 花色) */
  static cardHtml(id) {    if (id === null || id === undefined) return '<span class="handrow__back"></span>';
    const SUITS = ['♠', '♥', '♦', '♣'];
    const rank = ((id >> 2) + 2);
    const suit = id & 3;
    const label = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[rank] || String(rank);
    const red = suit === 1 || suit === 2;
    return `<span class="minicard${red ? ' minicard--red' : ''}">`
      + `<b>${label}</b><i>${SUITS[suit]}</i></span>`;
  }

  /** 名牌尺寸(现在只用于思考气泡的避让),节点可能不存在,统一做保护 */
  _measurePlates() {
    for (const p of this.plates.values()) {
      if (!p.node) continue;
      const r = p.node.getBoundingClientRect();
      if (r.width) { p.w = r.width; p.h = r.height; }
    }
  }

  destroy() {
    this.running = false;
    this.renderer.dispose();
  }

  /* ---------------- 座位与名牌 ---------------- */

  buildSeats(count) {
    this.table.buildSeats(count);
    // 头顶名牌已经去掉,这里只需要座位锚点(给思考气泡定位用)
    for (const p of this.plates.values()) p.node?.remove();
    this.plates.clear();
    // 用 3D 指示牌代替头顶名牌:这里只记座位锚点,供思考气泡定位
    const anchors = this.table.seatAnchors();
    for (let seat = 0; seat < count; seat++) {
      const r = {
        node: null,
        anchor: anchors.get(seat) || new THREE.Vector3(),
        x: undefined, y: undefined, w: 0, h: 0,
      };
      this.plates.set(seat, r);
    }
    this._lastView = null;
  }

  /** 重排之后再画一次当前状态(座位位置变了,名牌锚点也要跟着换) */
  resync() {
    if (!this._lastView) return;
    const anchors = this.table.seatAnchors();
    for (const [seat, p] of this.plates) {
      const a = anchors.get(seat);
      if (a) p.anchor = a;
    }
    this.updateSeats(this._lastView, this._lastCtx || {});
  }

  updateSeats(view, ctx) {
    this._lastView = view;
    this._lastCtx = ctx;
    if (this.plates.size !== view.players.length) this.buildSeats(view.players.length);
    // 座位与人数一致时,只做「同步」,不重建(重建会把中央的牌也清掉)
    this.table.syncSeats(view, ctx);

    // 头顶名牌已经去掉:名字/筹码/位置都在「手牌一览」与侧栏里,
    // 3D 场景里改用头顶三角指示器(轮到谁谁高亮 + 大小盲标注)。

    // 思考气泡
    // 玩家模式也会显示(让人知道 AI 在思考),但不显示思考内容 ——
    // revealThinking=false 时只给「正在思考…」的动画,不给文字。
    //
    // 三种状态,优先级从高到低:
    //   1. 正在思考   → 「正在思考中…」(荷官模式给思考内容,玩家模式不给)
    //   2. 思考刚结束 → 原地接着显示「他做了什么」(ctx.actionBubble,有时效)
    //   3. 都没有     → 隐藏
    //
    // 为什么要有第 2 种:玩家模式看不到别人的思考,气泡一消失就只剩
    // 「刚才有人动了但不知道动了什么」,还得去翻日志。现在气泡会接着显示
    // 「跟注 20」这样的结果,看完自然消失 —— 不用盯着日志看。
    const bubble = this.dom.bubble;
    const canRevealText = ctx.revealThinking !== false;
    const actionBubble = ctx.actionBubble;
    if (ctx.thinkingSeat !== null && ctx.thinkingSeat !== undefined) {
      this.thinkingSeat = ctx.thinkingSeat;
      const persona = ctx.personaMap?.get(ctx.thinkingSeat);
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
    } else if (actionBubble && actionBubble.text) {
      // 思考收掉之后接着显示「他做了什么」。锚点仍挂在那个人头上
      // (定位逻辑读的是 this.thinkingSeat,所以这里也把它指过去)。
      this.thinkingSeat = actionBubble.seat;
      const persona = ctx.personaMap?.get(actionBubble.seat);
      bubble.hidden = false;
      bubble.classList.remove('bubble--dots', 'bubble--live', 'bubble--anon');
      bubble.classList.add('bubble--action');
      bubble.querySelector('.bubble__who').textContent = persona ? `${persona.name}: ` : '';
      bubble.querySelector('.bubble__text').textContent = actionBubble.text;
    } else {
      this.thinkingSeat = null;
      bubble.hidden = true;
      bubble.classList.remove('bubble--action');
    }

    // 手牌一览跟着一起刷新
    this.renderHandStrip(view, ctx);
  }

  updateBoard() { /* 公共牌在 3D 里由 Table3D.update 处理 */ }
  updateBurn() { /* 同上 */ }
  updateYou() { /* 荷官没有手牌;场景下方是荷官的手 */ }

  updatePot(amount) {
    this.dom.potValue.textContent = fmt(amount);
    this.dom.pot.hidden = !(amount > 0);
  }

  updateDealerInfo() { /* 荷官信息并进底部提示与侧栏脚注 */ }

  updateTopbar(view, info, streetText) {
    this.dom.handTag.textContent = `第 ${view.handNo} 手`;
    // 盲注:升盲模式下显示档位与进度(第几档 / 本档已过几个回合)
    let blind = `盲注 ${view.smallBlind} / ${view.bigBlind}`;
    if (view.bbAnte > 0) blind += ` · 大盲前注 ${view.bbAnte}`;
    else if (view.ante > 0) blind += ` · 前注 ${view.ante}`;
    if (view.blindLevelUp && view.blindLevel >= 0) {
      const inLevel = view.orbits % view.orbitsPerLevel;
      blind += ` · 第 ${view.blindLevel + 1}/${view.blindLevelCount} 档(本档 ${inLevel}/${view.orbitsPerLevel} 回合)`;
    }
    this.dom.blindTag.textContent = blind;
    this.dom.blindTag.title = view.blindLevelUp
      ? '升盲模式:每过 10 个完整人回合升一档'
      : '盲注固定(可在设置里打开升盲模式)';
    this.dom.deckTag.textContent = view.shortDeck ? '短牌 36 张' : '标准 52 张';
    this.dom.street.textContent = view.handOver ? '本手结束' : (streetText || view.streetLabel || '等待开局');
    this.dom.street.className = 'street street--' + (view.handOver ? 'over' : view.street);
    this.boardStreetText = streetText || view.streetLabel || '';
    if (info) this.dom.statLine.textContent = info;
  }

  resetSeatsCache() {
    for (const p of this.plates.values()) {
      if (!p.node) continue;
      p.node.classList.remove('is-winner', 'is-actor', 'is-folded', 'is-out', 'is-allin');
      const d = p.node.querySelector('.plate__delta');
      if (d) { d.textContent = ''; d.className = 'plate__delta'; }
      const a = p.node.querySelector('.plate__action');
      if (a) a.hidden = true;
    }
  }

  celebrate(seats) {
    // 头顶名牌去掉之后,赢家的反馈靠:座位脚下的金色指示器 + 中央横幅 + 手牌一览的高亮
    void seats;
  }

  showBanner(text, sub = '', ms = 2400) {
    const b = el('div', 'banner');
    b.innerHTML = '<div class="banner__main"></div><div class="banner__sub"></div>';
    b.querySelector('.banner__main').textContent = text;
    b.querySelector('.banner__sub').textContent = sub;
    this.root.querySelector('.screen').appendChild(b);
    setTimeout(() => { b.classList.add('banner--out'); setTimeout(() => b.remove(), 500); }, ms);
  }

  /* ---------------- 日志 ---------------- */

  static stamp() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  pushLog(entry) {
    const line = el('div', `log__line log__line--${entry.kind}`);
    line.innerHTML = `<span class="log__icon">${LOG_ICON[entry.kind] || '·'}</span>
      <span class="log__time">${SceneTable.stamp()}</span><span class="log__text"></span>`;
    line.querySelector('.log__text').textContent = entry.text;
    this.dom.log.appendChild(line);
    while (this.dom.log.children.length > 500) this.dom.log.removeChild(this.dom.log.firstChild);
    this.dom.log.scrollTop = this.dom.log.scrollHeight;
  }

  pushThink({ seat, name, persona, model, handNo, street, thinking, action, source }) {
    const item = el('div', 'think__item');
    item.innerHTML = `
      <div class="think__head"><b class="think__name"></b><span class="think__tag"></span>
        <span class="think__time">${SceneTable.stamp()}</span></div>
      <div class="think__text"></div>
      <div class="think__foot"><span class="think__action"></span><span class="think__meta"></span></div>`;
    item.querySelector('.think__name').textContent = name || `座位${seat + 1}`;
    item.querySelector('.think__tag').textContent = persona?.tag || '';
    item.querySelector('.think__text').textContent = thinking || '(没有输出思考)';
    const act = item.querySelector('.think__action');
    act.textContent = action || '';
    item.querySelector('.think__meta').textContent =
      `第 ${handNo} 手 · ${street || ''} · ${model || '本地策略'}${source === 'fallback' ? ' · 本地兜底' : ''}`;
    this.dom.thinkLog.appendChild(item);
    while (this.dom.thinkLog.children.length > 300) this.dom.thinkLog.removeChild(this.dom.thinkLog.firstChild);
    this.dom.thinkLog.scrollTop = this.dom.thinkLog.scrollHeight;
  }

  clearLog() {
    this.dom.log.innerHTML = '';
    this.dom.thinkLog.innerHTML = '';
  }

  setPanel(which) {
    for (const t of this.dom.tabs) t.classList.toggle('is-active', t.dataset.panel === which);
    this.dom.log.hidden = which !== 'log';
    this.dom.thinkLog.hidden = which !== 'think';
  }

  setSidePanelOpen(open) {
    this.dom.sidePanel.classList.toggle('is-collapsed', !open);
    this.dom.btnLog.classList.toggle('is-active', open);
    // 手牌一览的宽度跟着侧栏走:CSS 里靠 body 上的这个类切换
    document.body.classList.toggle('is-sidepanel-open', !!open);
  }

  /** 手牌一览是否已收起 */
  isHandStripCollapsed() {
    return this.dom.handStrip.classList.contains('is-collapsed');
  }

  /** 收起 / 展开手牌一览(加注面板展开时用得上) */
  setHandStripCollapsed(collapsed) {
    if (this.isHandStripCollapsed() === collapsed) return;
    this.handStripOpen = !collapsed;
    this.dom.handStrip.classList.toggle('is-collapsed', collapsed);
    this.dom.btnHandStrip.textContent = collapsed ? '展开' : '收起';
  }

  /**
   * 切换玩法模式。
   * 玩家模式下荷官的那几个特权(底牌三态、手动控节奏)没有意义,收起来。
   */
  setMode(mode, humanSeat) {
    this.mode = mode;
    this.humanSeat = humanSeat ?? null;
    const isPlayer = mode === 'player';
    document.body.classList.toggle('is-player-mode', isPlayer);

    // 底牌三态 / 气泡开关 / 思考记录 —— 这些都是荷官专属的
    if (this.dom.btnPeek) this.dom.btnPeek.hidden = isPlayer;
    if (this.dom.btnThink) this.dom.btnThink.hidden = isPlayer;
    if (this.dom.btnThinkLog) this.dom.btnThinkLog.hidden = isPlayer;
    // 「下一位」是荷官控节奏用的;玩家模式下节奏由自己的操作驱动
    if (this.dom.btnNext) this.dom.btnNext.hidden = isPlayer;
    if (this.dom.btnMode) this.dom.btnMode.hidden = isPlayer;

    // 玩家模式下侧栏只剩「牌局记录」一个页签(思考记录不给看)
    for (const t of this.dom.tabs) {
      if (t.dataset.panel === 'think') t.hidden = isPlayer;
    }
    if (isPlayer) this.setPanel('log');
    this.setLogLabel(isPlayer ? '牌局记录' : '荷官记录');

    this.layoutPlayerBar();
  }

  /** 「荷官记录」这个说法在玩家模式下不成立,换成中性的「牌局记录」 */
  setLogLabel(text) {
    const a = this.dom.logBtnLabel;
    const b = this.dom.tabLog;
    if (a) a.textContent = text;
    if (b) b.textContent = text;
  }

  /**
   * 玩家模式:把三个按钮(以及展开后的加注浮层)放到「手牌一览」上方。
   *
   * 关键点:
   *   · 只读布局,不改布局 —— 手牌一览不会被收起来,一直是开着的;
   *   · 不按元素高度反推位置(内容一变高度就变,那一帧会读到旧值,结果压住手牌一览),
   *     而是算出「底边该贴在哪条线上」(CSS 变量 --pbar-bottom),整块自己往上长。
   */
  layoutPlayerBar() {
    const bar = this.dom.pbar;
    if (!bar || !this.dom.actionbar) return;

    // 底部两条:操作条常驻,手牌一览可以收起(但玩家模式下我们不主动收)
    const actionTop = this.dom.actionbar.getBoundingClientRect().top;
    const strip = this.dom.handStrip;
    const stripTop = strip && !strip.classList.contains('is-collapsed')
      ? strip.getBoundingClientRect().top
      : null;
    const ceiling = stripTop === null ? actionTop : Math.min(stripTop, actionTop);

    // 整组(信息条 / 提示行 / 按钮)的**底边**就贴在这条线下面一点。
    //
    // 现在容器是正常盒子(flex 列,有高度),底边用 bottom 直接定,
    // 里面的块按 order 从下往上堆 —— 所以「整组底边贴在哪」是唯一变量,
    // 不需要再回写任何高度变量,也不会跟测量形成反馈回路。
    // (旧写法是零尺寸锚点 + 每块 translateY(-100%),两层百分比叠加,
    //  实测差 36px 且会越量越偏,已经重写掉了。)
    const GAP_ABOVE_CEILING = 2;
    const bottomPx = window.innerHeight - ceiling + GAP_ABOVE_CEILING;
    bar.style.setProperty('--pbar-bottom', `${Math.round(bottomPx)}px`);

    // 按钮区实际多高就写多少 —— 别用常量猜。加注浮层的偏移量靠这个变量,
    // 猜错的话浮层会压在按钮上(踩过一次:常量写 61,实际渲染出来不是)。
    // 用 offsetHeight:它不含 transform,量出来稳定。
    const acts = this.dom.pbarActs;
    if (acts) {
      const ah = acts.offsetHeight;
      if (ah > 0) bar.style.setProperty('--pbar-acts-h', `${ah}px`);
    }
  }

  /**
   * 把玩家模式那三个按钮的容器交给场景。
   *
   * 这个元素是 app.js 建好后再插到界面上的,场景构造时它还不在 DOM 里 ——
   * 所以不能在构造函数里 querySelector,必须由外面主动交进来。
   * (踩过坑:构造时查不到 → dom.pbar 一直是 null → 每帧的定位函数直接 return,
   *  结果按钮位置只能靠 CSS 兜底值,展开加注浮层时直接盖住手牌一览。)
   */
  setPlayerBarEl(el) {
    this.dom.pbar = el || null;
    this.dom.pbarActs = el ? el.querySelector('.pbar__acts') : null;
    this.layoutPlayerBar();
  }

  /** 玩家模式:关掉荷官专属界面 */
  setDealerOnlyUI(on) {
    if (this.dom.btnPeek) this.dom.btnPeek.hidden = !on;
  }

  /* ---------------- 小工具 ---------------- */

  toast(text, kind = 'info', ms = 2600) {
    const t = this.dom.toast;
    t.textContent = text;
    t.className = `toast toast--show toast--${kind}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.className = 'toast'; }, ms);
  }

  setHint(text, busy = false) {
    this.dom.hint.textContent = text;
    this.dom.hint.classList.toggle('is-busy', busy);
  }

  setDealEnabled(on) {
    // 玩家模式:牌局进行中不给「发牌 / 下一手」(要等这一手打完)
    const isPlayer = this.mode === 'player';
    const midHand = isPlayer && !on;
    this.dom.btnDeal.disabled = !on;
    this.dom.btnDeal.classList.toggle('is-disabled', !on);
    this.dom.btnDeal.hidden = midHand;
  }

  setNextEnabled(on) {
    this.dom.btnNext.disabled = !on;
    this.dom.btnNext.classList.toggle('is-waiting', on);
  }

  get seatsCount() { return this.plates.size; }
}
