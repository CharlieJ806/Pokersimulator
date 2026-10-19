/**
 * 扑克道具层:中央的公共牌区 / 烧牌堆 / 底池 / 牌堆,每个座位的底牌、下注、筹码堆,
 * 以及发牌与结算的飞行动画。
 *
 * 为什么单独一个文件(sceneCore / props 的分界):
 *   桌椅、座位、立绘、相机这些是**桌游通用**的,换游戏只换桌上摆什么。
 *   所以「牌长什么样、筹码怎么堆、底池摆哪儿」全部收在这里 —— sceneCore/ 里
 *   一个扑克词都不许出现(tools/refactortest.mjs 会扫)。
 *
 * 怎么接进场景:实现 Table3D#addPropLayer 要的那几个方法(build / sync / stop / ...),
 * 由扑克的 mount() 挂上去。完整契约写在 sceneCore/table.js 的 addPropLayer 注释里。
 *
 * 坐标约定(与 sceneCore 一致):
 *   · 桌面在 y = 0,桌子中心在原点;
 *   · 荷官(相机)在 +z 一侧,牌手全在 z < 0 那半圈;
 *   · 底牌 / 下注 / 筹码堆一律用 host.feltPoint(angle, inset) 定位 ——
 *     它们是「贴着毡布边缘、正对某个座位」的东西,座位一外扩这些东西要跟着走。
 */

import * as THREE from '../../../../vendor/three.module.js';
import {
  createCardMesh, setCardFace, createChipStack, scatterChips, CARD_SCALE,
  flyCard, hasCardAnimations, clearCardAnimations, flyChips,
} from './cards3d.js';

export class PokerProps {
  constructor() {
    this.id = 'poker';
    /** 中央区域(每次 build 重造) */
    this.boardGroup = null;
    this.boardCards = [];
    this.burnGroup = null;
    this.burnCards = [];
    this.potGroup = null;
    this.potChips = null;
    /** 座位 → { holes, c1, c2, holeKey, bet, stack } */
    this.seats = new Map();
    /** 牌堆(发牌动画的起点)与它的世界坐标 */
    this.deckPile = null;
    this.deckPos = null;
    /** 底池显示值:手牌结束时引擎会把 pot 清零,结算动画还要用「刚才有多少」 */
    this.potShown = 0;
    /** 结算动画的边沿检测与信息 */
    this._settleDone = false;
    this._settleFlights = [];
    this.settleInfo = null;
    this.lastResult = null;
    /** 荷官的手(画面下方)。建一次就够,不随座位重建 */
    this.hands = null;
  }

  /* ---------------- 座位重建 ---------------- */

