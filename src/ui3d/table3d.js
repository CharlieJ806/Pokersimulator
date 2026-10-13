/**
 * 3D 牌桌:桌子本体 + 坐一圈的 AI 角色 + 公共牌 / 底池 / 各家下注 + 荷官的手与牌。
 *
 * 坐标约定:
 *   · 桌面在 y = 0,桌子中心在原点;
 *   · 荷官(相机)在 +z 一侧,对手分布在对面与两侧;
 *   · 座位角度 angle 决定站位,角色一律朝向圆心(rotation.y = angle + π/2)。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 座位圈大小 / 座位间距   → SEAT_RX / SEAT_RZ(文件顶部常量)
 *   · 桌面半径                → TABLE_R
 *   · 椅子造型                → buildSeats() 里 chairGroup 的拼装
 *   · 头顶指示器的大小/颜色   → _syncMarker()
 *   · 底池摆在桌上什么位置    → buildSeats() 里的 potGroup.position
 *   · 牌堆位置                → syncSeats() 里的 deckPile.position
 *   · 发牌动画从哪起飞        → this.deckPos(牌堆顶面的世界坐标)
 *   · 结算动画(筹码飞赢家)   → _maybeSettleAnimation() / _flashWinner()
 * ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { PALETTE } from './scene.js';
import { createCharacter, setCharacterPose, CHAR_SCALE } from './characters3d.js';
import {
  createCardMesh, setCardFace, createChipStack, scatterChips, CARD_SCALE,
  flyCard, hasCardAnimations, clearCardAnimations, flyChips,
} from './cards3d.js';

const SEAT_RX = 3.05;     // 座位椭圆半径 x(会按人数放大)
const SEAT_RZ = 2.45;     // 座位椭圆半径 z
const TABLE_R = 2.62;     // 桌面半径
const RAIL_OUTER_R = 2.95; // 包边外沿(座位必须在它之外,否则身体会埋进桌子)

/**
 * 人越多坐得越开。
 *
 * 这些数字是按几何算出来的,不是估的:
 *   角色躯干世界半宽 = 0.79(见 characters3d.js 的 CHAR_SCALE),躯干最内侧要落在
 *   包边外沿(2.95)之外。中间那两个座位正对圆心,座位半径 ≈ 2.45 × spread,
 *   所以 spread ≥ (2.95 + 0.79) / 2.45 ≈ 1.53。左右两侧的座位约束更松,这里统一取保守值。
 */
const SEAT_SPREAD = { 2: 1.22, 3: 1.22, 4: 1.22, 5: 1.22, 6: 1.24, 7: 1.30, 8: 1.38, 9: 1.48 };
const spreadFor = (n) => SEAT_SPREAD[Math.max(2, Math.min(9, n))] ?? 1.58;

/* ------------------------------------------------------------ 桌面贴图 */

function feltTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  // 亮绿毡布:中心偏亮、边缘压深(参考图那种干净明亮的绿)
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.04, S / 2, S / 2, S * 0.56);
  grd.addColorStop(0, '#4fd08a');
  grd.addColorStop(0.45, '#36b673');
  grd.addColorStop(0.8, '#1f9459');
  grd.addColorStop(1, '#137045');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);

  // 细绒噪点(轻一点,别把绿色弄脏)
  for (let i = 0; i < 18000; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    g.fillRect(x, y, 1, 1);
  }
  // 桌面丝印圈
  g.strokeStyle = 'rgba(255,255,255,.13)';
  g.lineWidth = 3;
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.34, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.08)';
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.42, 0, Math.PI * 2); g.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function woodTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#6d4526';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 160; i++) {
    g.strokeStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.07})`;
    g.lineWidth = 1 + Math.random() * 2;
    const y = Math.random() * S;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(S * 0.3, y + (Math.random() - 0.5) * 20, S * 0.7, y + (Math.random() - 0.5) * 20, S, y + (Math.random() - 0.5) * 12);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

/* ------------------------------------------------------------ 头顶指示牌 */

/** 把 BTN / SB / BB 画到指示器的小牌子上(没有标签就画成透明) */
function drawMarkerTag(tex, label) {
  const cv = tex.image;
  const W = 128, H = 64;
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  if (label) {
    // 单挑时会出现 'D/SB' 这种组合标签,按首段决定配色
    const head = label.split('/')[0];
    const color = head === 'D' ? '#f2f2ee'
      : head === 'SB' ? '#6ab0e9'
        : head === 'BB' ? '#e2574c'
          : '#c9d4d9';
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(4, 12, W - 8, H - 24, 14);
    g.fill();
    g.fillStyle = '#12181c';
    // 标签最多 4 个字符(D/SB),按长度自适应字号,避免溢出小牌子
    const size = label.length <= 2 ? 30 : label.length === 3 ? 25 : 21;
    g.font = `bold ${size}px "Segoe UI", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, W / 2, H / 2 + 1);
  }
  tex.needsUpdate = true;
}

