/**
 * 阿瓦隆的道具层:桌上每个座位面前的**状态牌**、中央的**任务牌**(
 * 五轮任务进度 + 当前阶段)。
 *
 * 为什么这一层在 props/avalon/ 而不是改 sceneCore:
 *   sceneCore 是「房间 + 桌椅 + 座位 + 立绘 + 相机 + 气泡」,零游戏依赖
 *   (tools/refactortest.mjs 用词表钉着)。阿瓦隆要往桌上摆什么,只通过
 *   `Table3D#addPropLayer()` 接 —— 与扑克、卧底、狼人杀完全同一个接缝。
 *
 * 牌上写什么由 **ctx 决定**,道具层自己不认识「梅林 / 刺客 / 好人」这些概念:
 *   ctx.labels = { 座位号: { seat, name, roleLabel, onTeam, vote, card, leader, quests } }
 *   · 观看模式:每个座位一张牌,写「身份 + 这一轮的票 + 上没上车」——
 *     这一屏就是这个游戏最好看的地方(谁在演、谁被所有人接受);
 *   · 玩家模式:labels 里**只有玩家自己那一个座位有 roleLabel** ——
 *     别人的身份根本没有进来(见 view.js 的 buildRenderView)。道具层不判
 *     「该不该显示身份」,它只是没有数据可写:没有 roleLabel 就画成「?」。
 *
 * 为什么牌用 Sprite 而不是平铺在毡布上的 Plane:
 *   座位是绕圈排的,平躺的牌子对两侧座位会变成侧视、对最远的座位是倒的;
 *   Sprite 永远正对相机。这个游戏的信息全在文字上,可读性优先于物理真实
 *   (与狼人杀/卧底的道具层同一个取舍)。
 *
 * ⚠️ 任务进度(五个小圆点)**每个座位面前都画一份**,中央再画一份大的。
 *    这不是偷懒:五轮进度是**公开信息**,人人面前一份等于人人都有一个进度条
 *    (桌上玩实体阿瓦隆也是每人面前摆标记),而不含任何私有内容。
 */

import * as THREE from '../../../../vendor/three.module.js';

/** 卡面尺寸(世界单位)与画布分辨率 —— 比例固定,避免文字被拉扁 */
const CARD_W = 0.92;
const CARD_H = 0.62;
const CANVAS_W = 600;
const CANVAS_H = 404;

const COLORS = {
  card: 'rgba(250, 246, 236, 0.96)',
  cardTeam: 'rgba(255, 250, 232, 0.98)',
  border: 'rgba(196, 162, 88, 0.95)',
  title: '#2b2317',
  sub: '#6b5a3e',
  evil: '#b23b3b',
  merlin: '#b8862b',
  good: '#2f7d5a',
  dead: '#8b8378',
  approve: '#2f7d5a',
  reject: '#b23b3b',
  success: '#2f7d5a',
  fail: '#b23b3b',
  todo: 'rgba(120, 110, 92, .28)',
};

/** 身份 → 一个视觉分组(只影响配色,不参与任何判定) */
function colorOf(roleLabel) {
  if (!roleLabel) return COLORS.border;
  if (/梅林/.test(roleLabel)) return COLORS.merlin;
  if (/刺客|莫甘娜|莫德雷德|爪牙/.test(roleLabel)) return COLORS.evil;
  return COLORS.good;
}

/** 画五轮任务进度的小圆点(公开信息) */
function drawDots(ctx, quests, cx, cy, r, gap) {
  const total = 5;
  const start = cx - ((total - 1) * gap) / 2;
  for (let i = 0; i < total; i++) {
    const q = (quests || [])[i];
    ctx.beginPath();
    ctx.arc(start + i * gap, cy, r, 0, Math.PI * 2);
    if (!q) {
      ctx.fillStyle = COLORS.todo;
      ctx.fill();
      continue;
    }
    // 成功的轮子画绿、失败的画红;轮廓再描一圈,小尺寸下也能看出是「打过」的
    ctx.fillStyle = q.result === 'success' ? COLORS.success : COLORS.fail;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
    ctx.stroke();
  }
}

