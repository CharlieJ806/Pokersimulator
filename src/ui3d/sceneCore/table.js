/**
 * 3D 桌面(场景核心):桌子本体 + 坐一圈的 AI 角色 + 椅子 + 头顶指示器 + 庄家按钮。
 *
 * 这里**只放桌游通用的东西** —— 任何「一圈人围着一张桌子」的游戏都能直接用:
 * 座位椭圆怎么排、桌子跟着人数怎么变形、人怎么坐在椅子上、谁在行动时头顶亮什么。
 * 扑克专属的**道具**(牌面、筹码、中央的公共牌区、底池、发牌/结算动画)不在这里,
 * 它们挂在 props/poker/ 的道具层里,通过下面的 addPropLayer() 接进来。
 *
 * ⚠️ 本目录(sceneCore/)里**不许出现扑克那套英文词**(完整词表在
 *    tools/refactortest.mjs —— 这里不重复列,否则规则会命中自己)。
 *    这不是洁癖:一期只有扑克的时候,「桌子」和
 *    「牌桌道具」是长在一起的,想加第二个游戏就得整段重写;分开之后,新游戏
 *    只要写自己的道具层就能复用整套桌椅/座位/立绘/相机。
 *    tools/refactortest.mjs 会扫这个目录,别绕过它。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 座位圈大小 / 座位间距   → SEAT_RX / SEAT_RZ(文件顶部常量)
 *   · 桌面半径                → TABLE_R
 *   · 椅子造型                → buildSeats() 里 chairGroup 的拼装
 *   · 头顶指示器的大小/颜色   → _syncMarker()
 *   · 新游戏的道具挂在哪      → addPropLayer()(见那里的说明)
 * ============================================================ */

import * as THREE from '../../../vendor/three.module.js';
import { PALETTE } from './stage.js';
import { createPortrait, setCharacterPose, setPortraitCharacter, facePortrait, CHAR_SCALE } from './portraits2d.js';
import { checkPropLayer } from './propLayer.js';

const SEAT_RX = 3.05;     // 座位椭圆半径 x(会按人数放大)
const SEAT_RZ = 2.45;     // 座位椭圆半径 z
const TABLE_R = 2.30;     // 桌面半径
                          // 原来 2.62 —— 桌沿离座位太近,俯视下两侧的人会压到绿色桌面上
                          // (用户反馈「人在桌子上」)。收小桌面等于给人和桌子之间
                          // 让出一道可见的空隙,比把座位往外推更划算:往外推会让
                          // 相机跟着后退,整体反而变小。

/**
 * 座位椭圆:座位圈用的半轴。
 * x 方向额外乘一个拉伸系数(长桌),见 stretchFor。
 */
const seatAxes = (count, stretch) => ({
  a: SEAT_RX * spreadFor(count) * (stretch || 1),
  b: SEAT_RZ * spreadFor(count),
});

/**
 * 在座位椭圆上按**弧长**等分,返回第 seat 个座位的参数角。
 *
 * ⚠️ 不能用「角度等分」。椭圆上角度等分时,越靠近两端 cos 变化越慢,
 *    相邻座位的**实际间距**会明显变小 —— 看起来就是「两侧挤成一堆、
 *    中间又空着」(用户反馈「分布过于紧张」)。
 *    按弧长等分才能让每个人之间的间距在视觉上一致。
 *
 * 做法:细密采样求累计弧长表,再按比例反查角度。一次几毫秒,
 * 而且只在建座位/改视口时跑,不在渲染循环里。
 */
