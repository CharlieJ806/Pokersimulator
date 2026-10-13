/**
 * 3D 场景骨架:坐姿透视相机 + 灯光 + 牌房。
 *
 * 视角就是「你坐在牌桌这一侧」:相机在荷官座位上方一点点,
 * 略微俯视桌面,对面和两侧坐着 AI 牌手(见 table3d.js 的座次表)。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 3D 场景配色(毡布/桌子/椅子/地板/墙) → 下面的 PALETTE
 *   · 相机高度 / 远近 / 俯角              → createStage() 里的 camera.position 与 lookAt
 *     (⚠️ 这几个数字是 tools/camsweep.mjs 扫出来的:要同时满足
 *      「坐姿高度 + 对面所有人不出画 + 桌子前沿有前景感」。改完建议跑一次截图看)
 *   · 灯光亮度 / 颜色 / 阴影              → addLights()
 *   · 房间(墙、地板、地毯、柜子剪影)     → addRoom()
 *   · 雾效浓度                            → createStage() 里的 scene.fog
 *   · 色调映射 / 抗锯齿 / 像素比上限      → createStage() 里的 renderer.*
 * ============================================================ */

import * as THREE from '../../vendor/three.module.js';

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
  // 房间:深蓝灰墙 + 暖木地板(参考图是暖冷对比)
  roomWall: 0x3d4a5c,
  roomWallDark: 0x2b3646,
  roomWallTop: 0x4a5d78,
  floor: 0xb07a52,
  floorDark: 0x8a5a38,
  rug: 0x6d4526,

  // 牌桌:亮绿毡布 + 近黑包边
  felt: 0x3fc27a,
  feltMid: 0x2aa564,
  feltDark: 0x14784a,
  rail: 0x1b1f24,
  railTop: 0x2b323a,
  gold: 0xe9c46a,

  // 家具:饱和琥珀黄椅子 + 暖木
  chair: 0xdfa32e,
  chairDark: 0xa8701a,
  wood: 0x9a6236,

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
  renderer.setClearColor(0x1b2430, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 不用 ACES 电影级色调映射 —— 它会把卡通配色压得发灰发脏;
  // 线性映射 + 略高曝光,颜色更接近设计值(卡通风格要的就是干净明亮)。
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x1b2430, 26, 52);

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

/** 灯光:天花板吊灯(暖白,带阴影)+ 环境光 + 正面补光 */
export function addLights(scene, tableY = 0) {
  // 环境光偏暖,避免整体发青
  const ambient = new THREE.HemisphereLight(0xdce9ff, 0x5a4030, 1.0);
  scene.add(ambient);

  const lamp = new THREE.PointLight(0xfff2d8, 78, 32, 2);
  lamp.position.set(0, 6.6, -0.3);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.bias = -0.0015;
  lamp.shadow.camera.near = 0.5;
  lamp.shadow.camera.far = 20;
  scene.add(lamp);

  // 吊灯本体的发光球,让画面有个亮源
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xfff6e0 }),
  );
  bulb.position.copy(lamp.position);
  scene.add(bulb);

  // 顶光:给人物和桌面打一层干净的正面光,卡通风格需要它
  const fill = new THREE.DirectionalLight(0xfff4e2, 1.05);
  fill.position.set(-4, 9, 8);
  scene.add(fill);

  // 从荷官背后往桌上打的暖光,照亮人物正面
  const front = new THREE.PointLight(0xffe0b0, 30, 22, 2);
  front.position.set(0, 4.2, 7.5);
  scene.add(front);

  // 冷色轮廓光:把人物从暖色背景里分出来
  const rim = new THREE.PointLight(0x8fc4ff, 22, 24, 2);
  rim.position.set(0, 3.4, -8);
  scene.add(rim);

  void tableY;
  return { lamp, ambient, fill };
}

/** 房间:地板 + 三面墙 + 几个虚化的家具剪影 */
export function addRoom(scene) {
  const room = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: PALETTE.floor, roughness: 0.85, metalness: 0.05 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.4;
  floor.receiveShadow = true;
  room.add(floor);

  // 地板上铺一块地毯,强调牌桌区域
  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(7.6, 48),
    new THREE.MeshStandardMaterial({ color: PALETTE.rug, roughness: 0.95 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = -1.39;
  rug.receiveShadow = true;
  room.add(rug);

  const wallMat = new THREE.MeshStandardMaterial({ color: PALETTE.roomWall, roughness: 0.95 });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(40, 16), wallMat);
  back.position.set(0, 6.6, -10);
  room.add(back);

  const sideMat = new THREE.MeshStandardMaterial({ color: PALETTE.roomWallDark, roughness: 0.95 });
  const left = new THREE.Mesh(new THREE.PlaneGeometry(40, 16), sideMat);
  left.rotation.y = Math.PI / 2;
  left.position.set(-11, 6.6, 0);
  room.add(left);

  const right = left.clone();
  right.rotation.y = -Math.PI / 2;
  right.position.set(11, 6.6, 0);
  room.add(right);

  // 背景家具:几个柜子的剪影
  const furnitureMat = new THREE.MeshStandardMaterial({ color: 0x3a2f26, roughness: 1 });
  for (const [x, w, h] of [[-8.6, 3.0, 3.8], [8.8, 3.4, 4.3], [-4.2, 1.8, 2.4], [4.6, 1.8, 2.4]]) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.6), furnitureMat);
    box.position.set(x, -1.4 + h / 2, -9.2);
    box.castShadow = true;
    room.add(box);
  }

  // 墙上开一条暖色灯带,画面不会太闷
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(16, 0.14, 0.1),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
  );
  strip.position.set(0, 3.4, -9.9);
  room.add(strip);

  scene.add(room);
  return room;
}

export { rand };