/* ------------------------------------------------------------ 桌面 */
function makeTable() {
  const g = new THREE.Group();

  // 桌腿柱
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.75, 1.05, 1.3, 24),
    new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.9 }),
  );
  pedestal.position.y = -0.72;
  pedestal.castShadow = true;
  g.add(pedestal);

  // 木制桌体
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.72 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_R + 0.3, TABLE_R + 0.34, 0.26, 48), woodMat);
  body.position.y = -0.16;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // 绿色毡布
  const felt = new THREE.Mesh(
    new THREE.CylinderGeometry(TABLE_R, TABLE_R, 0.06, 64),
    new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.98 }),
  );
  felt.position.y = -0.01;
  felt.receiveShadow = true;
  g.add(felt);

  // 深色包边(一圈圆环)。做得厚一点:一是像真牌桌的扶手,二是能把对面
  // 人物躯干的下缘挡住,让身体看起来是「从桌子后面长出来」而不是浮在空中。
  const rail = new THREE.Mesh(
    new THREE.TorusGeometry(TABLE_R + 0.2, 0.26, 14, 64),
    new THREE.MeshStandardMaterial({ color: PALETTE.rail, roughness: 0.6 }),
  );
  rail.rotation.x = Math.PI / 2;
  rail.position.y = 0.06;
  rail.castShadow = true;
  rail.receiveShadow = true;
  g.add(rail);

  // 包边上的一点金色描边
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(TABLE_R + 0.2, 0.024, 8, 64),
    new THREE.MeshStandardMaterial({ color: 0xc99b34, roughness: 0.35, metalness: 0.7 }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.3;
  g.add(trim);

  return g;
}

/* ------------------------------------------------------------ 主类 */

export class Table3D {
  /**
   * @param {THREE.Scene} scene
   * @param {object} hooks { getPersona:(seat)=>persona }
   */
  constructor(scene, hooks = {}) {
    this.scene = scene;
    this.hooks = hooks;
    this.root = new THREE.Group();
    scene.add(this.root);

    this.table = makeTable();
    this.root.add(this.table);

    this.seats = new Map();       // seat -> {char, holeCards, betChips, stackChips, anchor}
    this.holeGroups = new Map();
    this.bets = new Map();
    this.stackChips = new Map();
    this.revealed = new Set();

    // 中央:公共牌 + 烧牌堆 + 底池
    // 位置偏上(z 为负),这样不会被画面下方荷官的手挡住
    this.boardGroup = new THREE.Group();
    this.boardGroup.position.set(0, 0.035, -1.05);
    this.root.add(this.boardGroup);
    this.boardCards = [];

    this.burnGroup = new THREE.Group();
    this.burnGroup.position.set(-1.95, 0.035, -0.92);
    this.root.add(this.burnGroup);
    this.burnCards = [];

    this.potGroup = new THREE.Group();
    this.potGroup.position.set(0.82, 0.05, -0.48);
    this.root.add(this.potGroup);
    this.potChips = null;

    this.buttonMesh = null;
    this.dealerHands = this._makeDealerHands();
    this.root.add(this.dealerHands.group);
  }