function seatAngleByArc(seat, count, a, b, a0, a1) {
  if (count <= 1) return Math.PI * 1.5;
  const N = 240;
  const cum = new Float64Array(N + 1);
  let prevX = a * Math.cos(a0), prevY = b * Math.sin(a0);
  for (let i = 1; i <= N; i++) {
    const th = a0 + ((a1 - a0) * i) / N;
    const x = a * Math.cos(th), y = b * Math.sin(th);
    cum[i] = cum[i - 1] + Math.hypot(x - prevX, y - prevY);
    prevX = x; prevY = y;
  }
  const total = cum[N];
  if (total <= 0) return a0;
  const want = (total * seat) / (count - 1);
  // 在累计表里找第一个 ≥ want 的采样点,再线性插值
  let lo = 0, hi = N;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < want) lo = mid + 1; else hi = mid; }
  const i = Math.max(1, lo);
  const seg = cum[i] - cum[i - 1];
  const t = seg > 0 ? (want - cum[i - 1]) / seg : 0;
  return a0 + ((a1 - a0) * (i - 1 + t)) / N;
}
const RAIL_OUTER_R = 2.95; // 包边外沿(座位必须在它之外,否则身体会埋进桌子)

/**
 * 人越多坐得越开。
 *
 * 这些数字是按几何算出来的,不是估的:
 *   角色躯干世界半宽 = 0.79(见 sceneCore/portraits2d.js 的 CHAR_SCALE),躯干最内侧要落在
 *   包边外沿(2.95)之外。中间那两个座位正对圆心,座位半径 ≈ 2.45 × spread,
 *   所以 spread ≥ (2.95 + 0.79) / 2.45 ≈ 1.53。左右两侧的座位约束更松,这里统一取保守值。
 */
/**
 * 每多一个人,座位圈外扩多少。
 *
 * ⚠️ 这些数字不能只按「坐得下」给,要按「**相邻两人不重叠**」给:
 *    立绘宽约 1.9 世界单位,排在椭圆上时相邻间距 = 弧长 / (人数-1)。
 *    实测 8 人用旧的 1.38 时弧长约 10.4,相邻只有 1.49 —— 人和人叠在一起
 *    (用户反馈「人物角色还是太密集」)。现在按 1.9 宽的立绘 + 一点缝反推,
 *    8 人给到 1.80。
 */
const SEAT_SPREAD = { 2: 1.30, 3: 1.34, 4: 1.44, 5: 1.56, 6: 1.68, 7: 1.74, 8: 1.80, 9: 1.88 };
const spreadFor = (n) => SEAT_SPREAD[Math.max(2, Math.min(9, n))] ?? 1.58;

/** faceSeats 每帧复用,避免每座位新建 Vector3 */
const _seatWorld = new THREE.Vector3();

/**
 * 宽屏时把桌面拉长成**椭圆(长桌)**,把左右两侧浪费掉的空间用起来。
 *
 * @param {number} aspect 视口宽高比。**必须由调用方传真实的 canvas 宽高比** ——
 *   不要在这里读 window.innerWidth/Height:移动端首帧 canvas 往往还没有真实尺寸,
 *   读到的是错的,而错的结果会被一直留着(用户实测:桌子没被拉长、镜头还被拉远)。
 */
function stretchFor(aspect) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.6;
  // 1.5 及以下不拉;2.4 及以上拉到最大
  const t = Math.max(0, Math.min(1, (a - 1.5) / 0.9));
  // ⚠️ 别拉太狠。拉得越长,桌子的**近侧桌沿**在屏幕上扫过的宽度越大
  //    (它离相机近、被放大),两端座位就会投影进绿色桌面里。
  //    0.35(最多 1.35 倍)是「用上左右空间」与「人别压在桌面上」之间的平衡点。
  return 1 + t * 0.35;
}

/* ------------------------------------------------------------ 桌面贴图 */

function feltTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  // 灰调鼠尾草绿毡布:中心略亮、边缘压深。比原来的荧光绿收敛,跟浅色房间更搭
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.04, S / 2, S / 2, S * 0.56);
  grd.addColorStop(0, '#6aa587');
  grd.addColorStop(0.45, '#5a9479');
  grd.addColorStop(0.8, '#487f65');
  grd.addColorStop(1, '#3a6c55');
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
  g.fillStyle = '#b48a5e';            // 浅橡木
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

/** 把位置标签(庄家/小盲/大盲……)画到指示器的小牌子上(没有标签就画成透明) */
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

