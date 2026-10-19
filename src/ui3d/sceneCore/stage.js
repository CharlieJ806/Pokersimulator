/**
 * 3D 场景骨架:坐姿透视相机 + 灯光 + 牌房。
 *
 * 视角就是「你坐在牌桌这一侧」:相机在荷官座位上方一点点,
 * 略微俯视桌面,对面和两侧坐着 AI 牌手(见 sceneCore/table.js 的座次表)。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 3D 场景配色(毡布/桌子/椅子/地板/墙) → 下面的 PALETTE
 *   · 相机高度 / 远近 / 俯角              → createStage() 里的 camera.position 与 lookAt
 *     (⚠️ 这几个数字是 tools/camsweep.mjs 扫出来的:要同时满足
 *      「坐姿高度 + 对面所有人不出画 + 桌子前沿有前景感」。改完建议跑一次截图看)
 *   · 灯光亮度 / 颜色 / 阴影              → addLights()
 *   · 房间(墙、地板、地毯、挂画、绿植)   → addRoom()
 *   · 后墙挂画的尺寸 / 高度 / 画框         → 下面的 PAINTING
 *     (图片是 assets/decor/painting.jpg,由 tools/prepdecor.mjs 从 assets/Background 压缩生成)
 *   · 雾效浓度                            → createStage() 里的 scene.fog
 *   · 色调映射 / 抗锯齿 / 像素比上限      → createStage() 里的 renderer.*
 * ============================================================ */

import * as THREE from '../../../vendor/three.module.js';

/**
 * 配色表。
 *
 * 来源:
 *   · 场景主色(毡布/桌子/椅子/地板/墙)对着参考图取色;
 *   · 角色衣服颜色取自 [nice-color-palettes](https://github.com/Jam3/nice-color-palettes)
 *     (Matt DesLauriers 整理的 100 组专业配色,MIT)—— 饱和度和明度都配平过,
 *     比随手挑的颜色整齐得多,一桌人放一起不会打架。
 *   · 肤色/发色按卡通风格取:暖调、明度高、彼此区分明显。
 */
export const PALETTE = {
  // 房间:画廊式的暖白墙 + 浅橡木地板 —— 明亮、留白多,让后墙的挂画当主角
  roomWall: 0xeee8de,
  roomWallDark: 0xe2dacd,
  baseboard: 0xf8f5ef,
  floor: 0xd6bc96,
  rug: 0xece4d6,

  // 牌桌:灰调鼠尾草绿毡布 + 奶油色皮质包边 + 细黄铜线
  rail: 0xe9dfcf,
  gold: 0xc4a062,

  // 家具:浅橡木椅子 + 胡桃木腿
  chair: 0xd9bf98,
  chairDark: 0x8f6e4e,

  // 挂画:浅橡木细框 + 白色卡纸;墙角绿植
  frame: 0xc9a77c,
  frameMat: 0xfbf9f4,
  plant: 0x7f9c78,
  plantDark: 0x5f7d5a,
  planter: 0xf4f0e8,   // 花盆(以前这个名字和「底池」撞词,场景核心不许出现那个词)

  // 角色配色
  skin: [0xffe0c4, 0xf7cfa8, 0xe8b183, 0xd08f5c, 0xa96a3c, 0xffd6c0],
  hair: [0x2e2016, 0x4a3220, 0x6b4423, 0x1d1a17, 0xc9a227, 0x8a8f98, 0x3d2b1f],
  // 每个人一件,取自 nice-color-palettes 里偏明快的那几组
  shirt: [
    0xe2574c, 0x3b7dd8, 0x2aa17a, 0xe08e24, 0x8a5cd1,
    0x1f9bb5, 0xd94f6b, 0x4a8f3c, 0xc95f1e, 0x5a6acf,
  ],
  eyeWhite: 0xfdfcf8,
  pupil: 0x33291f,
  brow: 0x4a3427,
  mouth: 0x8a4a42,
  blush: 0xf2a898,
};

const rand = (a, b) => a + Math.random() * (b - a);

