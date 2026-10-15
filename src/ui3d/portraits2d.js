/**
 * 2D 立绘:把原来的程序化 3D 角色换成 crosspet 的角色立绘。
 *
 * 素材许可:**CC BY-NC-SA 4.0**(署名 / 非商业 / 相同方式共享),
 * 与仓库根的 MIT 不同,详见 assets/portraits/SOURCES.md 与 LICENSE.md。
 *
 * ── 设计要点 ───────────────────────────────────────────────
 *
 * 1. **几何体同步建好,只有纹理异步。**
 *    table3d 在创建角色后**立刻**用 `Box3.setFromObject(char).max.y` 量头顶
 *    高度来摆思考气泡/回合标记(见 table3d.js 的 seatAnchors / marker)。
 *    如果平面要等图片 onload 才知道尺寸,首帧量出来的是 0,气泡会飞到脚下。
 *    所以宽高从 assets/portraits/manifest.js **同步**读到(取图时就记了尺寸),
 *    平面可以马上按正确长宽比建出来。
 *
 * 2. **尺寸对齐旧角色,不改 table3d 的定位。**
 *    实测旧的程序化角色本地高度 2.579、底面 y≈-0.05,
 *    table3d 用 `char.scale.setScalar(CHAR_SCALE=0.9)` 缩放 → 世界高度 2.32。
 *    这里按**同样的本地尺寸**建平面,于是所有位置/缩放代码一行都不用动。
 *
 * 3. **每帧朝向相机。**
 *    相机有呼吸动画(sceneFull 每帧微调高度后 lookAt),不是完全静止,
 *    所以不能只在创建时算一次朝向。
 *
 * 4. **脚下加一圈 accent 色。**
 *    同一个模型被多个座位用到时,立绘长得一样,靠这圈颜色 + 性格名区分。
 */

import * as THREE from '../../vendor/three.module.js';
import CROSSPET from '../../assets/portraits/manifest.js';
import MANUAL from '../../assets/portraits/manual.js';
import { GENERIC_CHAR } from '../ai/portraits.js';

/**
 * 两份清单合并:
 *   · manifest.js —— 从 crosspet 取的 6 套(工具:fetchportraits.mjs)
 *   · manual.js   —— 手工加进来的(工具:prepmanualportraits.mjs)
 * 分开维护是因为两个脚本各写各的,合一个文件会互相覆盖。
 * manual.js 由 prepmanualportraits.mjs 生成,已随仓库提交;
 * buildweb 会校验它在不在,缺了在构建时就报错而不是运行时白屏。
 */
const MANIFEST = {
  characters: { ...(CROSSPET.characters || {}), ...(MANUAL.characters || {}) },
};

/**
 * 立绘的本地高度。
 *
 * ⚠️ 这里**不能**照抄旧 3D 角色的高度(2.579)。原因是长宽比差很多:
 *   · 旧的程序化角色 宽/高 ≈ 1.247/2.579 = 0.48(有肩膀和胳膊,但整体是竖的)
 *   · crosspet 立绘是**紧贴人物轮廓裁切**的 chibi,宽/高 ≈ 0.89
 * 同样高度下立绘要宽出 1.85 倍,实测最外侧两个座位会被画面边缘切掉。
 *
 * 所以按**宽度**定尺寸:让世界宽度落在旧角色的 1.12 附近(略宽一点可接受),
 * 反推出高度 ≈ 1.86 / 0.9 = 2.07。人物比原来矮一些,
 * 但每个人的横向占位和旧版接近,座位间距、牌桌遮挡关系都不用重调。
 *
 * (世界高度 = 本值 × CHAR_SCALE;宽度 = 世界高度 × 图片长宽比)
 */
export const PORTRAIT_LOCAL_HEIGHT = 1.86;
export const PORTRAIT_BASE_Y = -0.05;

/**
 * 座位角色的世界缩放 —— 与旧 3D 角色**保持同一个值**,
 * 这样 table3d 里 `char.scale.setScalar(CHAR_SCALE * …)` 那几行不用改动。
 */
export const CHAR_SCALE = 0.9;

/** 通用占位立绘的画布尺寸(自己画的,比例固定) */
const GENERIC = { w: 520, h: 640 };

