/**
 * 3D 卡牌与筹码(含发牌 / 结算动画)。
 *
 * 牌面用 Canvas 2D 画好再当贴图贴到盒子的正面上 —— 比用几何体拼点数简单得多,
 * 而且字号/花色都能精确控制。牌的背面另画一张贴图。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 牌面图案 / 点数花色画法  → cardFaceTexture()
 *   · 牌背图案                → cardBackTexture()
 *   · 牌的大小                → CARD_SCALE / CARD_W / CARD_H
 *   · 筹码颜色                → CHIP_COLORS
 *   · 筹码大小                → CHIP_K(缩放直接烘进几何体,改它不用动别处)
 *   · 发牌动画手感(快慢/弧度) → flyCard() 的 dur / arc / lift
 *   · 结算动画(筹码飞向赢家) → flyChips() 的 maxGroups / gap / arc
 *   · 动画怎么插值            → updateCardAnimations()
 * ============================================================ */

import * as THREE from '../../vendor/three.module.js';

const SUITS = ['♠', '♥', '♦', '♣'];
const RED = new Set([1, 2]);
const RANK_TEXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export const rankOf = (id) => (id >> 2) + 2;
export const suitOf = (id) => id & 3;
const rankLabel = (id) => RANK_TEXT[rankOf(id)] || String(rankOf(id));

/* ------------------------------------------------------------ 牌面贴图 */

const PIPS = {
  2: [[0.5, 0.12], [0.5, 0.88]],
  3: [[0.5, 0.12], [0.5, 0.5], [0.5, 0.88]],
  4: [[0.28, 0.12], [0.72, 0.12], [0.28, 0.88], [0.72, 0.88]],
  5: [[0.28, 0.12], [0.72, 0.12], [0.5, 0.5], [0.28, 0.88], [0.72, 0.88]],
  6: [[0.28, 0.12], [0.72, 0.12], [0.28, 0.5], [0.72, 0.5], [0.28, 0.88], [0.72, 0.88]],
  7: [[0.28, 0.12], [0.72, 0.12], [0.5, 0.31], [0.28, 0.5], [0.72, 0.5], [0.28, 0.88], [0.72, 0.88]],
  8: [[0.28, 0.12], [0.72, 0.12], [0.5, 0.31], [0.28, 0.5], [0.72, 0.5], [0.5, 0.69], [0.28, 0.88], [0.72, 0.88]],
  9: [[0.28, 0.1], [0.72, 0.1], [0.28, 0.36], [0.72, 0.36], [0.5, 0.5], [0.28, 0.64], [0.72, 0.64], [0.28, 0.9], [0.72, 0.9]],
  10: [[0.28, 0.1], [0.72, 0.1], [0.5, 0.23], [0.28, 0.36], [0.72, 0.36], [0.28, 0.64], [0.72, 0.64], [0.5, 0.77], [0.28, 0.9], [0.72, 0.9]],
};

const W = 256, H = 356;
const faceCache = new Map();
let backTexture = null;

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  return c;
}

/** 一张牌的正脸贴图 */
export function cardFaceTexture(id) {
  if (faceCache.has(id)) return faceCache.get(id);
  const cv = makeCanvas();
  const g = cv.getContext('2d');
  const red = RED.has(suitOf(id));
  const suit = SUITS[suitOf(id)];
  const rank = rankLabel(id);
  const r = rankOf(id);

  // 底:米白 + 细边框
  g.fillStyle = '#fbfaf6';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(0,0,0,.18)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, W - 3, H - 3);
  g.fillStyle = red ? '#d63b2f' : '#1d1d1d';

  // 四角点数
  const corner = (x, y, flip) => {
    g.save();
    g.translate(x, y);
    if (flip) g.rotate(Math.PI);
    g.font = 'bold 62px "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText(rank, 0, 52);
    g.font = '52px "Segoe UI Symbol", Arial, sans-serif';
    g.fillText(suit, 0, 104);
    g.restore();
  };
  corner(38, 12, false);
  corner(W - 38, H - 12, true);

  // 中间:点数牌画 pip,人头牌画字母 + 花色,尖儿画大花色
  if (r <= 10) {
    g.font = '46px "Segoe UI Symbol", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const [px, py] of PIPS[r] || []) {
      g.save();
      g.translate(px * W, py * H);
      if (py > 0.55) g.rotate(Math.PI);
      g.fillText(suit, 0, 0);
      g.restore();
    }
  } else if (r === 14) {
    g.font = '132px "Segoe UI Symbol", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(suit, W / 2, H / 2 + 6);
  } else {
    // J/Q/K:画一个描边小画框 + 大字母 + 花色
    g.strokeStyle = red ? 'rgba(214,59,47,.5)' : 'rgba(29,29,29,.5)';
    g.lineWidth = 3;
    g.strokeRect(56, 66, W - 112, H - 132);
    g.fillStyle = red ? '#d63b2f' : '#1d1d1d';
    g.font = 'bold 116px Georgia, "Times New Roman", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(rank, W / 2, H / 2 - 6);
    g.font = '44px "Segoe UI Symbol", Arial, sans-serif';
    g.fillText(suit, W / 2, H / 2 + 66);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  faceCache.set(id, tex);
  return tex;
}