/** 建 renderer / scene / camera,并挂上窗口自适应 */
export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(PALETTE.roomWall, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 不用 ACES 电影级色调映射 —— 它会把卡通配色压得发灰发脏;
  // 线性映射 + 略高曝光,颜色更接近设计值(卡通风格要的就是干净明亮)。
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  // 雾色 = 墙色:远处自然融进墙里,而不是发黑
  scene.fog = new THREE.Fog(PALETTE.roomWall, 30, 64);

  // 相机:荷官的视线高度。这组数字是 tools/camsweep.mjs 扫出来的 ——
  // 约束是「坐姿高度 + 对面所有人不出画 + 桌子前沿有前景感」。
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
  camera.position.set(0, 4.3, 8.4);
  camera.lookAt(0, 0.3, -1.0);

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  return { THREE, renderer, scene, camera, resize };
}

/**
 * 灯光:明亮的室内漫射光为主,吊灯给桌面一点聚焦,挂画上方一盏画灯(在 makePainting 里)。
 * 墙和地面都是浅色,补光不能太猛,否则墙会过曝成一片白。
 */
export function addLights(scene, tableY = 0) {
  // 天光:白 → 暖米色,整个房间亮而柔
  const ambient = new THREE.HemisphereLight(0xffffff, 0xe6d8c2, 1.35);
  scene.add(ambient);

  const lamp = new THREE.PointLight(0xfff3e2, 62, 30, 2);
  lamp.position.set(0, 6.6, -0.3);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.bias = -0.0015;
  lamp.shadow.radius = 4;
  lamp.shadow.camera.near = 0.5;
  lamp.shadow.camera.far = 24;
  scene.add(lamp);

  // 吊灯:细吊线 + 哑光白灯罩(以前是一颗发光球,竖屏里像个鸡蛋挂在半空)
  const shadeY = lamp.position.y + 0.45;
  const shade = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.6, side: THREE.DoubleSide }),
  );
  shade.position.set(lamp.position.x, shadeY, lamp.position.z);
  scene.add(shade);
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.58, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff8ec }),
  );
  glow.rotation.x = Math.PI / 2;
  glow.position.set(lamp.position.x, shadeY + 0.01, lamp.position.z);
  scene.add(glow);
  const cord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0x8a7f72 }),
  );
  cord.position.set(lamp.position.x, shadeY + 4.6, lamp.position.z);
  scene.add(cord);

  // 主光:斜上方的柔和日光,给人物和桌面一个干净的受光面
  const fill = new THREE.DirectionalLight(0xfffaf2, 1.0);
  fill.position.set(-4, 9, 8);
  scene.add(fill);

  // 从荷官背后往桌上打的暖光,照亮人物正面
  const front = new THREE.PointLight(0xfff0dc, 22, 22, 2);
  front.position.set(0, 4.2, 7.5);
  scene.add(front);

  void tableY;
  return { lamp, ambient, fill };
}

/* ------------------------------------------------------------ 房间贴图 */

function canvasTex(w, h, draw, repeat) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  return tex;
}

/** 浅橡木地板:错缝长条木板 + 很淡的木纹 */
function floorTexture() {
  return canvasTex(1024, 1024, (g, W, H) => {
    const rows = 8, plankH = H / rows, plankW = W * 0.75;
    for (let row = 0; row < rows; row++) {
      const offset = (row % 2) * W * 0.37 + Math.random() * 60;
      for (let x = -W; x < W * 2; x += plankW) {
        // 每块木板颜色略有不同
        const k = 0.94 + Math.random() * 0.08;
        g.fillStyle = `rgb(${Math.round(0xd6 * k)},${Math.round(0xbc * k)},${Math.round(0x96 * k)})`;
        g.fillRect(x + offset, row * plankH, plankW, plankH);
        g.fillStyle = 'rgba(90,60,30,.16)';
        g.fillRect(x + offset, row * plankH, 2, plankH);       // 端缝
      }
      for (let i = 0; i < 14; i++) {                            // 木纹
        g.strokeStyle = `rgba(120,85,50,${0.03 + Math.random() * 0.05})`;
        g.lineWidth = 1 + Math.random() * 1.5;
        const y = row * plankH + Math.random() * plankH;
        g.beginPath();
        g.moveTo(0, y);
        g.bezierCurveTo(W * 0.3, y + (Math.random() - 0.5) * 8, W * 0.7, y + (Math.random() - 0.5) * 8, W, y);
        g.stroke();
      }
      g.fillStyle = 'rgba(90,60,30,.18)';
      g.fillRect(0, row * plankH, W, 2);                        // 长缝
    }
  }, [5, 5]);
}

