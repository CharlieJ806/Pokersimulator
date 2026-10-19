/**
 * 谁是卧底的道具层:桌上每个座位面前的**语言卡**,以及桌面中央的轮次牌。
 *
 * 为什么这一层在 props/undercover/ 而不是改 sceneCore:
 *   sceneCore 是「房间 + 桌椅 + 座位 + 立绘 + 相机 + 气泡」,零游戏依赖
 *   (tools/refactortest.mjs 用词表钉着)。卧底要往桌上摆什么,只通过
 *   `Table3D#addPropLayer()` 接 —— 与扑克完全同一个接缝。
 *
 * 卡上写什么由 **ctx 决定**,道具层自己不认识「词 / 阵营」这些概念:
 *   ctx.labels = { 座位号: { title, role, selfRead, vote, accent } }
 *   · 观看模式:每个座位一张卡,写「词 / 阵营 / 自省 / 投给谁」——
 *     这是这个游戏最好看的一屏(它居然猜到自己就是卧底);
 *   · 玩家模式:labels 里**只有玩家自己那一个座位** —— 别人的词根本没有进来
 *     (见 view.js 的 buildRenderView)。道具层不判该不该显示,它只是没有数据可写。
 *
 * 为什么用 Sprite 而不是平铺在毡布上的 Plane:
 *   座位是绕圈排的,平躺的牌子对两侧座位会变成侧视、对最远的座位是倒的;
 *   观看者的相机又在缓慢呼吸。Sprite 永远正对相机,六张卡始终可读 ——
 *   这个游戏的画面信息量全在文字上,可读性优先于「物理上真的躺在桌上」。
 */

import * as THREE from '../../../../vendor/three.module.js';

/** 卡面尺寸(世界单位)与对应的画布分辨率 —— 比例固定,避免文字被拉扁 */
const CARD_W = 0.96;
const CARD_H = 0.60;
const CANVAS_W = 620;
const CANVAS_H = 390;

const COLORS = {
  card: 'rgba(252, 248, 235, 0.96)',
  border: 'rgba(196, 162, 88, 0.95)',
  title: '#2b2317',
  sub: '#6b5a3e',
  civilian: '#2f7d5a',
  undercover: '#b23b3b',
  unsure: '#8a7a55',
  vote: '#7a4b9a',
};

/** 角色/自省的中文标签(道具层只做显示,不参与判定) */
function roleLabel(role) {
  if (role === 'undercover') return '卧底';
  if (role === 'civilian') return '平民';
  return '';
}
function selfReadLabel(v) {
  if (v === 'undercover') return '自省:我是卧底';
  if (v === 'civilian') return '自省:我是平民';
  if (v === 'unsure') return '自省:拿不准';
  return '';
}