/** 牌背贴图(蓝色斜纹 + 金边) */
export function cardBackTexture() {
  if (backTexture) return backTexture;
  const cv = makeCanvas();
  const g = cv.getContext('2d');
  g.fillStyle = '#123c58';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(233,196,106,.75)';
  g.lineWidth = 8;
  g.strokeRect(14, 14, W - 28, H - 28);
  g.save();
  g.beginPath();
  g.rect(24, 24, W - 48, H - 48);
  g.clip();
  g.strokeStyle = 'rgba(233,196,106,.35)';
  g.lineWidth = 4;
  for (let i = -H; i < W + H; i += 26) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + H, H); g.stroke();
    g.beginPath(); g.moveTo(i + H, 0); g.lineTo(i, H); g.stroke();
  }
  g.restore();
  backTexture = new THREE.CanvasTexture(cv);
  backTexture.colorSpace = THREE.SRGBColorSpace;
  backTexture.anisotropy = 4;
  return backTexture;
}

/* ------------------------------------------------------------ 牌网格 */

const CARD_W = 0.62;
const CARD_H = 0.86;
const CARD_T = 0.012;
/**
 * 全局缩放系数。
 * 坐姿视角下牌要够大才看得清,但原来 1.28 时公共牌之间挤得太紧、也容易压到筹码,
 * 所以整体缩到 **70%**(1.28 → 0.896)。
 * 牌面的 Canvas 贴图分辨率不变,所以缩小后反而更清晰。
 */
export const CARD_SCALE = 1.28 * 0.7;
const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.85 });

/**
 * 建一张牌。
 * @param {number|null} id 牌 id,null 表示还没发
 * @param {'lg'|'md'|'sm'} size
 */
export function createCardMesh(id = null, size = 'md') {
  const scale = (size === 'lg' ? 1 : size === 'md' ? 0.9 : 0.7) * CARD_SCALE;
  const face = new THREE.MeshStandardMaterial({
    map: id === null ? cardBackTexture() : cardFaceTexture(id),
    roughness: 0.72,
  });
  const back = new THREE.MeshStandardMaterial({ map: cardBackTexture(), roughness: 0.78 });
  // BoxGeometry 材质顺序:+x -x +y -y +z -z,牌面朝 +z、背面朝 -z
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_W * scale, CARD_H * scale, CARD_T),
    [edgeMat, edgeMat, edgeMat, edgeMat, face, back],
  );
  mesh.castShadow = true;
  mesh.userData.size = scale;
  mesh.userData.cardId = id;
  return mesh;
}

/** 换牌面(翻牌/发新牌时用) */
export function setCardFace(mesh, id) {
  mesh.material[4].map = id === null ? cardBackTexture() : cardFaceTexture(id);
  mesh.material[4].needsUpdate = true;
  mesh.userData.cardId = id;
}

/* ------------------------------------------------------------ 发牌动画 */

/**
 * 通用的「一段动画」注册表。
 *
 * 为什么要自己写而不用 AnimationMixer:
 *   这里动画的东西是一堆普通 Mesh(不是骨骼模型),用 mixer 要先生成
 *   AnimationClip + 轨道绑定,写起来比直接插值还长。而这里的动画只有
 *   「位置 + 旋转 + 缩放从 A 到 B」,一个 t∈[0,1] 的插值就够了。
 *
 * 关键点:**已经结束的动画要从表里删掉**,否则每帧都会遍历一堆死条目,
 * 一局几十手下来会越积越多。
 */