/**
 * 画「通用占位立绘」:一个中性的兜帽剪影 + 面罩 + 金色胸章。
 *
 * 为什么用 canvas 画而不是放一张 SVG:
 *   实测 SVG **不能**当 WebGL 纹理用 —— TextureLoader 走 <img>,SVG 进
 *   WebGL 在 file:// 下拿不到 image.width(结果是立绘全白),
 *   而 WebP 是好的。与其为占位图单独引一套光栅化流程,
 *   不如直接用 canvas 画 —— 这也正是本项目一贯的做法
 *   (牌面、筹码、毡布全是 canvas 程序生成的,见 cards3d.js)。
 *
 * 为什么是「中性剪影」而不是拿 crosspet 的 egg-* 图:
 *   那几套是特定厂商的彩蛋角色,拿来代表「未知模型」等于冒用别人的形象。
 */
function drawGenericPortrait(state) {
  const w = GENERIC.w, h = GENERIC.h;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return null;

  const CLOAK = '#3b4759', CLOAK_DK = '#2a3240', HOOD = '#46536a';
  const FACE = '#161c26', GOLD = '#e9c46a', GOLD_DK = '#c9a24a';
  const cx = w / 2;

  const rr = (x, y, ww, hh, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + ww, y, x + ww, y + hh, r);
    g.arcTo(x + ww, y + hh, x, y + hh, r);
    g.arcTo(x, y + hh, x, y, r);
    g.arcTo(x, y, x + ww, y, r);
    g.closePath();
  };

  // 脚下投影
  g.save();
  g.globalAlpha = 0.28; g.fillStyle = '#000';
  g.beginPath(); g.ellipse(cx, h - 24, 150, 20, 0, 0, Math.PI * 2); g.fill();
  g.restore();

  // 斗篷
  const grad = g.createLinearGradient(0, 250, 0, h);
  grad.addColorStop(0, HOOD); grad.addColorStop(1, CLOAK_DK);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(cx, 250);
  g.bezierCurveTo(cx - 118, 250, cx - 168, 324, cx - 182, 428);
  g.bezierCurveTo(cx - 192, 502, cx - 188, 558, cx - 188, 616);
  g.lineTo(cx + 188, 616);
  g.bezierCurveTo(cx + 188, 558, cx + 192, 502, cx + 182, 428);
  g.bezierCurveTo(cx + 168, 324, cx + 118, 250, cx, 250);
  g.closePath();
  g.fill();
  g.strokeStyle = CLOAK_DK; g.lineWidth = 6; g.stroke();

  // 斗篷内衬高光
  g.save();
  g.globalAlpha = 0.16; g.strokeStyle = GOLD; g.lineWidth = 3;
  g.beginPath();
  g.moveTo(cx - 146, 616);
  g.bezierCurveTo(cx - 140, 500, cx - 100, 300, cx, 268);
  g.bezierCurveTo(cx + 100, 300, cx + 140, 500, cx + 146, 616);
  g.stroke();
  g.restore();

  // 兜帽
  g.fillStyle = HOOD;
  g.beginPath();
  g.moveTo(cx, 96);
  g.bezierCurveTo(cx - 74, 96, cx - 122, 142, cx - 126, 204);
  g.bezierCurveTo(cx - 129, 248, cx - 116, 278, cx - 100, 296);
  g.bezierCurveTo(cx - 94, 224, cx - 56, 182, cx, 182);
  g.bezierCurveTo(cx + 56, 182, cx + 94, 224, cx + 100, 296);
  g.bezierCurveTo(cx + 116, 278, cx + 129, 248, cx + 126, 204);
  g.bezierCurveTo(cx + 122, 142, cx + 74, 96, cx, 96);
  g.closePath();
  g.fill();
  g.strokeStyle = CLOAK_DK; g.lineWidth = 6; g.stroke();

  // 脸部阴影
  g.fillStyle = FACE;
  g.beginPath(); g.ellipse(cx, 248, 96, 104, 0, 0, Math.PI * 2); g.fill();

  // —— 五官按状态变 ——
  const eyeL = cx - 48, eyeR = cx + 48, eyeY = 232;
  g.strokeStyle = GOLD; g.fillStyle = GOLD; g.lineCap = 'round';
  if (state === 'thinking') {
    g.beginPath(); g.ellipse(eyeL, eyeY, 17, 21, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(eyeR, eyeY, 17, 21, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = FACE;
    g.beginPath(); g.ellipse(eyeL + 6, eyeY - 4, 7, 11, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(eyeR + 6, eyeY - 4, 7, 11, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = GOLD_DK; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx - 10, 280); g.lineTo(cx + 10, 280); g.stroke();
  } else if (state === 'happy') {
    g.lineWidth = 7;
    g.beginPath(); g.moveTo(eyeL - 17, eyeY + 6); g.quadraticCurveTo(eyeL, eyeY - 16, eyeL + 17, eyeY + 6); g.stroke();
    g.beginPath(); g.moveTo(eyeR - 17, eyeY + 6); g.quadraticCurveTo(eyeR, eyeY - 16, eyeR + 17, eyeY + 6); g.stroke();
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(cx - 16, 272); g.quadraticCurveTo(cx, 292, cx + 16, 272); g.stroke();
  } else if (state === 'oops') {
    g.lineWidth = 7;
    for (const [ex, ey] of [[eyeL, eyeY - 2], [eyeR, eyeY - 2]]) {
      g.beginPath(); g.moveTo(ex - 15, ey - 15); g.lineTo(ex + 15, ey + 15); g.stroke();
      g.beginPath(); g.moveTo(ex + 15, ey - 15); g.lineTo(ex - 15, ey + 15); g.stroke();
    }
    g.strokeStyle = GOLD_DK; g.lineWidth = 5;
    g.beginPath(); g.moveTo(cx - 14, 292); g.quadraticCurveTo(cx, 276, cx + 14, 292); g.stroke();
    // 汗滴
    g.save(); g.globalAlpha = 0.85; g.fillStyle = '#7fb2e5';
    g.beginPath(); g.moveTo(cx + 132, 150);
    g.quadraticCurveTo(cx + 148, 176, cx + 148, 188);
    g.arc(cx + 132, 188, 16, 0, Math.PI); g.closePath(); g.fill(); g.restore();
  } else if (state === 'surprised') {
    g.fillStyle = '#f4f7fb';
    g.beginPath(); g.ellipse(eyeL, eyeY, 21, 26, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(eyeR, eyeY, 21, 26, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = FACE;
    g.beginPath(); g.ellipse(eyeL, eyeY, 9, 13, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(eyeR, eyeY, 9, 13, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = FACE; g.strokeStyle = GOLD_DK; g.lineWidth = 4;
    g.beginPath(); g.ellipse(cx, 284, 12, 15, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  } else {
    g.beginPath(); g.ellipse(eyeL, eyeY, 17, 21, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(eyeR, eyeY, 17, 21, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = FACE;
    g.beginPath(); g.ellipse(eyeL, eyeY, 7, 11, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(eyeR, eyeY, 7, 11, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = GOLD_DK; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx - 8, 278); g.quadraticCurveTo(cx, 284, cx + 8, 278); g.stroke();
  }

  // 面罩 / 围巾
  g.save();
  g.globalAlpha = 0.95; g.fillStyle = CLOAK_DK;
  g.beginPath();
  g.moveTo(cx - 96, 306); g.quadraticCurveTo(cx, 350, cx + 96, 306);
  g.lineTo(cx + 86, 346); g.quadraticCurveTo(cx, 382, cx - 86, 346);
  g.closePath(); g.fill();
  g.restore();

  // 胸口徽章
  g.fillStyle = CLOAK_DK;
  g.beginPath(); g.arc(cx, 412, 34, 0, Math.PI * 2); g.fill();
  g.strokeStyle = GOLD; g.lineWidth = 4; g.stroke();
  const glyph = { thinking: '…', happy: '!', oops: '×', surprised: '!' }[state] || '?';
  g.fillStyle = GOLD;
  g.font = '700 40px ui-monospace, Consolas, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(glyph, cx, 414);

  // 状态点缀
  g.fillStyle = GOLD;
  const star = (sx, sy, r) => {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i;
      const rad = i % 2 === 0 ? r : r * 0.36;
      const px = sx + Math.cos(a) * rad, py = sy + Math.sin(a) * rad;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
  };
  if (state === 'surprised' || state === 'happy') {
    g.save(); g.globalAlpha = state === 'happy' ? 0.75 : 0.95;
    star(cx + 170, 108, 20); star(cx - 156, 128, 15);
    g.restore();
  }
  if (state === 'thinking') {
    g.save(); g.globalAlpha = 0.85;
    for (const [dx, dy, r, a] of [[132, 150, 9, 0.45], [156, 118, 13, 0.65], [186, 76, 20, 0.85]]) {
      g.globalAlpha = a;
      g.beginPath(); g.arc(cx + dx, dy, r, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }

  return cv;
}

/** 通用占位纹理缓存 */
const genericCache = new Map();

function getGenericTexture(state) {
  if (genericCache.has(state)) return genericCache.get(state);
  const cv = typeof document !== 'undefined' ? drawGenericPortrait(state) : null;
  const tex = cv ? new THREE.CanvasTexture(cv) : null;
  if (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
  }
  genericCache.set(state, tex);
  return tex;
}

/** 游戏里的姿态 → 立绘状态 */
const POSE_TO_STATE = {
  idle: 'idle',
  think: 'thinking',
  win: 'happy',
  fold: 'oops',
  allin: 'surprised',
};

/** 纹理缓存:'charId/state' → THREE.Texture(加载失败时存 null,避免反复请求) */
const texCache = new Map();
/**
 * 正在加载中的纹理 → 等待回调列表。
 *
 * ⚠️ 这里**必须**收集回调,不能只是「加载中就返回 null」。
 *    踩过的坑:开局前 preloadPortraits() 会先把 idle 图挂上加载,
 *    紧接着 createPortrait() 再要同一张图 —— 命中「加载中」分支直接返回 null,
 *    回调没人登记,于是图加载完了也没人去贴到材质上,
 *    结果就是**人物全部空白**(测试里 6 个座位贴图全无,而缓存里图明明都在)。
 */
const pending = new Map();

const loader = new THREE.TextureLoader();
// file:// 下不要带 crossOrigin 属性 —— 带上会让 Electron 直接拒绝加载本地图片
loader.setCrossOrigin('');
loader.setPath('');

/** 立绘资源相对本文件的路径(src/ui3d/ → ../../assets/portraits/) */
const BASE = '../../assets/portraits';

/**
 * 解析某个角色某个状态该用哪张图。
 *
 * ⚠️ 返回的 `state` 是**实际要加载的状态**,不一定等于传入的。
 *    手工素材(manual.js)每个角色只有一张 idle —— 切到 thinking/win 时
 *    必须回退到 idle 去加载。早期实现只回退了「尺寸」没回退「文件名」,
 *    结果去请求 qwen/thinking.webp(不存在)→ 加载失败 → 立绘变空白。
 */
function stateMeta(charId, state) {
  // 通用占位是 canvas 现画的,没有文件
  if (charId === GENERIC_CHAR) return { w: GENERIC.w, h: GENERIC.h, generic: true, state };
  const c = MANIFEST.characters?.[charId];
  const st = c?.states?.[state];
  if (st?.w && st?.h) return { w: st.w, h: st.h, dir: charId, state };
  const idle = c?.states?.idle;
  if (idle?.w && idle?.h) return { w: idle.w, h: idle.h, dir: charId, state: 'idle', fellBack: true };
  return { w: GENERIC.w, h: GENERIC.h, generic: true, state };
}

/** 纹理(异步)。返回 null 表示还没加载好或加载失败,调用方保持现状即可。 */
function getTexture(dir, state, onReady) {
  const key = `${dir}/${state}.webp`;
  if (texCache.has(key)) return texCache.get(key);
  // 已经在加载:把回调挂上去,加载完一起通知(不能只返回 null,见 pending 的注释)
  if (pending.has(key)) {
    if (onReady) pending.get(key).push(onReady);
    return null;
  }

  const waiters = onReady ? [onReady] : [];
  pending.set(key, waiters);

  const settle = (tex) => {
    texCache.set(key, tex);
    const cbs = pending.get(key) || [];
    pending.delete(key);
    for (const cb of cbs) { try { cb(); } catch { /* 回调出错不影响其它座位 */ } }
  };

  loader.load(
    `${BASE}/${dir}/${state}.webp`,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 4;
      settle(tex);
    },
    undefined,
    // 失败也 settle:记成 null 以后不再重复请求同一张缺失的图
    () => settle(null),
  );
  return null;
}

/** 提前把常用状态的热一下,减少开局时的空白 */
export function preloadPortraits(charIds, states = ['idle', 'thinking']) {
  for (const c of charIds) for (const s of states) getTexture(c, s);
}

/**
 * 建一个立绘(替代原来的 createCharacter)。
 *
 * @param {{charId?:string, state?:string, accent?:string}} opts
 * @returns {THREE.Group} 带 userData.portrait,可被 setCharacterPose 切状态
 */
export function createPortrait({ charId = GENERIC_CHAR, state = 'idle', accent = '#e9c46a' } = {}) {
  const group = new THREE.Group();

  /* 平面:按清单里的尺寸算长宽比,底面贴到 PORTRAIT_BASE_Y */
  const meta = stateMeta(charId, state);
  const height = PORTRAIT_LOCAL_HEIGHT;
  const width = height * (meta.w / meta.h);
  const geo = new THREE.PlaneGeometry(width, height);
  geo.translate(0, height / 2 + PORTRAIT_BASE_Y, 0);   // 让底面落在 BASE_Y

  const mat = new THREE.MeshBasicMaterial({
    map: null,
    transparent: true,
    // alphaTest 而不是纯透明排序:立绘是硬边抠图,alphaTest 能让它
    // 正确参与深度测试,不会被桌子/筹码按错误的顺序盖住。
    alphaTest: 0.08,
    depthWrite: true,
    side: THREE.FrontSide,
    toneMapped: false,
  });
  const plane = new THREE.Mesh(geo, mat);
  plane.castShadow = false;
  plane.receiveShadow = false;
  group.add(plane);

  /* 脚下的 accent 圈:同款立绘靠它区分。
     做粗一点、亮一点、往前挪一点 —— 太细会被椅子挡住,等于没做
     (第一版 0.30~0.42 + 0.55 不透明度,实拍几乎看不见)。 */
  const ringGeo = new THREE.RingGeometry(0.34, 0.56, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(accent), transparent: true, opacity: 0.85,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.set(0, PORTRAIT_BASE_Y + 0.012, 0.12);   // 略往桌子方向,避开椅背
  ring.renderOrder = 2;
  group.add(ring);

  group.userData.portrait = { charId, state, accent, plane, ring, mat };
  group.userData.head = {};        // 兼容旧字段:原来的角色用它做「思考时歪头」
  group.userData.bodyGroup = {};

  applyTexture(group, charId, state);
  return group;
}

/** 把纹理贴上去;还没加载好就留空(平面尺寸已经在,不影响布局) */
function applyTexture(group, charId, state) {
  const p = group.userData.portrait;
  if (!p) return;
  const meta = stateMeta(charId, state);
  if (meta.generic) {
    // 占位是 canvas 现画的,同步就能拿到
    p.mat.map = getGenericTexture(state);
    p.mat.needsUpdate = true;
    return;
  }
  // 注意用 meta.state(实际要加载的状态),不是传入的 state —— 见 stateMeta 的注释。
  // 回调里用 p.charId / p.state 而不是闭包里的值:加载期间状态可能已经变了。
  const tex = getTexture(meta.dir, meta.state, () => applyTexture(group, p.charId, p.state));
  if (tex) {
    p.mat.map = tex;
    p.mat.needsUpdate = true;
  }
}

/**
 * 切换立绘状态。签名与旧的 setCharacterPose 一致,所以 table3d 那边
 * 只需要把 import 换掉。
 */
export function setCharacterPose(obj, pose = 'idle') {
  const p = obj?.userData?.portrait;
  if (!p) return;
  const state = POSE_TO_STATE[pose] || 'idle';
  if (p.state === state) return;
  p.state = state;
  applyTexture(obj, p.charId, state);
}

/** 换角色(座位分配的模型变了时用) */
export function setPortraitCharacter(obj, charId, accent) {
  const p = obj?.userData?.portrait;
  if (!p || !charId) return;
  if (accent) {
    p.accent = accent;
    p.ring.material.color.set(accent);
  }
  if (p.charId === charId) return;
  p.charId = charId;
  applyTexture(obj, charId, p.state);
}

/**
 * 让立绘正对相机(每帧调用)。
 *
 * 立绘是挂在 rig 下的,而 rig 自己带着「朝向桌心」的旋转,所以不能直接把
 * rotation.y 设成目标世界角度 —— 要把父级的 yaw 减掉。
 * 这里只绕 Y 转,不做俯仰:立绘是站着的,跟着相机俯仰会像躺着。
 */
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _wp = new THREE.Vector3();

export function facePortrait(obj, camera) {
  const p = obj?.userData?.portrait;
  if (!p || !camera) return;
  obj.getWorldPosition(_wp);
  const yaw = Math.atan2(camera.position.x - _wp.x, camera.position.z - _wp.z);
  const parent = obj.parent;
  if (parent) {
    parent.getWorldQuaternion(_q);
    _e.setFromQuaternion(_q, 'YXZ');
    obj.rotation.y = yaw - _e.y;
  } else {
    obj.rotation.y = yaw;
  }
}

/** 供测试/调试用 */
export function _debugCache() {
  return { size: texCache.size, loading: pending.size, keys: [...texCache.keys()] };
}

/** 某套立绘的原始 accent(取自 crosspet 的 character.json) */
export function baseAccentFor(charId) {
  return MANIFEST.characters?.[charId]?.accent || null;
}

/** 某套立绘的来源角色名(用于界面提示) */
export function sourceNameFor(charId) {
  return MANIFEST.characters?.[charId]?.name || null;
}