/**
 * 桌面跟着座位圈走 —— 座位离包边的距离固定,不随人数变。
 *
 * ⚠️ 以前桌子是固定大小的圆桌(宽屏最多横向拉 1.35 倍),座位圈却随人数外扩成长椭圆:
 *    9 人桌两侧的人离包边 2 个多单位,他们的底牌 / 下注筹码(按座位位置的比例摆)
 *    直接落在地毯上(用户反馈「人多时牌不在桌上、两侧的人离桌子过远」)。
 *    现在反过来:先定座位椭圆,再把桌子做成「座位椭圆往里收一圈」的椭圆长桌。
 */
const SEAT_GAP_X = 1.25;      // 座位中心 → 包边外沿的距离(两侧)
const SEAT_GAP_Z = 1.15;      // 同上(对面那排);6 人桌时正好等于旧圆桌的间距
const RAIL_IN = 0.65;         // 包边外沿 → 毡布边缘(包边 + 木框的厚度)
const MIN_RAIL_X = 2.4;       // 竖屏座位收得很紧时桌子也不能比这再窄 —— 5 张公共牌要放得下

/** 一条水平的椭圆闭合曲线,给包边 / 金线做 TubeGeometry 用 */
class FlatEllipse extends THREE.Curve {
  constructor(a, b) { super(); this.a = a; this.b = b; }
  getPoint(t, target = new THREE.Vector3()) {
    const th = t * Math.PI * 2;
    return target.set(this.a * Math.cos(th), 0, this.b * Math.sin(th));
  }
}

/**
 * @param {number} ra 包边外沿的 x 半轴
 * @param {number} rb 包边外沿的 z 半轴
 * 圆柱类(桌腿 / 桌体 / 毡布)用单位圆柱 + 非等比缩放;包边是管子,
 * 不能缩放(会两侧变粗),所以沿椭圆曲线真的建一根等粗的管子。
 */
function makeTable(ra = RAIL_OUTER_R, rb = RAIL_OUTER_R) {
  const g = new THREE.Group();

  // 桌腿柱:跟着桌子拉长一点,长桌配一根圆腿会显得头重脚轻
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.75, 1.05, 1.3, 32),
    new THREE.MeshStandardMaterial({ color: 0x8f6e4e, roughness: 0.8 }),
  );
  pedestal.scale.set(Math.min(2.2, ra / rb), 1, 1);
  pedestal.position.y = -0.72;
  pedestal.castShadow = true;
  g.add(pedestal);

  // 木制桌体
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.72 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.015, 0.26, 96), woodMat);
  body.scale.set(ra - 0.31, 1, rb - 0.31);
  body.position.y = -0.16;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // 毡布
  const felt = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 0.06, 96),
    new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.98 }),
  );
  felt.scale.set(ra - RAIL_IN, 1, rb - RAIL_IN);
  felt.position.y = -0.01;
  felt.receiveShadow = true;
  g.add(felt);

  // 包边(奶油色皮质)。做得厚一点:一是像真牌桌的扶手,二是能把对面
  // 人物躯干的下缘挡住,让身体看起来是「从桌子后面长出来」而不是浮在空中。
  const path = new FlatEllipse(ra - 0.45, rb - 0.45);
  const rail = new THREE.Mesh(
    new THREE.TubeGeometry(path, 192, 0.26, 14, true),
    new THREE.MeshStandardMaterial({ color: PALETTE.rail, roughness: 0.68 }),
  );
  rail.position.y = 0.06;
  rail.castShadow = true;
  rail.receiveShadow = true;
  g.add(rail);

  // 包边上的一点金色描边
  const trim = new THREE.Mesh(
    new THREE.TubeGeometry(path, 192, 0.024, 8, true),
    new THREE.MeshStandardMaterial({ color: PALETTE.gold, roughness: 0.32, metalness: 0.75 }),
  );
  trim.position.y = 0.3;
  g.add(trim);

  return g;
}

/* ------------------------------------------------------------ 主类 */