const animations = [];

/**
 * 最近若干次飞牌的「真实起止点」。
 *
 * 为什么留这个:测试想验证「牌确实是从牌堆飞出来的」,但靠 rAF 采样去抓起点
 * 很不稳 —— 第一帧经常已经落在动画中段(曲线是 ease-out,起步快),
 * 于是「起点靠近牌堆」这条断言会随机失败。
 * 这里直接记下每次飞牌的起点/终点,测试读它就行,不依赖采样运气。
 * 只留最近 400 条,不会无限增长。
 */
const trail = [];
export function animationTrail() { return trail.slice(); }
export function clearAnimationTrail() { trail.length = 0; }

/**
 * 让一张牌从 from 飞到 to(带一点弧度,像真的从牌堆滑过去)。
 *
 * @param {object} opts
 *   mesh      要动的 Mesh
 *   from      {x,y,z} 起点(世界坐标)
 *   to        {x,y,z} 终点(世界坐标)
 *   rotFrom   {x,y,z} 起始旋转(可选,默认取 mesh 当前值)
 *   rotTo     {x,y,z} 结束旋转
 *   dur       时长(毫秒)
 *   delay     延迟(毫秒),用于「一张一张发」的错峰
 *   arc       弧线高度(米),0 表示直线
 *   onDone    结束回调
 * @returns {object} 动画句柄(可调 .cancel())
 */
export function flyCard(opts) {
  const {
    mesh, from, to, rotFrom, rotTo,
    dur = 420, delay = 0, arc = 0.55, onDone,
  } = opts;
  if (!mesh || !from || !to) return null;

  // 起点状态要**立刻**设好(位置 + 旋转),否则会看到牌先在终点摆好、
  // 然后「啪」地跳回起点再飞 —— 起手那一帧就露馅了。
  const rf = rotFrom || { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z };
  const rt = rotTo || { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z };
  mesh.position.set(from.x, from.y, from.z);
  mesh.rotation.set(rf.x, rf.y, rf.z);
  mesh.visible = true;

  const anim = {
    mesh, from, to, dur, delay, arc, onDone,
    rotFrom: rf, rotTo: rt,
    // 动画期间的缩放:从起点缩放过渡到目标缩放
    scaleFrom: mesh.scale.x || 1,
    scaleTo: 1,                                  // 牌落地就是原始尺寸
    t0: performance.now() + delay,
    // 飞行途中稍微放大一点,落地回到 1 —— 让「飞过来」更有存在感
    lift: 0.12,
    done: false,
  };
  animations.push(anim);
  // 记下真实起止点(测试用;见文件上方 animationTrail 的说明)。
  // ⚠️ from/to 是**各自父节点的局部坐标**,不同座位的坐标系不一样,
  //    不能拿它们互相比较、也不能跟世界坐标比。
  //    所以这里额外记一份世界坐标 —— 那才是「牌到底从哪儿飞到哪儿」的真相。
  const worldFrom = new THREE.Vector3(from.x, from.y, from.z);
  const worldTo = new THREE.Vector3(to.x, to.y, to.z);
  if (mesh.parent) {
    mesh.parent.updateMatrixWorld(true);
    mesh.parent.localToWorld(worldFrom);
    mesh.parent.localToWorld(worldTo);
  }
  trail.push({
    t: Date.now(),
    from: { x: from.x, y: from.y, z: from.z },
    to: { x: to.x, y: to.y, z: to.z },
    worldFrom: { x: worldFrom.x, y: worldFrom.y, z: worldFrom.z },
    worldTo: { x: worldTo.x, y: worldTo.y, z: worldTo.z },
    dur, delay, arc,
  });
  if (trail.length > 400) trail.splice(0, trail.length - 400);
  return {
    cancel: () => { anim.done = true; },
  };
}

/**
 * 推进所有动画。由渲染循环每帧调用一次。
 * @param {number} now performance.now()
 * @returns {number} 还在跑的数量(便于调试 / 测试断言)
 */
