/**
 * 3D 卡通角色(程序化建模)。
 *
 * ⚠️ **已被 2D 立绘取代,当前没有任何地方在用它。**
 *    座位角色现在走 `portraits2d.js`(crosspet 的角色立绘,按模型切换)。
 *    这个文件保留是为了:(1) 想退回 3D 角色时能直接换回来;
 *    (2) `tools/measurechar.mjs` 还靠它量「旧角色的本地高度」——
 *    portraits2d 的尺寸就是照着那个量出来的。
 *    确认不再需要的话可以整个删掉。
 *
 * 用基础几何体拼出「圆头 + 卡通五官 + 圆润身体」的小人,
 * 体型 / 肤色 / 衣服颜色按座位和性格变化,让一桌人看起来不一样。
 * 所有角色都是坐姿:身体在椅子高度,手臂搭在桌沿。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 头的大小 / 形状        → makeHead()
 *   · 五官(眼睛、嘴)       → createCharacter() 里眼睛/嘴的拼装
 *   · 身体与胳膊             → createCharacter() 里的 torso / arms
 *   · 体型种类(瘦/普通/壮) → createCharacter() 的体型参数
 *   · 肤色可选值             → SKIN(取自 scene.js 的 PALETTE)
 *   · 角色整体缩放           → CHAR_SCALE
 *
 * ⚠️ 关于头发:试过 6 种球壳发型(帽檐横切、发箍、贴头骨的薄壳…)都不像,
 *    最后**统一做成光头** —— 这种「大圆头 + 简化五官」的比例下,光头最干净。
 *    要加头发的话建议直接换 GLB 模型,而不是继续用几何体拼。
 * ⚠️ 角色不投射也不接收阴影:躯干是拼接的,自阴影会在胸口留一道深色接缝。
 * ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { PALETTE, rand } from './scene.js';

const SKIN = PALETTE.skin;
const HAIR = PALETTE.hair;
const SHIRT = PALETTE.shirt;

const HAIR_STYLES = ['short', 'side', 'bun', 'bald', 'wavy'];

/**
 * 角色整体缩放。0.9 是调出来的:再大就和桌子一个量级(人比桌子还宽),
 * 再小就看不见表情。
 */
export const CHAR_SCALE = 0.9;

/**
 * 身体相对于「角色原点」的高度。
 *
 * 这个值是穿模检测算出来的:躯干落在桌子半径内的那一截必须**高于桌面**,
 * 这样才被包边自然遮住;低于桌面就会从包边和桌面的缝里露出来(穿模)。
 * 0.44 让躯干最低处在 y≈0.06,刚好在桌面(0.02)之上。
 */
/**
 * 身体相对于「角色原点」的高度。
 *
 * 这个值是穿模检测算出来的:躯干落在桌子半径内的那一截必须**高于包边顶面**
 * (y≈0.19),这样才被包边自然遮住;低于它就会从包边和桌面的缝里露出来(穿模)。
 */
export const BODY_GROUP_Y = 0.26;

function mat(color, rough = 0.82) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough });
}

/** 圆润的头。所有部件都贴着球面摆,不做「贴片」似的东西浮在脸外面。 */
export function makeHead(skin, hairColor, style) {
  const g = new THREE.Group();

  const headMat = mat(skin, 0.78);
  const HEAD_R = 0.5;
  const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 28, 22), headMat);
  head.scale.set(1, 1.06, 0.96);
  head.castShadow = false;
  g.add(head);

  // 脸颊/额头都是这个头本身的颜色,所以不需要额外补片。

  // 耳朵
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 10), headMat);
    ear.position.set(s * 0.47, -0.04, -0.02);
    ear.scale.set(0.55, 1, 0.8);
    g.add(ear);
  }

  // 发型:统一光头。
  //
  // 之前试过好几种球壳做法(帽檐横切一整圈、发箍、贴着头骨的薄壳),
  // 在这种「大圆头 + 简化五官」的比例下都做不像头发 ——
  // 边缘要么横切到眼睛显得像贼,要么像戴了顶小帽子。
  // 既然整体是极简卡通风,统一光头最干净,也少一堆容易出错的几何体。
  // (makeHead 的 style 参数保留着,以后想加头发在这里分支即可。)
  void style;
  void hairColor;

  // 眼睛:小一点的椭圆眼白 + 瞳孔 + 高光
  const eyeWhite = mat(PALETTE.eyeWhite, 0.45);
  const eyeDark = mat(PALETTE.pupil, 0.35);
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 12), eyeWhite);
    w.position.set(s * 0.185, 0.055, 0.435);
    w.scale.set(1, 1.15, 0.5);
    g.add(w);
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10), eyeDark);
    p.position.set(s * 0.185, 0.045, 0.468);
    g.add(p);
    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.013, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    spark.position.set(s * 0.185 - 0.014, 0.068, 0.492);
    g.add(spark);
  }

  // 眉毛
  for (const s of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.024, 0.026), mat(PALETTE.brow, 0.9));
    brow.position.set(s * 0.185, 0.175, 0.45);
    brow.rotation.z = s * 0.08;
    g.add(brow);
  }

  // 鼻子:很小的一点
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), headMat);
  nose.position.set(0, -0.03, 0.475);
  nose.scale.set(0.8, 0.85, 0.9);
  g.add(nose);

  // 嘴:一段微笑弧
  const smile = new THREE.Mesh(
    new THREE.TorusGeometry(0.085, 0.012, 8, 16, Math.PI * 0.8),
    mat(PALETTE.mouth, 0.6),
  );
  smile.position.set(0, -0.135, 0.45);
  smile.rotation.set(Math.PI * 0.08, 0, Math.PI + 0.06);
  g.add(smile);

  return g;
}

