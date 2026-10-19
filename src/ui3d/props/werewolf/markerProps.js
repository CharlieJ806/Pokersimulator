/**
 * 狼人杀的道具层:桌上每个座位面前的**身份牌**、中央的**天/夜牌**,以及死者的标记。
 *
 * 为什么这一层在 props/werewolf/ 而不是改 sceneCore:
 *   sceneCore 是「房间 + 桌椅 + 座位 + 立绘 + 相机 + 气泡」,零游戏依赖
 *   (tools/refactortest.mjs 用词表钉着)。狼人杀要往桌上摆什么,只通过
 *   `Table3D#addPropLayer()` 接 —— 与扑克、卧底完全同一个接缝。
 *
 * 卡上写什么由 **ctx 决定**,道具层自己不认识「狼 / 神 / 民」这些概念:
 *   ctx.labels = { 座位号: { seat, name, roleLabel, dead, voted, say } }
 *   · 观看模式:每个座位一张卡,写「身份 / 出局 / 投给谁」——
 *     这一屏就是这个游戏最好看的地方(谁在骗人一眼就看见);
 *   · 玩家模式:labels 里**只有玩家自己那一个座位有 roleLabel** ——
 *     别人的身份根本没有进来(见 view.js 的 buildRenderView)。道具层不判
 *     「该不该显示身份」,它只是没有数据可写:没有 roleLabel 就画成「?」。
 *
 * 为什么身份牌用 Sprite 而不是平铺在毡布上的 Plane:
 *   座位是绕圈排的,平躺的牌子对两侧座位会变成侧视、对最远的座位是倒的;
 *   Sprite 永远正对相机。这个游戏的信息全在文字上,可读性优先于物理真实
 *   (与卧底的道具层同一个取舍)。
 *
 * ⚠️ 夜晚的「天黑遮罩」**不在这一层**:那是全屏的 DOM 遮罩(见 ui/screen.js),
 *    放在 3D 里做会挡住座位、而且玩家模式还要能在它上面点夜间行动按钮。
 *    这一层只负责「桌面上那几张牌」。
 */

import * as THREE from '../../../../vendor/three.module.js';

/** 卡面尺寸(世界单位)与画布分辨率 —— 比例固定,避免文字被拉扁 */
const CARD_W = 0.92;
const CARD_H = 0.62;
const CANVAS_W = 600;
const CANVAS_H = 404;

const COLORS = {
  card: 'rgba(250, 246, 236, 0.96)',
  border: 'rgba(196, 162, 88, 0.95)',
  title: '#2b2317',
  sub: '#6b5a3e',
  wolf: '#b23b3b',
  god: '#2f6f9d',
  good: '#2f7d5a',
  dead: '#8b8378',
  vote: '#7a4b9a',
};

/** 身份 → 一个视觉分组(只影响配色,不参与任何判定) */
function colorOf(roleLabel) {
  if (!roleLabel) return COLORS.border;
  if (/狼/.test(roleLabel)) return COLORS.wolf;
  if (/预言家|女巫/.test(roleLabel)) return COLORS.god;
  return COLORS.good;
}