/** 墙面:几乎看不出来的灰泥颗粒,避免大面积纯色显得像塑料 */
function plasterTexture() {
  return canvasTex(512, 512, (g, W, H) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 9000; i++) {
      const v = Math.round(236 + Math.random() * 19);
      g.fillStyle = `rgba(${v},${v - 3},${v - 8},.5)`;
      g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 3, 2 + Math.random() * 3);
    }
  }, [6, 3]);
}

/** 圆形地毯:燕麦色 + 两圈细边 */
function rugTexture() {
  return canvasTex(512, 512, (g, S) => {
    g.fillStyle = '#ece4d6';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 14000; i++) {
      g.fillStyle = `rgba(150,125,90,${Math.random() * 0.06})`;
      g.fillRect(Math.random() * S, Math.random() * S, 1, 1);
    }
    g.strokeStyle = '#cdbb9c';
    g.lineWidth = 7;
    g.beginPath(); g.arc(S / 2, S / 2, S * 0.455, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 2;
    g.beginPath(); g.arc(S / 2, S / 2, S * 0.425, 0, Math.PI * 2); g.stroke();
  });
}

/* ------------------------------------------------------------ 挂画 */

/**
 * 后墙的挂画(画面主角)。
 *
 * 尺寸和高度是对着几种视口截图调出来的:
 * 相机是坐姿俯视,后墙能露出来的只有「对面人物头顶 ~ 顶栏下沿」这一条带,
 * 画太高会被顶栏切掉上沿,太低会被对面的人整个挡住。
 */
export const PAINTING = {
  url: new URL('../../../assets/decor/painting.jpg', import.meta.url).href,
  aspect: 1672 / 941,      // 原图宽高比
  // 放到「接近满墙」:高度从 2.9 提到 4.7(约 1.6 倍)。
  // ⚠️ 顶部可见区的上限大约在 y≈4.45,超过就会被顶栏切掉。
  //    所以放大之后不能只抬中心,要把中心**降下来**(1.95)让画整体变高变宽、
  //    上沿刚好卡在顶栏下方 —— 目标是「满墙」而不是「被裁」。
  height: 4.7,             // 画芯高度(世界单位)
  // 中心压到 1.27:画框下沿落在 y≈-1.25,离地面(-1.4)只差 0.15 —— 接近落地。
  // 副作用是好的:上沿随之降到 y≈3.79,离顶栏的裁切线(约 4.45)留出了余量,
  // 所以「降下来」同时解决了上沿贴顶栏的问题。
  centerY: 1.27,           // 画芯中心的 y(地面在 y=-1.4)
  // 边框收窄,让画面占比更满(原来是 0.28 / 0.14,一圈白卡纸显得很厚)
  mat: 0.1,                // 白卡纸留边
  frame: 0.07,             // 画框宽度
  frameDepth: 0.12,
};

function makePainting(wallZ) {
  const g = new THREE.Group();
  const H = PAINTING.height;
  const W = H * PAINTING.aspect;
  const m = PAINTING.mat, f = PAINTING.frame, d = PAINTING.frameDepth;

  // 三层:画框整块 → 白卡纸 → 画芯,前后错开一点点,避免 z-fighting
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(W + 2 * (m + f), H + 2 * (m + f), d),
    new THREE.MeshStandardMaterial({ color: PALETTE.frame, roughness: 0.55 }),
  );
  frame.castShadow = true;
  g.add(frame);

  const matBoard = new THREE.Mesh(
    new THREE.PlaneGeometry(W + 2 * m, H + 2 * m),
    new THREE.MeshStandardMaterial({ color: PALETTE.frameMat, roughness: 0.95 }),
  );
  matBoard.position.z = d / 2 + 0.002;
  g.add(matBoard);

  // 画芯用 Basic 材质:保持原图颜色(Standard 会被房间灯光染色、压暗)
  const artMat = new THREE.MeshBasicMaterial({ color: 0xf2efea });
  const art = new THREE.Mesh(new THREE.PlaneGeometry(W, H), artMat);
  art.position.z = d / 2 + 0.004;
  g.add(art);
  new THREE.TextureLoader().load(PAINTING.url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    artMat.map = tex;
    artMat.needsUpdate = true;
  }, undefined, () => {
    // 图片缺失时留一块素色画布,而不是黑块
    artMat.color.setHex(0xe9e2d6);
  });

  // 画灯:画框上方一根细黄铜灯杆 + 往下打的暖光
  const brass = new THREE.MeshStandardMaterial({ color: PALETTE.gold, roughness: 0.3, metalness: 0.8 });
  const topY = H / 2 + m + f;
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, W * 0.4, 16), brass);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, topY + 0.26, 0.34);
  g.add(bar);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.34, 8), brass);
  arm.rotation.x = Math.PI / 2;
  arm.position.set(0, topY + 0.26, 0.16);
  g.add(arm);

  const spot = new THREE.SpotLight(0xfff0d8, 24, 9, Math.PI / 4, 0.7, 1.6);
  spot.position.set(0, topY + 0.3, 0.7);
  spot.target.position.set(0, -H * 0.2, 0);
  g.add(spot, spot.target);

  g.position.set(0, PAINTING.centerY, wallZ + d / 2 + 0.01);
  return g;
}