/**
 * 建一个角色。返回的 group 原点在「桌面高度」,
 * 所以直接放到座位坐标上即可,身体会自动落在桌沿后面。
 */
export function createCharacter({ seed = 0, shirt, hair, skin, body = 'average', scale = 1 } = {}) {
  const root = new THREE.Group();
  const skinColor = skin ?? SKIN[seed % SKIN.length];
  const hairColor = hair ?? HAIR[(seed * 3 + 1) % HAIR.length];
  const shirtColor = shirt ?? SHIRT[(seed * 5 + 2) % SHIRT.length];
  const style = HAIR_STYLES[(seed * 7 + 3) % HAIR_STYLES.length];

  const bodyScale = body === 'stout' ? { w: 1.22, h: 1.02 } : body === 'slim' ? { w: 0.86, h: 1.06 } : { w: 1, h: 1 };

  // 椅子到桌面的落差:身体抬到「桌内那一截高于桌面」,被包边自然遮住
  const bodyGroup = new THREE.Group();
  bodyGroup.position.y = BODY_GROUP_Y;
  root.add(bodyGroup);

  // 躯干(上宽下窄的圆角柱)。
  // 一体成型的一颗胶囊,不做「上下两半拼接」—— 拼接会在胸口留下一道阴影接缝。
  // 横向要收着点:人多的桌上相邻两个人的身体不能互相穿插。
  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.42, 0.62, 10, 24),
    mat(shirtColor, 0.9),
  );
  torso.scale.set(bodyScale.w * 0.94, bodyScale.h, bodyScale.w * 0.80);
  torso.position.y = 0.42;
  bodyGroup.add(torso);

  // 领口:一圈薄薄的深色,只是点缀,不做成立体结构
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.265, 0.285, 0.1, 20, 1, true),
    mat(new THREE.Color(shirtColor).offsetHSL(0, 0, -0.1).getHex(), 0.85),
  );
  collar.position.y = 0.88;
  bodyGroup.add(collar);

  // 脖子
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.2, 14), mat(skinColor, 0.78));
  neck.position.y = 0.92;
  bodyGroup.add(neck);

  // 胳膊:就一条圆润的圆柱(简约卡通,不做手),搭在桌沿上
  const armMat = mat(shirtColor, 0.86);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, 0.62, 6, 14), armMat);
    arm.position.set(s * (0.42 * bodyScale.w), 0.74, 0.34);
    arm.rotation.set(1.5, 0, s * 0.14);            // 基本水平,袖口朝桌子
    arm.castShadow = true;
    bodyGroup.add(arm);
  }

  // 头
  const head = makeHead(skinColor, hairColor, style);
  head.position.y = 1.72;
  head.scale.setScalar(body === 'stout' ? 1.04 : 0.98);
  bodyGroup.add(head);

  root.userData.head = head;
  root.userData.torso = torso;
  root.userData.bodyGroup = bodyGroup;
  root.userData.palette = { skin: skinColor, hair: hairColor, shirt: shirtColor, style, body };
  root.scale.setScalar(scale);
  root.userData.baseY = 0;

  // 角色不投射阴影:躯干是上下两半拼的,自阴影会在胸口留下一道深色接缝,
  // 看起来像衣服上贴了块脏东西。关掉之后由桌子和地面负责地面阴影就够了。
  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; }
  });

  return root;
}

/** 让角色做一个「看牌 / 思考」的小动作:头部微微侧倾 */
export function setCharacterPose(char, pose = 'idle') {
  const head = char.userData.head;
  const body = char.userData.bodyGroup;
  if (!head || !body) return;
  if (pose === 'think') {
    head.rotation.z = 0.16;
    head.rotation.x = 0.1;
    body.rotation.x = 0.04;
  } else if (pose === 'fold') {
    head.rotation.z = -0.1;
    body.rotation.x = -0.08;
  } else if (pose === 'win') {
    head.rotation.z = 0;
    head.rotation.x = -0.14;
    body.rotation.x = -0.05;
  } else {
    head.rotation.z = 0;
    head.rotation.x = 0;
    body.rotation.x = 0;
  }
}

export { rand };