export class Table3D {
  /**
   * @param {THREE.Scene} scene
   * @param {object} hooks { getPersona:(seat)=>persona, getPortrait:(seat)=>portrait }
   */
  constructor(scene, hooks = {}) {
    this.scene = scene;
    this.hooks = hooks;
    this.root = new THREE.Group();
    scene.add(this.root);

    /**
     * 挂上来的道具层(id → 道具)。**这是场景核心与游戏之间的唯一接口**,
     * 具体怎么加见 addPropLayer()。
     */
    this.props = new Map();

    // 宽屏拉长(见 stretchFor 的注释)。先按当前视口算一次,
    // 之后 resize 时由 layoutTable() 更新;桌子本身按人数建(见 _rebuildTable)。
    this.table = null;
    this.layoutTable(1.6);
    this._rebuildTable(6);

    this.seats = new Map();       // seat -> {char, rig, chair, marker, transform}
    this.buttonMesh = null;
  }

  /* ---------------- 道具层挂载点 ---------------- */

  /**
   * 把一个**道具层**挂到场景上 —— 新游戏加自己的道具就走这里。
   *
   * 分层的原因(b 期拆 3D 的直接动机):
   *   3D 场景本身是通用的(房间、桌椅、座位、立绘、相机、气泡),换游戏只是
   *   「桌上摆什么东西」不一样。以前牌/筹码/底池和桌椅写在同一份代码里,
   *   于是「再加一个桌游」等于把整个 3D 层复制一遍。
   *
   * 道具层就是下面这个对象(全部可选,只实现用得到的):
   *
   *   {
   *     id: 'poker',                    // 必填,唯一
   *     build(host),                   // 座位重建后调用:建自己的 mesh / 清掉旧的
   *     sync(view, ctx, host),          // 每帧(或每次状态变化)调用:按 view 摆放道具
   *     layout(host),                   // 视口/人数变了(可选)
   *     animate(now),                   // 自己的动画推进(可选;不实现就不动)
   *     stop(),                         // 立刻停掉动画(退出本局 / 重开,可选)
   *     destroy(),                      // 彻底拆掉(可选)
   *   }
   *
   * host 给的是**读场景用的最小接口**(不要绕过它直接摸 THREE 对象):
   *   · host.root       —— 道具挂哪个 Group 下(和座位同一个坐标系)
   *   · host.seats      —— Map<seat, {rig, char, transform:{angle,x,z}}>
   *   · host.feltPoint(angle, inset) —— 毡布上正对某角度、离边缘 inset 的那一点
   *   · host.count()    —— 当前座位数
   *   · host.feltAxes() —— 毡布椭圆半轴 {a, b}(摆中央道具时用来避让)
   *
   * ⚠️ 道具层**不许**改座位/桌椅本身:那些是 sceneCore 的地盘,道具只往上摆东西。
   *    要加新的通用能力(比如「毡布上多一块区域」),改 sceneCore 并在这里暴露给 host。
   *
   * @param {object} layer
   * @returns {object} 传进来的那一层(方便链式)
   */
  addPropLayer(layer) {
    const problems = checkPropLayer(layer);
    if (problems.length) {
      throw new Error(`道具层不合格:${problems.join('; ')}(契约见 src/ui3d/sceneCore/propLayer.js)`);
    }
    this.props.set(layer.id, layer);
    // 已经建过座位了(比如运行中才换道具):立刻补一次 build
    if (this.seats.size) layer.build?.(this.host);
    return layer;
  }

  /**
   * 交给道具层的宿主接口。每次取都新建一个薄对象 —— 它没有任何状态,
   * 图的就是道具层**拿不到本类的 this**(想改座位也改不了)。
   */
  get host() {
    const self = this;
    return {
      root: self.root,
      seats: self.seats,
      scene: self.scene,
      count: () => self.seats.size,
      feltPoint: (angle, inset) => self.feltPoint(angle, inset),
      feltAxes: () => ({
        a: (self.tableRA || RAIL_OUTER_R) - RAIL_IN,
        b: (self.tableRB || RAIL_OUTER_R) - RAIL_IN,
      }),
      /**
       * 让某个座位的指示器闪一下(道具落地时的反馈)。
       * 道具层只表达「谁的回合有反馈」,怎么亮是场景核心的事 ——
       * 这样换游戏时道具只需要调这个方法,不用知道指示器长什么样。
       */
      flashSeat: (seat, ms = 900) => {
        const s = self.seats.get(seat);
        if (s) s.winnerFlashUntil = performance.now() + ms;
      },
    };
  }