export function updateCardAnimations(now) {
  let alive = 0;
  for (const a of animations) {
    if (a.done) continue;
    const raw = (now - a.t0) / a.dur;
    if (raw < 0) { alive++; continue; }          // 还在延迟里,先等着
    const k = Math.min(1, raw);
    // ease-out:起步快、落地慢,像牌被滑过去后停住
    const e = 1 - Math.pow(1 - k, 2.6);

    const x = a.from.x + (a.to.x - a.from.x) * e;
    const z = a.from.z + (a.to.z - a.from.z) * e;
    // y 走一条抛物线:中途抬高 arc,首尾都落在目标高度上
    const baseY = a.from.y + (a.to.y - a.from.y) * e;
    const y = baseY + Math.sin(Math.PI * k) * a.arc;

    a.mesh.position.set(x, y, z);
    a.mesh.rotation.set(
      a.rotFrom.x + (a.rotTo.x - a.rotFrom.x) * e,
      a.rotFrom.y + (a.rotTo.y - a.rotFrom.y) * e,
      a.rotFrom.z + (a.rotTo.z - a.rotFrom.z) * e,
    );
    // 飞行中轻微放大,落地精确收回到目标缩放
    // (牌固定回到 1;筹码可以设 scaleTo<1,做出「被收走」的感觉)
    const scaleTo = a.scaleTo !== undefined ? a.scaleTo : 1;
    const lift = 1 + a.lift * Math.sin(Math.PI * k);
    a.mesh.scale.setScalar((a.scaleFrom + (scaleTo - a.scaleFrom) * e) * lift);

    if (k >= 1) {
      a.mesh.position.set(a.to.x, a.to.y, a.to.z);
      a.mesh.rotation.set(a.rotTo.x, a.rotTo.y, a.rotTo.z);
      a.mesh.scale.setScalar(scaleTo);
      a.done = true;
      // 筹码用 onArrive(落地点亮赢家),牌用 onDone
      try { a.onDone?.(); } catch { /* 回调出错不影响渲染 */ }
      try { a.onArrive?.(); } catch { /* 回调出错不影响渲染 */ }
      continue;
    }
    alive++;
  }
  // 清掉已结束的,避免每帧遍历越来越长的死列表
  for (let i = animations.length - 1; i >= 0; i--) {
    if (animations[i].done) animations.splice(i, 1);
  }
  return alive;
}

/** 还有没有动画在跑(界面用它决定要不要持续渲染) */
export function hasCardAnimations() {
  return animations.length > 0;
}

/**
 * 筹码飞行动画:把一堆筹码从 A 送到 B。
 *
 * 与「飞牌」共用同一套插值(animations 表),区别只在观感参数:
 *   · 筹码**不旋转**(它本来就是圆的,转起来看不出效果还容易看着晃);
 *   · 弧线更低、时长更短 —— 筹码是「推过去」的,不是「抛过去」的;
 *   · 落到目标后可以缩掉(收进赢家的筹码堆里)。
 *
 * @param {object} opts
 *   mesh      筹码组(或任意 Object3D)
 *   from/to   {x,y,z},**父节点的局部坐标**
 *   dur delay arc
 *   shrinkTo  落点缩放(默认 1;设 0.4 会有「被收走」的感觉)
 *   onArrive  落到终点时触发一次(用来点亮赢家 / 涨数字)
 *   meta      原样带进 trail 的附加信息(测试用)
 * @returns {object|null}
 */
export function flyChipMesh(opts) {
  const {
    mesh, from, to, dur = 460, delay = 0, arc = 0.42,
    shrinkTo = 1, onArrive, meta,
  } = opts;
  if (!mesh || !from || !to) return null;

  mesh.position.set(from.x, from.y, from.z);
  mesh.visible = true;
  const rot = { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z };

  const anim = {
    mesh, from, to, dur, delay, arc, onArrive, meta, kind: 'chip',
    rotFrom: rot,
    rotTo: rot,                    // 不转
    scaleFrom: mesh.scale.x || 1,
    scaleTo: shrinkTo,
    lift: 0.06,                    // 筹码只要一点点起伏,别像抛硬币
    t0: performance.now() + delay,
    done: false,
  };
  animations.push(anim);
  trail.push({
    t: Date.now(), kind: 'chip',
    from: { ...from }, to: { ...to },
    // worldFrom/worldTo:调用方(flyChips)传的是世界坐标,所以原样记一份 ——
    // 跟飞牌那边保持一致,测试里就能用同一套方式校验「从哪飞到哪」。
    worldFrom: (meta && meta.worldFrom) || { x: from.x, y: from.y, z: from.z },
    worldTo: (meta && meta.worldTo) || { x: to.x, y: to.y, z: to.z },
    dur, delay, arc, meta: meta || null,
  });
  if (trail.length > 400) trail.splice(0, trail.length - 400);
  return { cancel: () => { anim.done = true; }, meta };
}