  /**
   * 座位重建后调用:把上一批道具从场景里摘干净,再按新座位造一遍。
   *
   * ⚠️ 摘的时候必须**真的从 root 上 remove**:sceneCore 建座位只清它自己的东西,
   *    道具留在场上就会出现「8 人桌的底牌还挂在 6 人桌的桌沿上」这种鬼影。
   */
  build(host) {
    // 荷官的手:与座位无关,只建一次
    if (!this.hands) {
      this.hands = makeHands();
      host.root.add(this.hands.group);
    }

    // 先把上一批全摘掉
    for (const g of [this.boardGroup, this.burnGroup, this.potGroup, this.deckPile]) {
      if (g) host.root.remove(g);
    }
    for (const s of this.seats.values()) {
      for (const g of [s.holes, s.bet, s.stack]) if (g) host.root.remove(g);
    }
    this.seats.clear();
    this.boardCards = [];
    this.burnCards = [];
    this.potChips = null;
    this.deckPile = null;
    this.deckPos = null;
    this._settleDone = false;
    this.settleInfo = null;

    // 中央:公共牌
    // 位置偏上(z 为负),这样不会被画面下方荷官的手挡住
    this.boardGroup = new THREE.Group();
    this.boardGroup.position.set(0, 0.035, -1.05);
    host.root.add(this.boardGroup);

    // 烧牌堆
    this.burnGroup = new THREE.Group();
    // 竖屏时桌子会变窄:烧牌堆 / 底池的横向位置要跟着毡布宽度收,别落到桌外
    const felt = host.feltAxes();
    this.burnGroup.position.set(-Math.min(2.15, felt.a * 0.78), 0.035, -0.95);
    host.root.add(this.burnGroup);

    // 底池摆在桌面内侧、略偏荷官这一侧。
    // 原来是 (1.85, -1.0) —— 离桌面半径 2.62 的边缘太近,几乎贴着一个座位,
    // 结算时筹码从底池飞出去会「刚起飞就到了」。往里收到 1.55 左右,
    // 既有飞行距离,也不会和公共牌/下注区挤在一起。
    this.potGroup = new THREE.Group();
    this.potGroup.position.set(Math.min(1.15, felt.a * 0.62), 0.05, -1.05);
    host.root.add(this.potGroup);

    for (const [seat, s] of host.seats) {
      const t = s.transform;

      // 底牌:两张盖着的牌,平放在这个座位正前方、毡布边缘往里一点
      const cx = Math.cos(t.angle), cz = Math.sin(t.angle);
      const tx = -cz, tz = cx;                     // 切线方向
      const holes = new THREE.Group();
      const hp = host.feltPoint(t.angle, 0.5);
      holes.position.set(hp.x, 0.04, hp.z);
      holes.rotation.y = s.rig.rotation.y;
      const c1 = createCardMesh(null, 'sm');
      const c2 = createCardMesh(null, 'sm');
      // 两张底牌并排,间距同样跟着牌的缩放走
      const holeGap = 0.36 * (CARD_SCALE / 1.28);
      c1.position.set(-holeGap * tx, 0, -holeGap * tz);
      c2.position.set(holeGap * tx, 0, holeGap * tz);
      c1.rotation.set(-Math.PI / 2, 0, 0.05);
      c2.rotation.set(-Math.PI / 2, 0, -0.04);
      holes.add(c1, c2);
      host.root.add(holes);

      // 下注筹码(在角色与底池之间)
      const bet = new THREE.Group();
      const bp = host.feltPoint(t.angle, 1.15);
      bet.position.set(bp.x - t.x, 0.05, bp.z - t.z);
      host.root.add(bet);

      // 自己的筹码堆:放在自己面前的桌沿上(和底牌错开,不叠在一起)
      const stack = new THREE.Group();
      // 沿桌沿错开一点(而不是沿切线平移 —— 最外侧的座位沿切线一推就推到包边上了)
      const sp = host.feltPoint(t.angle + 0.16, 0.42);
      stack.position.set(sp.x, 0.05, sp.z);
      host.root.add(stack);

      this.seats.set(seat, { holes, c1, c2, bet, stack, holeKey: null });
    }
  }

  /* ---------------- 每帧同步 ---------------- */