  /** 遍历道具层做一件事(内部用) */
  _eachProp(fn) {
    for (const layer of this.props.values()) {
      try { fn(layer); } catch (err) { console.error('[props]', layer?.id, err); }
    }
  }

  /* ---------------- 座位 ---------------- */

  /**
   * 按当前视口重算桌子的横向拉伸,并应用到桌子与座位圈。
   * 视口变化(旋转屏幕 / 拖窗口)时由屏幕层调用。
   *
   * @returns {boolean} 拉伸系数是否变了(变了就需要重建座位)
   */
  layoutTable(aspect) {
    const next = stretchFor(aspect);
    const changed = Math.abs(next - (this.stretchX || 1)) > 0.001;
    this.stretchX = next;
    this.aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.6;
    // 桌子本身在 buildSeats 里按「人数 + 视口」重建(调用方改完视口紧接着就会 buildSeats)
    return changed;
  }

  /**
   * 座位椭圆的**实际**半轴(含窄屏收拢)。
   *
   * 窄屏收拢以前按**像素宽度**判断(< 1440px 就收),结果手机横屏(852px 宽、
   * 宽高比 2.17,其实很宽)也被收了 45%,两侧的人全挤进桌子范围。
   * 相机取景是按宽高比算的,所以这里也只看宽高比:只有竖屏 / 方屏才收。
   */
  seatAxesEff(count) {
    const axes = seatAxes(count, this.stretchX || 1);
    const narrow = Math.max(0, Math.min(1, (1.3 - (this.aspect || 1.6)) / 0.6));
    return { a: axes.a * (1 - narrow * 0.35), b: axes.b };
  }

  /** 桌子(包边外沿)的椭圆半轴 = 座位椭圆往里收一圈 */
  tableAxes(count) {
    const { a, b } = this.seatAxesEff(count);
    return {
      ra: Math.max(MIN_RAIL_X, a - SEAT_GAP_X),
      rb: Math.max(RAIL_OUTER_R, b - SEAT_GAP_Z),
    };
  }

  /** 按人数重建桌面几何(座位圈变了,桌子跟着变) */
  _rebuildTable(count) {
    const { ra, rb } = this.tableAxes(count);
    const key = `${ra.toFixed(3)}:${rb.toFixed(3)}`;
    if (this._tableKey === key) return;
    this._tableKey = key;
    if (this.table) {
      this.root.remove(this.table);
      this.table.traverse((o) => { o.geometry?.dispose?.(); });
    }
    this.table = makeTable(ra, rb);
    this.root.add(this.table);
    this.tableRA = ra;
    this.tableRB = rb;
  }

  /**
   * 毡布上、正对某个座位、离毡布边缘 inset 的那一点。
   * 道具(底牌 / 下注筹码 / 筹码堆 / 按钮)都用它定位 —— 以前按「座位位置 × 比例」摆,
   * 座位一外扩,这些东西就跟着跑到桌子外面去了。
   */
  feltPoint(angle, inset) {
    const fa = (this.tableRA || RAIL_OUTER_R) - RAIL_IN;
    const fb = (this.tableRB || RAIL_OUTER_R) - RAIL_IN;
    const ex = Math.cos(angle) * fa, ez = Math.sin(angle) * fb;
    const len = Math.hypot(ex, ez) || 1;
    const k = Math.max(0, len - inset) / len;
    return { x: ex * k, z: ez * k };
  }