/** 画一张卡。内容变了才重画 —— 每帧重画 Canvas 太贵(与场景核心的 tagTex 同一套思路)。 */
function drawCard(canvas, label) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // 圆角卡片底
  const r = 26;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fillStyle = COLORS.card;
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = label?.accent || COLORS.border;
  ctx.stroke();

  // 顶部:座位号
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.sub;
  ctx.font = 'bold 30px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(`${(label?.seat ?? 0) + 1}号`, 32, 48);

  // 中部:词(最大的一行)或「(还没有词)」
  ctx.textAlign = 'center';
  const title = label?.title || '';
  ctx.fillStyle = COLORS.title;
  ctx.font = `bold ${title.length > 8 ? 58 : 72}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.fillText(title || '(还没有词)', w / 2, 152);

  // 阵营(只有观看模式会传)
  const role = roleLabel(label?.role);
  if (role) {
    ctx.fillStyle = label.role === 'undercover' ? COLORS.undercover : COLORS.civilian;
    ctx.font = 'bold 46px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(role, w / 2, 218);
  }

  // 自省(这个游戏的灵魂字段)
  const self = selfReadLabel(label?.selfRead);
  if (self) {
    ctx.fillStyle = label?.selfRead === 'undercover' ? COLORS.undercover : COLORS.unsure;
    ctx.font = '34px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(self, w / 2, role ? 272 : 232);
  }

  // 投给谁(公开信息;最近一句已经在下面的描述矩阵里了,卡上不再重复 —— 卡要干净)
  if (label?.vote !== null && label?.vote !== undefined) {
    ctx.fillStyle = COLORS.vote;
    ctx.font = '32px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(label.vote === -1 ? '这一轮弃票' : `投给 ${label.vote + 1}号`, w / 2, 336);
  }
}

export class UndercoverProps {
  constructor() {
    this.id = 'undercover';
    /** 座位 → { sprite, canvas, tex, key } */
    this.cards = new Map();
    /** 桌面中央的轮次牌 */
    this.center = null;
    this.centerKey = null;
  }

  /** 座位重建后调用:把旧道具摘干净,再按新座位造一遍(与扑克道具层同一套纪律) */
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
      // inset 0.55 比扑克的底牌(0.5)略往里:六张卡要互相留出缝,不然 6 人桌会叠在一起。
      const p = host.feltPoint(s.transform.angle, 0.46);
      sprite.position.set(p.x, 0.64, p.z);
      host.root.add(sprite);
      this.cards.set(seat, { sprite, canvas, tex, key: null });
    }

    // 中央轮次牌
    const cCanvas = document.createElement('canvas');
    cCanvas.width = 760;
    cCanvas.height = 220;
    const cTex = new THREE.CanvasTexture(cCanvas);
    cTex.colorSpace = THREE.SRGBColorSpace;
    this.center = {
      canvas: cCanvas,
      tex: cTex,
      sprite: new THREE.Sprite(new THREE.SpriteMaterial({ map: cTex, transparent: true, depthWrite: false })),
    };
    this.center.sprite.scale.set(2.1, 0.6, 1);
    this.center.sprite.position.set(0, 0.5, -0.15);
    host.root.add(this.center.sprite);
    this.centerKey = null;
  }

  /**
   * 每次状态变化调用。
   * @param {object} view 场景核心要的通用座位视图(见 view.js 的 buildTableViewModel)
   * @param {object} ctx  { labels?, roundText? } —— 卧底专用信息全在 labels 里
   * @param {object} host
   */
  sync(view, ctx, host) {
    const labels = ctx?.labels || null;
    for (const [seat, c] of this.cards) {
      const label = labels ? labels[seat] : null;
      // 没有这一格 = 这个座位面前不该出现卡片(玩家模式下别人的座位就是这种)
      if (!label) {
        c.sprite.visible = false;
        continue;
      }
      c.sprite.visible = true;
      const key = JSON.stringify(label);
      if (c.key !== key) {
        c.key = key;
        drawCard(c.canvas, label);
        c.tex.needsUpdate = true;
      }
    }

    if (this.center && ctx?.roundText !== undefined) {
      const key = String(ctx.roundText);
      if (this.centerKey !== key) {
        this.centerKey = key;
        const ctx2 = this.center.canvas.getContext('2d');
        const w = this.center.canvas.width;
        const h = this.center.canvas.height;
        ctx2.clearRect(0, 0, w, h);
        ctx2.fillStyle = 'rgba(30, 26, 20, 0.72)';
        const r = 20;
        ctx2.beginPath();
        ctx2.moveTo(r, 0); ctx2.arcTo(w, 0, w, h, r); ctx2.arcTo(w, h, 0, h, r);
        ctx2.arcTo(0, h, 0, 0, r); ctx2.arcTo(0, 0, w, 0, r); ctx2.closePath();
        ctx2.fill();
        ctx2.textAlign = 'center';
        ctx2.fillStyle = '#f2e7c9';
        ctx2.font = 'bold 58px "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx2.fillText(String(ctx.roundText), w / 2, 96);
        ctx2.font = '32px "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx2.fillStyle = '#c9b98f';
        ctx2.fillText(ctx.roundHint || '', w / 2, 158);
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