  /**
   * @param {object} view 引擎给荷官看的局面
   * @param {object} ctx { revealAll, winnerSeats, showdownReveal }
   * @param {object} host sceneCore 给的宿主接口
   */
  sync(view, ctx, host) {
    for (const p of view.players) {
      const s = this.seats.get(p.seat);
      if (!s) continue;

      // 底牌
      const showdown = view.handOver && !p.folded && p.inHand && ctx.showdownReveal;
      const faceUp = ctx.revealAll || showdown;
      const key = `${faceUp}|${p.hole.join(',')}|${p.inHand}`;
      if (s.holeKey !== key) {
        // 「第一次拿到牌」= 之前没有任何有效牌,现在有了。
        // ⚠️ 别用 `s.holeKey === undefined` 判断 —— build 里初始化的是 **null**,
        //    那样判断永远为假,动画就永远不会播(踩过:代码看着对但一次没触发)。
        const hadCards = s.holeKey !== null && s.holeKey !== undefined
          && !/^\w+\|,\|/.test(s.holeKey);          // "false|,|true" 这种是「有座位但没牌」
        const nowHasCards = Array.isArray(p.hole) && p.hole[0] !== null && p.hole[0] !== undefined;
        const firstDeal = !hadCards && nowHasCards;
        s.holeKey = key;
        const show = faceUp && p.inHand;
        setCardFace(s.c1, show ? p.hole[0] : null);
        setCardFace(s.c2, show ? p.hole[1] : null);
        // 摊牌时把自己的牌往中间推一点,像亮牌
        s.holes.position.y = show ? 0.045 : 0.035;
        s.c1.rotation.z = show ? -0.03 : 0;
        s.c2.rotation.z = show ? 0.03 : 0;

        // 第一次拿到牌 → 从牌堆飞过来(两张错峰,像真的在发牌)
        if (firstDeal && p.inHand && this.deckPos) {
          this._flyFromDeck(host, s.c1, this.deckPos, { delay: 0, arc: 0.5 });
          this._flyFromDeck(host, s.c2, this.deckPos, { delay: 110, arc: 0.5 });
        }
      }
      s.holes.visible = p.inHand;

      // 本轮下注筹码
      this._syncChips(s.bet, p.betThisRound, 0.9);
      s.bet.visible = p.betThisRound > 0;

      // 剩余筹码堆(按筹码量取个视觉对数,免得堆得离谱)
      const visual = p.stack > 0 ? Math.max(1, Math.min(9, Math.log10(p.stack + 1) * 2.4)) : 0;
      this._syncChips(s.stack, Math.round(visual * 300), 1.15);
      s.stack.visible = p.stack > 0 && !p.inHand ? false : p.stack > 0;
    }

    // 牌堆(发牌用的那一叠)放在荷官手边的毡布上,不能探出桌面。
    // ⚠️ 必须在下面「飞牌」之前建好 —— 否则第一手发牌时牌堆还不存在,
    //    起点算不出来,动画会被静默跳过(只剩后面几手有动画)。
    if (!this.deckPile) {
      this.deckPile = new THREE.Group();
      this.deckPile.position.set(1.05, 0.03, 1.35);
      for (let i = 0; i < 10; i++) {
        const m = createCardMesh(null, 'md');
        m.rotation.x = -Math.PI / 2;
        m.rotation.z = (Math.random() - 0.5) * 0.03;
        m.position.set((Math.random() - 0.5) * 0.02, i * 0.016, (Math.random() - 0.5) * 0.02);
        this.deckPile.add(m);
      }
      host.root.add(this.deckPile);
      // 把牌堆顶面的世界坐标缓存下来 —— 发牌动画的起点,每帧去算太浪费
      host.root.updateMatrixWorld(true);
      const top = this.deckPile.children[this.deckPile.children.length - 1];
      this.deckPos = top.getWorldPosition(new THREE.Vector3());
    }

    // 公共牌:整排要落在毡布内,同时右边不能顶到底池。
    // 间距跟着牌的缩放走(牌缩小了还留着老间距会露出很大的缝)。
    const shown = view.board.length;
    const step = 0.74 * (CARD_SCALE / 1.28);
    while (this.boardCards.length < shown) {
      const i = this.boardCards.length;
      const m = createCardMesh(null, 'lg');
      m.position.set((i - 2) * step, 0, 0);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = (Math.random() - 0.5) * 0.04;
      m.visible = false;                 // 先不可见,等真的发到它才飞出来
      this.boardGroup.add(m);
      this.boardCards.push(m);
    }
    // 这一轮新翻出来的公共牌(可能一次 3 张翻牌,也可能 1 张转牌/河牌)
    const newlyShown = [];
    this.boardCards.forEach((m, i) => {
      const id = view.board[i];
      const wasVisible = m.visible;
      if (i < shown && m.userData.cardId !== id) setCardFace(m, id);
      m.visible = i < shown;
      if (i < shown && !wasVisible) newlyShown.push(i);
    });
    // 错峰发:一张接一张,而不是三张同时飞(翻牌圈一次发 3 张时特别明显)
    newlyShown.forEach((idx, k) => {
      this._flyFromDeck(host, this.boardCards[idx], this.deckPos, {
        delay: k * 130,
        rotX: -Math.PI / 2,
        rotZ: this.boardCards[idx].rotation.z,
        arc: 0.42,
      });
    });

    // 烧牌堆
    const burn = view.burned || 0;
    while (this.burnCards.length < burn) {
      const m = createCardMesh(null, 'sm');
      m.rotation.x = -Math.PI / 2;
      m.position.y = this.burnCards.length * 0.02;
      m.rotation.z = (Math.random() - 0.5) * 0.3;
      this.burnGroup.add(m);
      this.burnCards.push(m);
    }
    this.burnCards.forEach((m, i) => { m.visible = i < burn; });

    // 底池
    // 注意:手牌结束时引擎会把 pot 清零,所以先记住「刚才还有多少」——
    // 筹码飞向赢家的动画要用这个数,不然结算那一刻读到 0 就没得飞了。
    if (view.pot > 0) this.potShown = view.pot;
    this._syncChips(this.potGroup, view.pot, 1.35);
    this.potGroup.visible = view.pot > 0;

    // 结算动画:筹码从底池飞向赢家
    this._maybeSettleAnimation(view, ctx, host);
  }

  /* ---------------- 动画 ---------------- */