/** 画一张座位状态牌。内容变了才重画 —— 每帧重画 Canvas 太贵 */
function drawCard(canvas, label) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const role = String(label?.roleLabel || '');
  const onTeam = !!label?.onTeam;
  const leader = !!label?.leader;

  // 圆角卡片底:上车的座位提亮 + 金色粗边(一眼看出这一队是谁)
  const r = 26;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fillStyle = onTeam ? COLORS.cardTeam : COLORS.card;
  ctx.fill();
  ctx.lineWidth = onTeam ? 10 : 7;
  ctx.strokeStyle = onTeam ? 'rgba(212, 175, 55, .98)' : (role ? colorOf(role) : COLORS.border);
  ctx.stroke();

  // 顶部:座位号 + 名字
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.sub;
  ctx.font = 'bold 30px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(`${(label?.seat ?? 0) + 1}号`, 30, 48);
  const name = String(label?.name || '');
  if (name) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9a8a6a';
    ctx.font = '26px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(name.slice(0, 6), w - 28, 46);
  }

  // 中部:身份(观看模式) / 「?」(玩家模式看不到别人) / 队长标
  ctx.textAlign = 'center';
  if (role) {
    ctx.fillStyle = colorOf(role);
    ctx.font = `bold ${role.length > 2 ? 52 : 62}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.fillText(role, w / 2, 152);
  } else {
    ctx.fillStyle = '#b9ad96';
    ctx.font = 'bold 66px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText('?', w / 2, 154);
  }
  if (leader) {
    // 队长标记画在左上角空白处:这一轮谁选人,是这一屏最重要的信息
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(212, 175, 55, .95)';
    ctx.font = 'bold 40px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText('★', 46, 108);
  }

  // 一行状态:这一轮的票 / 上车 / 任务卡
  ctx.font = 'bold 32px "Microsoft YaHei", "PingFang SC", sans-serif';
  if (label?.card === 'fail' || label?.card === 'success') {
    ctx.fillStyle = label.card === 'fail' ? COLORS.fail : COLORS.success;
    ctx.fillText(label.card === 'fail' ? '投了失败' : '投了成功', w / 2, 218);
  } else if (label?.vote === 'approve' || label?.vote === 'reject') {
    ctx.fillStyle = label.vote === 'approve' ? COLORS.approve : COLORS.reject;
    ctx.fillText(label.vote === 'approve' ? '赞成' : '反对', w / 2, 218);
  } else if (onTeam) {
    ctx.fillStyle = 'rgba(140, 110, 30, .95)';
    ctx.fillText('在车上', w / 2, 218);
  } else {
    ctx.fillStyle = 'rgba(140, 130, 110, .55)';
    ctx.fillText('—', w / 2, 218);
  }

  // 底部:五轮任务进度(公开信息,人人一份)
  drawDots(ctx, label?.quests || [], w / 2, 300, 15, 52);

  if (label?.quests?.length) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7d6d4f';
    ctx.font = '24px "Microsoft YaHei", "PingFang SC", sans-serif';
    const ok = label.quests.filter((q) => q.result === 'success').length;
    const bad = label.quests.filter((q) => q.result === 'fail').length;
    ctx.fillText(`${ok} 成 / ${bad} 败`, w / 2, 348);
  }
}

export class AvalonProps {
  constructor() {
    this.id = 'avalon';
    /** 座位 → { sprite, canvas, tex, key } */
    this.cards = new Map();
    /** 桌面中央的任务牌 */
    this.center = null;
    this.centerKey = null;
  }

  /** 座位重建后调用:把旧道具摘干净,再按新座位造一遍(与其它道具层同一套纪律) */
  build(host) {
    for (const c of this.cards.values()) host.root.remove(c.sprite);
    this.cards.clear();
    if (this.center) host.root.remove(this.center.sprite);

    for (const [seat, s] of host.seats) {
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
      }));
      sprite.scale.set(CARD_W, CARD_H, 1);
      // 摆在座位正前方、毡布边缘往里一点,抬高到桌面之上 ——
      // 用 feltPoint(而不是座位坐标 × 比例),座位一外扩卡片也不会跑到桌外。
      // y=0.8 是实拍调出来的:0.66 时后排座位的卡会被椅背挡住下半截。
      const p = host.feltPoint(s.transform.angle, 0.5);
      sprite.position.set(p.x, 0.8, p.z);
      host.root.add(sprite);
      this.cards.set(seat, { sprite, canvas, tex, key: null });
    }

    // 中央的任务牌:五轮进度 + 当前阶段(比座位牌大一圈,是这一屏的焦点)
    const cCanvas = document.createElement('canvas');
    cCanvas.width = 860;
    cCanvas.height = 300;
    const cTex = new THREE.CanvasTexture(cCanvas);
    cTex.colorSpace = THREE.SRGBColorSpace;
    this.center = {
      canvas: cCanvas,
      tex: cTex,
      sprite: new THREE.Sprite(new THREE.SpriteMaterial({ map: cTex, transparent: true, depthWrite: false })),
    };
    this.center.sprite.scale.set(2.5, 0.87, 1);
    this.center.sprite.position.set(0, 0.52, -0.15);
    host.root.add(this.center.sprite);
    this.centerKey = null;
  }

  /**
   * 每次状态变化调用。
   * @param {object} view 场景核心要的通用座位视图(见 view.js 的 buildTableViewModel)
   * @param {object} ctx  { labels?, phaseText?, phaseHint?, quests?, round? }
   * @param {object} host
   */
  sync(view, ctx, host) {
    void view; void host;
    const labels = ctx?.labels || null;
    for (const [seat, c] of this.cards) {
      const label = labels ? labels[seat] : null;
      // 没有这一格 = 这个座位面前不该出现卡片(正常不会发生:阿瓦隆没有人出局)
      if (!label) { c.sprite.visible = false; continue; }
      c.sprite.visible = true;
      const key = JSON.stringify(label);
      if (c.key !== key) {
        c.key = key;
        drawCard(c.canvas, label);
        c.tex.needsUpdate = true;
      }
    }

    if (this.center && ctx?.phaseText !== undefined) {
      const key = `${ctx.phaseText}|${ctx.phaseHint || ''}|${JSON.stringify(ctx.quests || [])}`;
      if (this.centerKey !== key) {
        this.centerKey = key;
        const g = this.center.canvas.getContext('2d');
        const w = this.center.canvas.width;
        const h = this.center.canvas.height;
        g.clearRect(0, 0, w, h);
        g.fillStyle = 'rgba(26, 22, 16, 0.76)';
        const r = 24;
        g.beginPath();
        g.moveTo(r, 0); g.arcTo(w, 0, w, h, r); g.arcTo(w, h, 0, h, r);
        g.arcTo(0, h, 0, 0, r); g.arcTo(0, 0, w, 0, r); g.closePath();
        g.fill();
        g.textAlign = 'center';
        g.fillStyle = '#f2e7c9';
        g.font = 'bold 62px "Microsoft YaHei", "PingFang SC", sans-serif';
        g.fillText(String(ctx.phaseText), w / 2, 96);
        g.font = '32px "Microsoft YaHei", "PingFang SC", sans-serif';
        g.fillStyle = '#c9b98f';
        g.fillText(ctx.phaseHint || '', w / 2, 146);
        // 中央那五个点:大一点,远看也能数出已经打了几轮
        drawDots(g, ctx.quests || [], w / 2, 226, 22, 84);
        // ⚠️ 画完**必须**标脏,否则 GPU 上那张贴图永远是第一次上传的内容:
        //    表现是「中央任务牌一直显示第 1 轮 · 组队」,而 DOM 面板全都在正常更新 ——
        //    查了半天才发现漏了这一行(座位牌那边有,中央这块没有)。
        this.center.tex.needsUpdate = true;
      }
    }
  }

  /** 彻底拆掉(退出本局 / 换游戏) */
  destroy() {
    for (const c of this.cards.values()) {
      c.tex.dispose?.();
      c.sprite.material?.dispose?.();
    }
    this.cards.clear();
    if (this.center) {
      this.center.tex.dispose?.();
      this.center.sprite.material?.dispose?.();
      this.center = null;
    }
  }
}