/** 一盆绿植:白色陶盆 + 几团低多边形叶子(跟卡通人物的风格一致) */
function makePlant(height = 2.4) {
  const g = new THREE.Group();
  const planter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.32, 0.8, 24),
    new THREE.MeshStandardMaterial({ color: PALETTE.planter, roughness: 0.7 }),
  );
  planter.position.y = 0.4;
  planter.castShadow = true;
  g.add(planter);
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.05, height * 0.6, 6),
    new THREE.MeshStandardMaterial({ color: 0x8a6e52, roughness: 0.9 }),
  );
  stem.position.y = 0.8 + height * 0.3;
  g.add(stem);
  const leafA = new THREE.MeshStandardMaterial({ color: PALETTE.plant, roughness: 0.85, flatShading: true });
  const leafB = new THREE.MeshStandardMaterial({ color: PALETTE.plantDark, roughness: 0.85, flatShading: true });
  for (const [x, y, z, r, mtl] of [
    [0, 0.82, 0, 0.62, leafA], [-0.38, 0.62, 0.1, 0.46, leafB],
    [0.4, 0.68, -0.05, 0.5, leafA], [0.05, 1.02, 0.05, 0.42, leafB],
  ]) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mtl);
    b.position.set(x, 0.8 + y * height * 0.62, z);
    b.scale.y = 1.12;
    b.castShadow = true;
    g.add(b);
  }
  return g;
}

/* ------------------------------------------------------------ 房间 */

/** 房间:浅木地板 + 地毯 + 三面暖白墙(带踢脚线)+ 后墙挂画 + 墙角绿植 */
export function addRoom(scene) {
  const room = new THREE.Group();
  const FLOOR_Y = -1.4;
  const BACK_Z = -9;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.62, metalness: 0.02 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  room.add(floor);

  // 地毯:圈出牌桌区域
  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(7.6, 64),
    new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 0.98 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = FLOOR_Y + 0.01;
  rug.receiveShadow = true;
  room.add(rug);

  const plaster = plasterTexture();
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 18),
    new THREE.MeshStandardMaterial({ map: plaster, color: PALETTE.roomWall, roughness: 0.96 }),
  );
  back.position.set(0, FLOOR_Y + 9, BACK_Z);
  back.receiveShadow = true;
  room.add(back);

  const sideMat = new THREE.MeshStandardMaterial({ map: plaster, color: PALETTE.roomWallDark, roughness: 0.96 });
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(40, 18), sideMat);
    side.rotation.y = -sx * Math.PI / 2;
    side.position.set(sx * 11, FLOOR_Y + 9, 0);
    side.receiveShadow = true;
    room.add(side);
  }

  // 踢脚线:一条细白边,让墙和地面的交界干净利落
  const baseMat = new THREE.MeshStandardMaterial({ color: PALETTE.baseboard, roughness: 0.5 });
  const baseBack = new THREE.Mesh(new THREE.BoxGeometry(22, 0.26, 0.08), baseMat);
  baseBack.position.set(0, FLOOR_Y + 0.13, BACK_Z + 0.04);
  room.add(baseBack);
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.26, 40), baseMat);
    side.position.set(sx * 10.96, FLOOR_Y + 0.13, 0);
    room.add(side);
  }

  // 后墙挂画
  room.add(makePainting(BACK_Z));

  // 墙角两盆绿植:给画面一点生气,又不跟挂画抢视线
  for (const [x, h] of [[-9.5, 2.3], [9.5, 2.0]]) {
    const p = makePlant(h);
    p.position.set(x, FLOOR_Y, BACK_Z + 0.75);
    p.scale.setScalar(0.85);
    room.add(p);
  }

  scene.add(room);
  return room;
}

export { rand };