  /**
   * 让一张牌从牌堆飞到它现在该在的位置(发牌动画)。
   *
   * 坐标要绕一下:牌挂在**座位组 / 公共牌组**下(局部坐标),
   * 而牌堆位置是**世界坐标**。所以要把「牌堆的世界坐标」换算成
   * 这张牌父节点的局部坐标,才能当起点。不换算的话牌会从场景原点
   * 起飞、或者直接飞到桌子外面去。
   *
   * @param {object} host
   * @param {THREE.Object3D} mesh 要飞的牌
   * @param {THREE.Vector3} deckWorld 牌堆顶面的世界坐标
   * @param {{delay?:number, rotX?:number, rotZ?:number, arc?:number}} opts
   */
  _flyFromDeck(host, mesh, deckWorld, opts = {}) {
    if (!mesh || !deckWorld) return;
    const parent = mesh.parent;
    if (!parent) return;

    // 落点:保持布局算好的位置与旋转
    const toLocal = mesh.position.clone();
    const rotTo = {
      x: opts.rotX !== undefined ? opts.rotX : mesh.rotation.x,
      y: mesh.rotation.y,
      z: opts.rotZ !== undefined ? opts.rotZ : mesh.rotation.z,
    };

    // 起点:牌堆的世界坐标 → 这张牌父节点的局部坐标
    host.root.updateMatrixWorld(true);
    const fromLocal = parent.worldToLocal(deckWorld.clone());

    // 从牌堆飞出来时是「平躺朝上」的(和牌堆里那些牌一样),
    // 落地过程中再转成最终朝向 —— 公共牌本来就平躺,底牌要立起来。
    flyCard({
      mesh,
      from: fromLocal,
      to: toLocal,
      rotFrom: { x: -Math.PI / 2, y: 0, z: rotTo.z },
      rotTo,
      dur: 380,
      delay: opts.delay || 0,
      arc: opts.arc !== undefined ? opts.arc : 0.5,
    });
  }

  /**
   * 手牌结束时,让筹码从底池飞到各个赢家那儿。
   *
   * 数据从哪来:引擎的 lastResult 里有 pots(每个池的金额与合格座位)
   * 和 payouts(每个座位实际拿到多少)。用它就能做到
   * 「主池飞给所有合格者、边池只飞给对应的人」。
   *
   * 时机:只在 handOver 从 false 变 true 的那一瞬间触发一次 ——
   * 这个函数每帧都会被调用,不加边沿检测会一直重复播。
   */
  _maybeSettleAnimation(view, ctx, host) {
    const over = !!view.handOver;
    if (!over) { this._settleDone = false; return; }
    if (this._settleDone) return;

    const res = host.root?.userData?.lastResult || this.lastResult || null;
    const winners = ctx.winnerSeats || [];
    if (!winners.length) { this._settleDone = true; return; }

    this._settleDone = true;

    // 金额一律以**引擎的 payouts 为准**(由 setLastResult 送进来)。
    // 不要用缓存的底池显示值 potShown —— 那是渲染用的近似,
    // 实测会比分出去的钱少(9053 vs 10000),拿它飞动画就对不上。
    const payouts = Array.isArray(res?.payouts) ? res.payouts : null;
    let ledger = [];
    if (payouts && payouts.length) {
      ledger = payouts
        .filter((p) => p && p.amount > 0 && this.seats.has(p.seat))
        .map((p) => ({ seat: p.seat, amount: p.amount }));
    } else {
      // 没有 payouts(理论上不该发生)就按赢家平分底池显示值,金额只影响视觉
      const potAmount = this.potShown || 0;
      if (potAmount <= 0) return;
      const share = Math.floor(potAmount / winners.length);
      ledger = winners.filter((s2) => this.seats.has(s2)).map((seat) => ({ seat, amount: share }));
    }
    if (!ledger.length) return;

    // 从底池的世界坐标出发
    host.root.updateMatrixWorld(true);
    const from = this.potGroup.getWorldPosition(new THREE.Vector3());

    // 按金额从大到小飞 —— 让大赢家先动,视觉上更明确
    ledger.sort((a, b) => b.amount - a.amount);

    let baseDelay = 0;
    this._settleFlights = [];
    for (const entry of ledger) {
      const s = this.seats.get(entry.seat);
      if (!s) continue;
      // 落点:这个人自己的筹码堆。
      // 注意别用 bet 往座位方向 lerp —— bet 已经在「座位与桌心之间」,
      // 再往座位插值反而把它拉回桌心附近(实测落点距桌心只有 0.15)。
      // stack 就是这个人面前的筹码堆,筹码并进去最自然。
      const to = s.stack.getWorldPosition(new THREE.Vector3());
      to.y = 0.12;

      const r = flyChips({
        parent: host.root,
        from, to,
        amount: entry.amount,
        baseDelay,
        gap: 110,
        label: `seat${entry.seat}`,
        onArrive: () => {
          // 筹码落地 → 让赢家的指示器闪一下,并让周围的筹码堆动起来
          host.flashSeat?.(entry.seat, 900);
        },
      });
      if (r) this._settleFlights.push({ seat: entry.seat, ...r });
      // 下一个赢家整体晚一点开始,避免所有筹码糊在一起
      baseDelay += 140;
    }
    // 注意:这里用 ledger 合计,不要再引用 potAmount ——
    // 那个变量在改用引擎 payouts 之后已经删掉了,留着会抛 ReferenceError,
    // 而异常发生在动画已经发起之后,所以表现是「筹码飞了但 settleInfo 一直没有」,
    // 很难从表象看出来(踩过)。
    const shownTotal = ledger.reduce((s2, l) => s2 + l.amount, 0);
    this.settleInfo = { at: Date.now(), total: shownTotal, ledger, flights: this._settleFlights.length };
  }