/**
 * 把一笔钱「飞」给赢家:按面值分批,大额先走。
 *
 * 为什么分批而不是飞一个整块:
 *   一堆筹码一次性飞过去看不出金额差别;按面值分批(1000 的先飞、1 的后飞)
 *   才有「一大笔钱涌过来」的感觉,而且错峰本身也好看。
 *   批次数量有上限(默认 7),不然大底池会飞出几十批、又慢又乱。
 *
 * 注意:**纯视觉**。筹码只是从底池位置飞到赢家位置然后销毁,
 * 真正的筹码数由引擎结算(引擎不会因为这里出错而少给钱)。
 *
 * @param {object} opts
 *   parent     飞行期间筹码挂在哪个父节点下(世界坐标都一致的容器)
 *   from/to    {x,y,z} 世界坐标
 *   amount     金额(决定分成几批、每批什么面值)
 *   maxGroups  最多飞几批
 *   baseDelay  起始延迟(多个赢家之间错开用)
 *   gap        批次间隔
 *   onArrive   每批落地回调
 *   onDone     全部落地回调
 *   label      记进 trail 的标签(测试用)
 * @returns {{groups:number, total:number, breakdown:Array}|null}
 */
export function flyChips(opts) {
  const {
    parent, from, to, amount, maxGroups = 7, baseDelay = 0, gap = 120,
    onArrive, onDone, label, shrinkTo = 0.45,
  } = opts;
  if (!parent || !from || !to) return null;
  const total = Math.max(0, Math.round(Number(amount) || 0));
  if (total <= 0) return null;

  // 面值分批:把金额拆成合适的筹码,再分成几批。
  //
  // 这里是**纯视觉**,不必精确到每一块钱,但也不能差太多 ——
  // 早先按「均分到 N 批」取单一面值,4120 只飞了 1500(偏差 64%),看着就不对。
  // 做法:先用 chipBreakdown 拆出真实的面值序列,再按「每批最多 N 个」分批。
  const groups = [];
  const tiers = chipBreakdown(total, 60);
  const PER_GROUP = 4;                       // 每批最多几个筹码
  for (let i = 0; i < tiers.length && groups.length < maxGroups; i += PER_GROUP) {
    const slice = tiers.slice(i, i + PER_GROUP);
    // 一批里用一个面值(取这批最小的那个,保证堆得下)
    const tier = slice[slice.length - 1];
    groups.push({ v: tier.v, n: slice.length, top: tier.top, side: tier.side });
  }

  const results = [];
  groups.forEach((g, i) => {
    const grp = new THREE.Group();
    for (let k = 0; k < g.n; k++) {
      const m = new THREE.Mesh(chipGeo, new THREE.MeshStandardMaterial({
        color: g.top, roughness: 0.45, metalness: 0.1,
      }));
      m.position.y = k * CHIP_STEP;
      const edge = new THREE.Mesh(chipEdgeGeo, new THREE.MeshStandardMaterial({
        color: g.side, roughness: 0.6,
      }));
      edge.position.y = k * CHIP_STEP - 0.014 * CHIP_K;
      grp.add(edge, m);
    }
    // 稍微散开一点,像一叠被推过去
    grp.position.set(from.x, from.y, from.z);
    parent.add(grp);
    const isLast = i === groups.length - 1;
    const a = flyChipMesh({
      mesh: grp,
      from, to,
      dur: 430,
      delay: baseDelay + i * gap,
      arc: 0.3 + i * 0.02,
      shrinkTo,
      meta: {
        label: label || '', tier: g.v, n: g.n, index: i, total,
        // 世界坐标原样带上:trail 里要用它做「从哪飞到哪」的校验
        worldFrom: { x: from.x, y: from.y, z: from.z },
        worldTo: { x: to.x, y: to.y, z: to.z },
      },
      onArrive: () => {
        // 落地后把它从场景里摘掉 —— 真正的筹码由 _syncChips 按引擎数据重建,
        // 留着会跟真实筹码堆重叠成两层。
        setTimeout(() => { try { parent.remove(grp); } catch { /* 已移除 */ } }, 90);
        try { onArrive?.(g, i); } catch { /* 回调出错不影响渲染 */ }
        if (isLast) { try { onDone?.(); } catch { /* 忽略 */ } }
      },
    });
    if (a) results.push(a);
  });

  return { groups: groups.length, total, breakdown: groups, shown: groups.reduce((s, g) => s + g.v * g.n, 0) };
}