/** 画一张身份牌。内容变了才重画 —— 每帧重画 Canvas 太贵(与场景核心同一套思路) */
function drawCard(canvas, label) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const dead = !!label?.dead;
  // 圆角卡片底:出局的人整张压暗(这是**公开信息**,两种模式都可以表现)
  const r = 26;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fillStyle = dead ? 'rgba(226, 220, 208, 0.94)' : COLORS.card;
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = dead ? COLORS.dead : colorOf(label?.roleLabel);
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

  // 中部:身份(观看模式) / 「?」(玩家模式看不到别人) / 出局
  ctx.textAlign = 'center';
  if (dead) {
    ctx.fillStyle = COLORS.dead;
    ctx.font = 'bold 64px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText('出局', w / 2, 156);
  } else {
    const role = String(label?.roleLabel || '');
    ctx.fillStyle = role ? colorOf(role) : '#b9ad96';
    ctx.font = `bold ${role && role.length > 2 ? 56 : 66}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.fillText(role || '?', w / 2, 158);
  }

  // 底部:最近一次票向(公开信息)/ 最近一句
  ctx.font = '30px "Microsoft YaHei", "PingFang SC", sans-serif';
  if (label?.voted !== null && label?.voted !== undefined) {
    ctx.fillStyle = COLORS.vote;
    ctx.fillText(label.voted === -1 ? '这一轮弃票' : `投 ${label.voted + 1}号`, w / 2, 232);
  }
  const say = String(label?.say || '').replace(/\s+/g, ' ').trim();
  if (say) {
    ctx.fillStyle = '#57492f';
    ctx.font = '26px "Microsoft YaHei", "PingFang SC", sans-serif';
    // 只画一行,超出就省略 —— 完整的发言在旁边的时间线面板里,卡上画不下
    const line = say.length > 22 ? `${say.slice(0, 22)}…` : say;
    ctx.fillText(line, w / 2, 292);
  }
  if (dead) {
    // 出局的人身上再压一道斜线,比只压暗更容易一眼看出来
    ctx.strokeStyle = 'rgba(139, 131, 120, .55)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(40, h - 56);
    ctx.lineTo(w - 40, 62);
    ctx.stroke();
  }
}

export class WerewolfProps {
  constructor() {
    this.id = 'werewolf';
    /** 座位 → { sprite, canvas, tex, key } */
    this.cards = new Map();
    /** 桌面中央的天/夜牌 */
    this.center = null;
    this.centerKey = null;
  }

  /** 座位重建后调用:把旧道具摘干净,再按新座位造一遍(与扑克/卧底道具层同一套纪律) */
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

    // 中央的天/夜牌
    const cCanvas = document.createElement('canvas');
    cCanvas.width = 780;
    cCanvas.height = 230;
    const cTex = new THREE.CanvasTexture(cCanvas);
    cTex.colorSpace = THREE.SRGBColorSpace;
    this.center = {
      canvas: cCanvas,
      tex: cTex,
      sprite: new THREE.Sprite(new THREE.SpriteMaterial({ map: cTex, transparent: true, depthWrite: false })),
    };
    this.center.sprite.scale.set(2.2, 0.65, 1);
    this.center.sprite.position.set(0, 0.52, -0.15);
    host.root.add(this.center.sprite);
    this.centerKey = null;
  }

  /**
   * 每次状态变化调用。
   * @param {object} view 场景核心要的通用座位视图(见 view.js 的 buildTableViewModel)
   * @param {object} ctx  { labels?, phaseText?, phaseHint?, night? }
   * @param {object} host
   */
  sync(view, ctx, host) {
    void view; void host;
    const labels = ctx?.labels || null;
    for (const [seat, c] of this.cards) {
      const label = labels ? labels[seat] : null;
      // 没有这一格 = 这个座位面前不该出现卡片(正常不会发生:死人也要有卡)
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
      const key = `${ctx.phaseText}|${ctx.phaseHint || ''}|${ctx.night ? 'n' : 'd'}`;
      if (this.centerKey !== key) {
        this.centerKey = key;
        const g = this.center.canvas.getContext('2d');
        const w = this.center.canvas.width;
        const h = this.center.canvas.height;
        g.clearRect(0, 0, w, h);
        // 夜里这张牌压成深色,白天是暖色 —— 一进画面就知道现在是什么阶段
        g.fillStyle = ctx.night ? 'rgba(18, 20, 34, 0.86)' : 'rgba(30, 26, 20, 0.72)';
        const r = 20;
        g.beginPath();
        g.moveTo(r, 0); g.arcTo(w, 0, w, h, r); g.arcTo(w, h, 0, h, r);
        g.arcTo(0, h, 0, 0, r); g.arcTo(0, 0, w, 0, r); g.closePath();
        g.fill();
        g.textAlign = 'center';
        g.fillStyle = ctx.night ? '#cfd6f2' : '#f2e7c9';
        g.font = 'bold 60px "Microsoft YaHei", "PingFang SC", sans-serif';
        g.fillText(String(ctx.phaseText), w / 2, 96);
        g.font = '32px "Microsoft YaHei", "PingFang SC", sans-serif';
        g.fillStyle = ctx.night ? '#8f9ac4' : '#c9b98f';
        g.fillText(ctx.phaseHint || '', w / 2, 158);
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