  /**
   * 最外侧座位离中轴有多远(含人物半宽)。
   * 供相机取景判断「横向装不装得下」—— 宽屏把桌子拉长之后,
   * 两侧的人会更靠外,相机必须相应后退,否则最外侧的人被裁掉。
   *
   * ⚠️ 余量要按**最宽的立绘**算。立绘是 billboard(正面朝相机),
   *    它在屏幕上的横向占位就是自己的宽度,不是旧 3D 角色那种窄躯干。
   *    实测世界宽度约 1.9(如 grok,长宽比 1.02),半宽 ≈ 0.95;
   *    第一版只留 1.15,结果最外侧两个人的手臂被画面边缘切掉。
   */
  outerHalfWidth() {
    // (以前读 this.plates —— Table3D 上根本没有这个字段,人数永远按 6 算)
    const n = Math.max(2, this.seats?.size || 6);
    const x = this.seatAxesEff(n).a;
    return x + 1.55;      // 半宽 0.95 + 两侧呼吸余量
  }

  seatTransform(seat, count) {
    // 荷官在 +z(靠画面这一侧);牌手全部放在对面半圈(角度 π ~ 2π,即 z < 0 那一侧),
    // 所以绝不会有人坐到相机旁边。人越多,半径放得越大,坐得越松散。
    //
    // ⚠️ 弧线**不能铺满 180°**。铺满时两端正好落在桌子的侧腰(z ≈ 0):
    //    相机是俯视的,那两个座位虽然几何上在桌子外面(x 超出桌宽),
    //    投影到屏幕上却落进绿色桌面范围内 —— 看起来就是「左右两边的人
    //    坐在桌子上」(用户反馈)。收窄到约 136° 之后,两端落到 z 明显为负的
    //    位置,所有人都在桌子**后方**,俯视下不再压到桌面。
    const ARC = 0.38;                       // 两端各收这么多弧度
    const a0 = Math.PI + ARC;
    const a1 = Math.PI * 2 - ARC;
    const k = spreadFor(count);
    // 按**弧长**等分,而不是按角度等分(见 seatAngleByArc 的注释)。
    // 半轴含窄屏收拢、宽屏拉长(见 seatAxesEff),桌子也按同一组半轴建,两者对得上。
    const axes = this.seatAxesEff(count);
    const angle = seatAngleByArc(seat, count, axes.a, axes.b, a0, a1);
    void k;

    return {
      angle,
      x: Math.cos(angle) * axes.a,
      z: Math.sin(angle) * axes.b,
    };
  }