/** 立刻结束所有动画(退出本局 / 重开时用,免得残留动画乱飞) */
export function clearCardAnimations() {
  for (const a of animations) a.done = true;
  animations.length = 0;
}

/** 把动画轨迹暴露到全局,方便测试读取(浏览器/Electron 都可用) */
if (typeof window !== 'undefined') {
  window.__cardAnimTrail = animationTrail;
}

/* ------------------------------------------------------------ 筹码 */

const CHIP_COLORS = [
  { v: 1000, top: 0xe9c46a, side: 0xa9790a },
  { v: 500, top: 0x9b6ae0, side: 0x52279c },
  { v: 100, top: 0x3a4048, side: 0x14181d },
  { v: 25, top: 0x38c47f, side: 0x15744a },
  { v: 5, top: 0xe2574c, side: 0xb52f24 },
  { v: 1, top: 0xf2f2f0, side: 0xc9c9c9 },
];

export function chipBreakdown(amount, max = 12) {
  let rest = Math.max(0, Math.round(amount));
  const out = [];
  for (const t of CHIP_COLORS) {
    while (rest >= t.v && out.length < max) { out.push(t); rest -= t.v; }
    if (out.length >= max) break;
  }
  if (!out.length && amount > 0) out.push(CHIP_COLORS[CHIP_COLORS.length - 1]);
  return out;
}

/**
 * 筹码的几何尺寸。
 * 原来半径 0.19、厚 0.055 —— 在坐姿视角下筹码堆比牌还抢眼,所以整体缩到 30%。
 * 缩放直接烘进几何体和堆叠间距里,table3d 里那些 «乘 scale» 的偏移量不用动。
 */
const CHIP_K = 0.3;
const chipGeo = new THREE.CylinderGeometry(0.19 * CHIP_K, 0.19 * CHIP_K, 0.055 * CHIP_K, 20);
const chipEdgeGeo = new THREE.CylinderGeometry(0.196 * CHIP_K, 0.196 * CHIP_K, 0.03 * CHIP_K, 20);
const CHIP_STEP = 0.058 * CHIP_K;          // 每层的高度间距

/** 一堆筹码:按面值分层码起来 */
export function createChipStack(amount, { scale = 1 } = {}) {
  const group = new THREE.Group();
  const tiers = chipBreakdown(amount);
  tiers.forEach((t, i) => {
    const m = new THREE.Mesh(chipGeo, new THREE.MeshStandardMaterial({
      color: t.top, roughness: 0.45, metalness: 0.1,
    }));
    m.position.y = i * CHIP_STEP;
    m.castShadow = true;
    const edge = new THREE.Mesh(chipEdgeGeo, new THREE.MeshStandardMaterial({
      color: t.side, roughness: 0.6,
    }));
    edge.position.y = i * CHIP_STEP - 0.014 * CHIP_K;
    group.add(edge, m);
  });
  group.scale.setScalar(scale);
  group.userData.amount = amount;
  return group;
}

/** 把一堆筹码分散摆开(像真人下注那样不整齐) */
export function scatterChips(group, spread = 0.16) {
  group.children.forEach((c, i) => {
    const k = Math.floor(i / 2);
    c.position.x += Math.cos(i * 2.4 + k) * spread;
    c.position.z += Math.sin(i * 1.7 + k) * spread;
  });
  return group;
}

export { CARD_W, CARD_H, CHIP_COLORS };