  /* ---------------- 荷官的手与牌(画面下方,参考图构图) ---------------- */

  _makeDealerHands() {
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

  /* ---------------- 座位 ---------------- */

  seatTransform(seat, count) {
    // 荷官在 +z(靠画面这一侧);牌手全部放在对面半圈(角度 π ~ 2π,即 z < 0 那一侧),
    // 所以绝不会有人坐到相机旁边。人越多,半径放得越大,坐得越松散。
    const a0 = Math.PI + 0.04;
    const a1 = Math.PI * 2 - 0.04;
    const angle = count <= 1 ? Math.PI * 1.5 : a0 + (seat * (a1 - a0)) / (count - 1);
    const k = spreadFor(count);

    // 画面窄的时候把座位往中间收一点,否则最外侧的人会被裁出画面
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1440;
    const narrow = Math.max(0, Math.min(1, (1440 - vw) / 300));   // 1440 宽时 0,1140 宽及以下时 1
    const squeeze = 1 - narrow * 0.45;

    return {
      angle,
      x: Math.cos(angle) * SEAT_RX * k * squeeze,
      z: Math.sin(angle) * SEAT_RZ * k,
      innerX: Math.cos(angle) * (TABLE_R + 0.5),
      innerZ: Math.sin(angle) * (TABLE_R + 0.5),
    };
  }

  /** 按人数重建座位(改人数时调用)。注意:中央的牌/筹码也要一起重建,否则会重复堆叠。 */
  buildSeats(count) {
    for (const s of this.seats.values()) {
      this.root.remove(s.rig || s.char);
      if (!s.rig && s.chair) this.root.remove(s.chair);
      this.root.remove(s.holes);
      this.root.remove(s.bet);
      this.root.remove(s.stack);
    }
    this.seats.clear();

    // 中央区域:公共牌 / 烧牌堆 / 底池 / 牌堆 全部清掉重建
    for (const g of [this.boardGroup, this.burnGroup, this.potGroup, this.deckPile]) {
      if (g) this.root.remove(g);
    }
    this.boardGroup = new THREE.Group();
    this.boardGroup.position.set(0, 0.035, -1.05);
    this.root.add(this.boardGroup);
    this.boardCards = [];

    this.burnGroup = new THREE.Group();
    this.burnGroup.position.set(-2.15, 0.035, -0.95);
    this.root.add(this.burnGroup);
    this.burnCards = [];

    this.potGroup = new THREE.Group();
    // 底池摆在桌面内侧、略偏荷官这一侧。
    // 原来是 (1.85, -1.0) —— 离桌面半径 2.62 的边缘太近,几乎贴着一个座位,
    // 结算时筹码从底池飞出去会「刚起飞就到了」。往里收到 1.55 左右,
    // 既有飞行距离,也不会和公共牌/下注区挤在一起。
    this.potGroup.position.set(1.15, 0.05, -1.05);
    this.root.add(this.potGroup);

    this.deckPile = null;
    this.buttonMesh = null;
    this.dealerKey = null;

    this.holeGroups.clear();
    this.bets.clear();
    this.stackChips.clear();
    this.revealed.clear();

    const bodyTypes = ['average', 'slim', 'stout'];
    for (let seat = 0; seat < count; seat++) {
      const persona = this.hooks.getPersona?.(seat);
      const seed = (persona?.id || 'x').length * 3 + seat * 5 + 1;
      const char = createCharacter({
        seed,
        body: bodyTypes[(seat + seed) % bodyTypes.length],
        shirt: persona?.shirt3d,
        scale: 1,
      });
      const t = this.seatTransform(seat, count);

      // 一个座位 = 一个 rig 组:人物和椅子都是它的子节点。
      // 这样「人坐在椅子上」由结构保证 —— 不会再出现各算各的坐标导致错位。
      const rig = new THREE.Group();
      rig.position.set(t.x, 0, t.z);
      // 朝向圆心:前方向 = (sin ry, 0, cos ry),要它指向 -(cos a, 0, sin a)
      rig.rotation.y = Math.atan2(-Math.cos(t.angle), -Math.sin(t.angle));
      this.root.add(rig);

      // 椅子(rig 原点 = 椅子中心)
      const chairMat = new THREE.MeshStandardMaterial({ color: PALETTE.chair, roughness: 0.72 });
      const chairDarkMat = new THREE.MeshStandardMaterial({ color: PALETTE.chairDark, roughness: 0.8 });
      const chairGroup = new THREE.Group();
      chairGroup.position.set(0, 0.06, -0.36);       // 往后挪:别让腿部探进桌体
      const seatPad = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.18, 1.0), chairMat);
      seatPad.position.set(0, -0.64, 0);
      seatPad.castShadow = true;
      chairGroup.add(seatPad);
      const backRest = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.0, 0.16), chairMat);
      backRest.position.set(0, -0.06, -0.54);        // 本地 -z = 背离桌子 = 身后
      backRest.castShadow = true;
      chairGroup.add(backRest);
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8), chairDarkMat);
        leg.position.set(sx * 0.46, -1.22, 0);
        chairGroup.add(leg);
      }
      rig.add(chairGroup);

      // 人物:坐在坐垫上 —— 沿本地 -z 往后挪一点(靠到靠背前),y 落到坐垫面
      char.position.set(0, -0.49, -0.16);
      char.scale.setScalar(CHAR_SCALE * (count >= 9 ? 0.94 : count >= 8 ? 0.97 : 1));
      rig.add(char);

      // 底牌:两张盖着的牌,平放在角色前面一点的桌面上
      // 位置:离圆心 0.60R 那边收着放,保证整叠牌都在包边以内(不悬空)
      const radial = 0.60;
      const cx = Math.cos(t.angle), cz = Math.sin(t.angle);
      const tx = -cz, tz = cx;                     // 切线方向
      const holes = new THREE.Group();
      holes.position.set(t.x * radial, 0.04, t.z * radial);
      holes.rotation.y = rig.rotation.y;
      const c1 = createCardMesh(null, 'sm');
      const c2 = createCardMesh(null, 'sm');
      // 两张底牌并排,间距同样跟着牌的缩放走
      const holeGap = 0.36 * (CARD_SCALE / 1.28);
      c1.position.set(-holeGap * tx, 0, -holeGap * tz);
      c2.position.set(holeGap * tx, 0, holeGap * tz);
      c1.rotation.set(-Math.PI / 2, 0, 0.05);
      c2.rotation.set(-Math.PI / 2, 0, -0.04);
      holes.add(c1, c2);
      this.root.add(holes);

      // 指示器:朝下的三角锥 + 一块位置标签。整体比之前小一半,但中心高度不变。
      const marker = new THREE.Group();
      const coneMat = new THREE.MeshStandardMaterial({
        color: 0x8fa0a8, roughness: 0.5, metalness: 0.15,
        emissive: 0x000000, transparent: true, opacity: 0.75,
      });
      // 原来 0.26×0.4,缩到 50%;为了让「中心高度不变」,把本地位置往上补 (0.4-0.2)/2
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.2, 4), coneMat);
      cone.rotation.x = Math.PI;
      cone.rotation.y = Math.PI / 4;
      cone.position.y = 0.1;
      cone.castShadow = false;
      cone.frustumCulled = false;
      marker.add(cone);

      // 锥体上的小牌子:同样缩一半,跟着往上补位置
      const tagTex = new THREE.CanvasTexture(document.createElement('canvas'));
      tagTex.colorSpace = THREE.SRGBColorSpace;
      const tagMat = new THREE.MeshBasicMaterial({
        map: tagTex, transparent: true, side: THREE.DoubleSide,
      });
      // 单挑时标签会变成 'D/SB',牌子要宽一点才放得下
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.15), tagMat);
      tag.position.set(0, 0.26, 0);
      tag.frustumCulled = false;
      marker.add(tag);

      marker.visible = false;
      // 挂在 rig 上,跟着座位走;就贴在头顶上方一点点
      const charTop = new THREE.Box3().setFromObject(char).max.y;
      marker.position.set(0, charTop + 0.16, -0.16);
      marker.userData.baseY = marker.position.y;
      rig.add(marker);

      // 下注筹码(在角色与底池之间)
      const bet = new THREE.Group();
      bet.position.set(t.x * 0.38 - t.x, 0.05, t.z * 0.38 - t.z);
      this.root.add(bet);

      // 自己的筹码堆:放在自己面前的桌沿上(和底牌错开,不叠在一起)
      const stack = new THREE.Group();
      stack.position.set(t.x * 0.66 + tx * 0.66, 0.05, t.z * 0.66 + tz * 0.66);
      this.root.add(stack);

      this.seats.set(seat, {
        char, rig, chair: chairGroup, holes, c1, c2, bet, stack,
        ring: marker, marker, cone, coneMat, tagTex,     // ring 保留别名,兼容旧调用
        transform: t, holeKey: null,
      });
      this.holeGroups.set(seat, holes);
      this.bets.set(seat, bet);
      this.stackChips.set(seat, stack);
    }
  }

  /* ---------------- 同步引擎状态 ---------------- */

  /**
   * @param {object} view viewForDealer()
   * @param {object} ctx { revealAll, winnerSeats, showdownReveal, thinkingSeat, thinkingPose }
   */
  update(view, ctx = {}) {
    const count = view.players.length;
    if (this.seats.size !== count) this.buildSeats(count);
    this.syncSeats(view, ctx);
  }

  /**
   * 还有多少张牌在飞行中(测试与调试用)。
   * 有了它,测试就能「等动画真的结束」而不是猜一个固定时长 ——
   * 猜时长会在半空中截到牌,看起来像「动画没结束 / 位置不稳」。
   */
  __animAlive() {
    return hasCardAnimations() ? 1 : 0;
  }

  /** 立刻停掉所有飞牌动画(退出本局 / 重开时用) */
  stopAnimations() {
    clearCardAnimations();
  }

  /**
   * 让一张牌从牌堆飞到它现在该在的位置(发牌动画)。
   *
   * 坐标要绕一下:牌挂在**座位组 / 公共牌组**下(局部坐标),
   * 而牌堆位置是**世界坐标**。所以要把「牌堆的世界坐标」换算成
   * 这张牌父节点的局部坐标,才能当起点。不换算的话牌会从场景原点
   * 起飞、或者直接飞到桌子外面去。
   *
   * @param {THREE.Object3D} mesh 要飞的牌
   * @param {THREE.Vector3} deckWorld 牌堆顶面的世界坐标
   * @param {{delay?:number, rotX?:number, rotZ?:number, arc?:number}} opts
   */
  _flyFromDeck(mesh, deckWorld, opts = {}) {
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
    this.root.updateMatrixWorld(true);
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
   * 头顶指示器:轮到谁行动谁就亮成金色并上下浮动;大盲/小盲/按钮位会在锥体上贴一块小牌子。
   * 状态没变就不重画贴图(每帧重画 Canvas 太浪费)。
   */
  _syncMarker(s, p, view, ctx) {
    if (!s.marker) return;
    const isActor = view.actor === p.seat && !view.handOver;
    const isWinner = !!ctx.winnerSeats?.includes(p.seat);
    // 记录状态,给测试与调试用(不要靠颜色反推,金色和赢家的绿色会混)
    s.markerActive = isActor;
    s.markerWinner = isWinner;

    // 只在「这一手还在牌局里、没弃牌、还有筹码」时显示。
    // 弃牌和淘汰的座位都收起来,否则桌上会留下一堆悬空的三角。
    const visible = p.inHand && p.stack > 0 && !p.folded;
    s.marker.visible = visible;
    if (!visible) return;

    // 位置标签:只在「这一手还在牌局里」时显示(淘汰的座位没有位置可言)。
    // 单挑时按钮位同时是小盲,引擎给的是 'BTN/SB' —— 要拆成 D/SB,否则只剩一串字母。
    const role = view.positions?.[p.seat] || '';
    const label = role.split('/').map((r) => (r === 'BTN' ? 'D' : r)).filter(Boolean).join('/');
    if (s.markerLabel !== label) {
      s.markerLabel = label;
      drawMarkerTag(s.tagTex, label);
    }

    // 颜色/亮度:轮到他 = 金色发光 + 上下浮动;别人 = 半透明灰
    const t = Date.now() / 1000;
    if (s.markerBaseY === undefined) s.markerBaseY = s.marker.position.y;

    // 筹码落到他那儿时的「赢家闪烁」:弹一下 + 发光更亮。
    // 这个效果叠加在常规状态之上,所以先算基础位置,再把闪烁加上去。
    const flashLeft = (s.winnerFlashUntil || 0) - performance.now();
    const flashing = flashLeft > 0;
    let flashLift = 0;
    let flashScale = 1;
    if (flashing) {
      const k = 1 - flashLeft / 900;             // 0 → 1
      const bounce = Math.sin(k * Math.PI * 3) * (1 - k);
      flashLift = bounce * 0.16;
      flashScale = 1 + (1 - k) * 0.22;
    }

    if (isActor) {
      s.coneMat.color.setHex(0xe9c46a);
      s.coneMat.emissive.setHex(flashing ? 0xb98a12 : 0x6b4d0a);
      s.coneMat.opacity = 1;
      s.marker.position.y = s.markerBaseY + Math.sin(t * 3.2) * 0.07 + flashLift;
      s.marker.scale.setScalar(1.12 * flashScale);
    } else if (isWinner) {
      s.coneMat.color.setHex(flashing ? 0x7ff0b4 : 0x4cc38a);
      s.coneMat.emissive.setHex(flashing ? 0x2fd07a : 0x0d5c34);
      s.coneMat.opacity = 1;
      s.marker.position.y = s.markerBaseY + flashLift;
      s.marker.scale.setScalar(1.08 * flashScale);
    } else {
      s.coneMat.color.setHex(0x8fa0a8);
      s.coneMat.emissive.setHex(0x000000);
      s.coneMat.opacity = p.folded ? 0.28 : 0.75;
      s.marker.position.y = s.markerBaseY + flashLift;
      s.marker.scale.setScalar(1 * flashScale);
    }
  }

  /** 只同步状态,不重建任何东西(每帧/每次渲染调用) */
  syncSeats(view, ctx = {}) {    // 按钮位
    if (!this.buttonMesh) {
      this.buttonMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.17, 0.05, 20),
        new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 }),
      );
      this.root.add(this.buttonMesh);
    }
    if (view.button >= 0 && this.seats.has(view.button)) {
      const t = this.seats.get(view.button).transform;
      this.buttonMesh.visible = true;
      this.buttonMesh.position.set(t.innerX * 0.55, 0.05, t.innerZ * 0.55);
    } else {
      this.buttonMesh.visible = false;
    }

    for (const p of view.players) {
      const s = this.seats.get(p.seat);
      if (!s) continue;

      // 角色状态。
      // 注意:弃牌的人**不隐藏**,只是把动作改成「弃牌」并降低不透明度 ——
      // 直接让人消失会显得桌上没人,而且看不出他刚才坐在哪。
      s.char.visible = true;
      const win = ctx.winnerSeats?.includes(p.seat);
      setCharacterPose(s.char, p.folded ? 'fold' : win ? 'win' : ctx.thinkingSeat === p.seat ? 'think' : 'idle');
      // 弃牌 / 淘汰 的不透明度。
      // 注意:开局前所有人都是 inHand=false,那时不能算「出局」—— 只有 stack 归零才算淘汰。
      const eliminated = p.stack <= 0;
      const op = eliminated ? 0.38 : p.folded ? 0.6 : 1;
      if (s.charOpacity !== op) {
        s.charOpacity = op;
        s.char.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m.userData.baseOpacity === undefined) {
              m.userData.baseOpacity = m.opacity !== undefined ? m.opacity : 1;
            }
            m.transparent = op < 1 || m.userData.baseOpacity < 1;
            m.opacity = m.userData.baseOpacity * op;
            m.needsUpdate = true;
          }
        });
      }
      this._syncMarker(s, p, view, ctx);

      // 底牌
      const showdown = view.handOver && !p.folded && p.inHand && ctx.showdownReveal;
      const faceUp = ctx.revealAll || showdown;
      const key = `${faceUp}|${p.hole.join(',')}|${p.inHand}`;
      if (s.holeKey !== key) {
        // 「第一次拿到牌」= 之前没有任何有效牌,现在有了。
        // ⚠️ 别用 `s.holeKey === undefined` 判断 —— buildSeats 里初始化的是 **null**,
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
          this._flyFromDeck(s.c1, this.deckPos, { delay: 0, arc: 0.5 });
          this._flyFromDeck(s.c2, this.deckPos, { delay: 110, arc: 0.5 });
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
      this.root.add(this.deckPile);
      // 把牌堆顶面的世界坐标缓存下来 —— 发牌动画的起点,每帧去算太浪费
      this.root.updateMatrixWorld(true);
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
      this._flyFromDeck(this.boardCards[idx], this.deckPos, {
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
    this._maybeSettleAnimation(view, ctx);
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
  _maybeSettleAnimation(view, ctx) {
    const over = !!view.handOver;
    if (!over) { this._settleDone = false; return; }
    if (this._settleDone) return;

    const res = this.root?.userData?.lastResult || this.lastResult || null;
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
    this.root.updateMatrixWorld(true);
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
        parent: this.root,
        from, to,
        amount: entry.amount,
        baseDelay,
        gap: 110,
        label: `seat${entry.seat}`,
        onArrive: () => {
          // 筹码落地 → 让赢家的指示器闪一下,并让周围的筹码堆动起来
          this._flashWinner(entry.seat);
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

  /** 赢家高亮闪一下(筹码飞到时触发) */
  _flashWinner(seat) {
    const s = this.seats.get(seat);
    if (!s) return;
    if (s.marker) {
      s.marker.userData.flashUntil = performance.now() + 900;
    }
    s.winnerFlashUntil = performance.now() + 900;
  }

  /** 最近一次结算动画的信息(测试与调试用) */
  __settleInfo() {
    return this.settleInfo || null;
  }

  /** 把引擎的 lastResult 送进来(结算动画需要 payouts 才能区分主池/边池) */
  setLastResult(result) {
    this.lastResult = result || null;
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

  /** 荷官翻看:以前会在手里翻两张示意牌,现在荷官不持牌,保留接口不做事 */
  showDealerCards() { /* 荷官不给自己发牌 */ }

  /**
   * 供 HUD 投影用的锚点:每个座位的头顶。
   * 水平位置跟着人物走(人物在 rig 里往后挪了一点),垂直给到头顶上方。
   */
  seatAnchors() {
    const out = new Map();
    for (const [seat, s] of this.seats) {
      const box = new THREE.Box3().setFromObject(s.char);
      const c = box.getCenter(new THREE.Vector3());
      out.set(seat, new THREE.Vector3(c.x, box.max.y, c.z));
    }
    return out;
  }

  /** 实时取某个座位的头顶位置(思考气泡每帧用这个,避免用过期缓存) */
  headAnchor(seat) {
    const s = this.seats.get(seat);
    if (!s) return null;
    const box = new THREE.Box3().setFromObject(s.char);
    const c = box.getCenter(new THREE.Vector3());
    return new THREE.Vector3(c.x, box.max.y, c.z);
  }
}

export { feltTexture, woodTexture, SEAT_RX, SEAT_RZ, TABLE_R };