  /**
   * 按人数重建座位(改人数时调用)。
   *
   * ⚠️ 座位重建之后**必须让道具层也重建**(见末尾的 _eachProp):道具是挂在
   *    座位周围的,座位位置变了、桌子形状变了,旧道具的位置就全错了。
   */
  buildSeats(count) {
    for (const s of this.seats.values()) {
      this.root.remove(s.rig || s.char);
      if (!s.rig && s.chair) this.root.remove(s.chair);
    }
    this.seats.clear();

    // 桌子跟着座位圈重建(人数 / 视口变了,桌子形状也要变)
    this._rebuildTable(count);

    this.buttonMesh = null;
    this.dealerKey = null;

    for (let seat = 0; seat < count; seat++) {
      // 立绘由**该座位用的模型**决定(见 ai/portraits.js 的映射规则),
      // 而不是由性格决定 —— 性格只影响 accent 色调和名字。
      const portrait = this.hooks.getPortrait?.(seat) || {};
      const char = createPortrait({
        charId: portrait.charId,
        accent: portrait.accent,
        state: 'idle',
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

      this.seats.set(seat, {
        char, rig, chair: chairGroup,
        ring: marker, marker, cone, coneMat, tagTex,     // ring 保留别名,兼容旧调用
        transform: t,
      });
    }

    // 座位建好了 → 让道具层按新座位重建自己的东西(扑克:底牌/下注/筹码堆/中央区)
    this._eachProp((layer) => layer.build?.(this.host));
  }

  /* ---------------- 同步引擎状态 ---------------- */

  /**
   * @param {object} view 引擎给这一侧看的局面
   * @param {object} ctx  { winnerSeats, thinkingSeat, ... }
   */
  update(view, ctx = {}) {
    const count = view.players.length;
    if (this.seats.size !== count) this.buildSeats(count);
    this.syncSeats(view, ctx);
  }

  /**
   * 还有多少道具动画在飞行中(测试与调试用)。
   * 有了它,测试就能「等动画真的结束」而不是猜一个固定时长 ——
   * 猜时长会在半空中截到东西,看起来像「动画没结束 / 位置不稳」。
   */
  __animAlive() {
    let n = 0;
    for (const layer of this.props.values()) n += (layer.animAlive?.() ?? 0) ? 1 : 0;
    return n;
  }

  /** 立刻停掉所有道具动画(退出本局 / 重开时用) */
  stopAnimations() {
    this._eachProp((layer) => layer.stop?.());
  }

  /**
   * 把引擎的结算数据送进道具层(扑克:筹码飞向赢家要 payouts 才能分主池/边池)。
   * 场景核心不解释这个对象,只是**转发** —— 别的游戏用不到就当没这一步。
   */
  setLastResult(result) {
    this._eachProp((layer) => layer.setLastResult?.(result));
  }

  /** 最近一次结算动画的信息(测试与调试用);多个道具层就取第一个有值的 */
  __settleInfo() {
    for (const layer of this.props.values()) {
      const info = layer.__settleInfo?.();
      if (info) return info;
    }
    return null;
  }

  /**
   * 头顶指示器:轮到谁行动谁就亮成金色并上下浮动;位置标签画在锥体的小牌子上。
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

    // 道具落到他那儿时的「赢家闪烁」:弹一下 + 发光更亮。
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
  syncSeats(view, ctx = {}) {
    // 庄家按钮
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
      const bp = this.feltPoint(t.angle, 0.95);
      this.buttonMesh.position.set(bp.x, 0.05, bp.z);
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
    }

    // 座位上的通用部分同步完了 → 道具层跟进(扑克:底牌 / 公共牌 / 底池 / 筹码)
    this._eachProp((layer) => layer.sync?.(view, ctx, this.host));
  }

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

  /**
   * 让**整个座位**一起正对相机:人物 + 椅子 + 头顶标记。
   *
   * ⚠️ 为什么必须连椅子一起转,而不能只转立绘:
   *    立绘是 billboard(正面朝**相机**),而椅子原先固定在「朝向**桌心**」的方位上。
   *    对正对相机的座位这两个方向一致,看不出问题;但对**两侧**的座位
   *    它们差将近 90° —— 椅子会被甩到人物旁边斜着支出去,
   *    看起来就是「人没坐在椅子上 + 椅子穿出人物」(用户反馈的错位/穿模)。
   *
   *    把整个 rig 转过来之后:rig 的 +z 指向相机,那么 rig 局部 -z
   *    正好是「人物背后」,而椅子本来就摆在局部 -z(= 后靠背方向),
   *    于是「坐在椅子上」由结构自洽保证,不再依赖两套方位碰巧一致。
   *
   * 由屏幕层的渲染循环**每帧**调用 —— 相机有呼吸动画,不是静止的。
   */
  faceSeats(camera) {
    if (!camera) return;
    for (const s of this.seats.values()) {
      if (!s.rig) continue;
      s.rig.getWorldPosition(_seatWorld);
      s.rig.rotation.y = Math.atan2(camera.position.x - _seatWorld.x, camera.position.z - _seatWorld.z);
    }
  }

  /** 让所有立绘正对相机。由屏幕层的渲染循环**每帧**调用 ——
      相机有呼吸动画,只在创建时算一次朝向会在动画中歪掉。 */
  facePortraits(camera) {
    for (const s of this.seats.values()) if (s.char) facePortrait(s.char, camera);
  }

  /**
   * 套用最新的立绘分配(不改座位结构)。
   * 用户在「模型」面板里换了某个座位的模型时用这个 —— 立刻换立绘,
   * 不用等重开一局。
   */
  applyPortraits() {
    for (const [seat, s] of this.seats) {
      const p = this.hooks.getPortrait?.(seat);
      if (p && s.char) setPortraitCharacter(s.char, p.charId, p.accent);
    }
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

export { feltTexture, woodTexture, SEAT_RX, SEAT_RZ, TABLE_R, RAIL_IN, RAIL_OUTER_R };