  /** 最近一次结算动画的信息(测试与调试用) */
  __settleInfo() {
    return this.settleInfo || null;
  }

  /** 把引擎的 lastResult 送进来(结算动画需要 payouts 才能区分主池/边池) */
  setLastResult(result) {
    this.lastResult = result || null;
  }

  /** 还有没有牌/筹码在飞行中(测试与调试用) */
  animAlive() {
    return hasCardAnimations() ? 1 : 0;
  }

  /** 立刻停掉所有飞行动画 */
  stop() {
    clearCardAnimations();
  }

  _syncChips(group, amount, scale) {
    const want = amount > 0 ? Math.max(1, Math.ceil(Math.min(14, Math.log10(amount + 1) * 3.2))) : 0;
    const visualAmount = amount > 0 ? Math.max(amount, 1) : 0;
    if (group.userData.count === want && group.userData.amount === visualAmount) return;
    group.userData.count = want;
    group.userData.amount = visualAmount;
    while (group.children.length) {
      const c = group.children.pop();
      c.parent?.remove(c);
    }
    if (!want) return;
    // 用面值拆出一小堆筹码(只取前 want 枚,视觉上够用)
    const stack = createChipStack(visualAmount, { scale });
    const kept = stack.children.slice(0, want * 2);
    for (const c of kept) group.add(c);
    scatterChips(group, 0.11 * scale);
  }
}

/* ------------------------------------------------------------ 荷官的手 */

/**
 * 画面下方那一双「荷官的手」(参考图构图的一部分)。
 *
 * 属于扑克:这个游戏的视角就是「你坐在桌边当荷官」。别的桌游未必有荷官,
 * 所以它不在 sceneCore 里 —— 但它和座位无关,只建一次。
 */
function makeHands() {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xf3c9a0, roughness: 0.82 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.92 });

  // 荷官手里的牌组(荷官不给自己发牌,所以这里是空的)
  const cards = new THREE.Group();
  group.add(cards);
  const cardA = null;
  const cardB = null;

  for (const s of [-1, 1]) {
    // 袖子:从画面下沿伸进来
    const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.3, 8, 16), sleeveMat);
    sleeve.position.set(s * 1.34, -0.16, 5.45);
    sleeve.rotation.set(-1.32, 0, s * 0.12);
    sleeve.castShadow = true;
    group.add(sleeve);

    // 手背
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.31, 18, 14), skinMat);
    hand.position.set(s * 0.6, 0.16, 4.62);
    hand.scale.set(1.05, 0.7, 1.3);
    hand.rotation.set(-0.34, 0, 0);
    hand.castShadow = true;
    group.add(hand);

    // 手指:朝桌面方向摊开
    for (let f = 0; f < 4; f++) {
      const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.2, 4, 8), skinMat);
      finger.position.set(s * (0.45 + f * 0.1), 0.12, 4.32 - f * 0.015);
      finger.rotation.set(1.42, 0, s * 0.05);
      group.add(finger);
    }
    // 拇指
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.072, 0.16, 4, 8), skinMat);
    thumb.position.set(s * 0.98, 0.12, 4.58);
    thumb.rotation.set(1.2, 0, s * 0.6);
    group.add(thumb);
  }

  return { group, cardA, cardB, cards };
}
