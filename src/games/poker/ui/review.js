/**
 * 玩家模式的「上一手回顾」面板。
 *
 * 数据来源是 engine.reviewHand() —— 只有在这一手确实结束之后才会返回别家的底牌,
 * 牌局进行中调用会抛错。所以这个面板本身就起到了「不到时候看不到」的约束作用。
 *
 * 展示内容:
 *   · 公共牌 + 结果的输赢
 *   · 每位参与摊牌的角色的底牌 + 成牌
 *   · 每位 AI 这一手的思考记录(玩家模式下,思考在牌局进行中是不显示的)
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

/** 牌 id → 显示文本 */
function cardText(id) {
  if (id === null || id === undefined) return '?';
  const suit = id % 4;
  const rank = Math.floor(id / 4) + 2;
  return `${RANKS[rank] || rank}${SUITS[suit]}`;
}

/** 一张牌的 DOM(红色表示红桃/方块) */
function cardEl(id, { small = false } = {}) {
  if (id === null || id === undefined) {
    return `<span class="rvcard rvcard--back ${small ? 'rvcard--sm' : ''}"></span>`;
  }
  const suit = id % 4;
  const red = suit === 1 || suit === 2;
  return `<span class="rvcard ${small ? 'rvcard--sm' : ''} ${red ? 'is-red' : ''}">${cardText(id)}</span>`;
}

export function createReviewPanel(root, { onClose } = {}) {
  const el = document.createElement('div');
  el.className = 'setup setup--drawer review';
  el.innerHTML = `
    <div class="setup__card review__card">
      <div class="setup__head">
        <div>
          <h1 id="rvTitle">上一手回顾 <span class="setup__ver">HAND REVIEW</span></h1>
          <p class="setup__sub" id="rvSub">—</p>
        </div>
        <button class="btn btn--ghost" id="rvClose">关闭</button>
      </div>

      <div class="review__body">
        <div class="review__board" id="rvBoard"></div>
        <div class="review__table" id="rvPlayers"></div>

        <div class="review__thinkHead">
          <h3>这一手他们都在想什么</h3>
          <span class="review__hint">牌局进行中看不到;这一手结束后才解锁</span>
        </div>
        <div class="review__think" id="rvThink"></div>
      </div>
    </div>`;
  root.appendChild(el);

  const q = (id) => el.querySelector('#' + id);

  /**
   * @param {object} data engine.reviewHand() 的返回值
   * @param {Array} thoughts [{seat, name, text}] 本手的思考记录
   */
  function fill(data, thoughts = []) {
    const res = data.result || {};
    const winners = (res.deltas || []).filter((d) => d.delta > 0);
    q('rvTitle').innerHTML = `第 ${data.handNo} 手回顾 <span class="setup__ver">HAND REVIEW</span>`;
    q('rvSub').textContent = res.type === 'showdown'
      ? `打到摊牌 · 底池 ${Number(res.pot || data.pot || 0).toLocaleString('en-US')}`
      : `没人跟到摊牌 · 底池 ${Number(res.pot || data.pot || 0).toLocaleString('en-US')}`;

    // 公共牌
    const board = data.board || [];
    q('rvBoard').innerHTML = `
      <span class="review__label">公共牌</span>
      <span class="review__cards">
        ${board.length ? board.map((c) => cardEl(c)).join('') : '<span class="review__empty">没发到公共牌(翻前就结束了)</span>'}
      </span>
      <span class="review__label">结果</span>
      <span class="review__winners">
        ${winners.length
    ? winners.map((w) => {
      const p = (data.players || []).find((x) => x.seat === w.seat);
      return `<span class="rvwin"><b>${escapeHtml(p?.name || '座位' + (w.seat + 1))}</b> +${w.delta.toLocaleString('en-US')}</span>`;
    }).join('')
    : '<span class="review__empty">无人盈利</span>'}
      </span>`;

    // 每个人的底牌
    q('rvPlayers').innerHTML = (data.players || []).map((p) => {
      const d = (res.deltas || []).find((x) => x.seat === p.seat);
      const delta = d ? d.delta : 0;
      const state = !p.inHand ? 'out' : p.folded ? 'folded' : 'live';
      const shown = p.hole && p.hole.some((c) => c !== null);
      const stateText = p.busted ? '出局' : (!p.inHand ? '未参与' : p.folded ? '弃牌' : '摊牌');
      return `
        <div class="rvrow rvrow--${state}">
          <div class="rvrow__who">
            <span class="rvrow__name">${escapeHtml(p.name)}${p.isMe ? '<span class="rvrow__me">你</span>' : ''}</span>
            <span class="rvrow__state">${stateText}</span>
          </div>
          <div class="rvrow__cards">
            ${shown ? p.hole.map((c) => cardEl(c, { small: true })).join('') : '<span class="review__empty">未亮牌</span>'}
          </div>
          <div class="rvrow__hand">${p.handName || ''}</div>
          <div class="rvrow__delta ${delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : ''}">
            ${delta > 0 ? '+' : ''}${delta.toLocaleString('en-US')}
          </div>
        </div>`;
    }).join('');

    // 思考记录
    //
    // 标注出「模型没给出可读思考」的占位句(形如「（这次模型没给出可读的思考）」)——
    // 那不是一个真实的理由,用不同的样式显示,免得被当成「他当时就是这么想的」。
    const PLACEHOLDER = /^[（(]这次模型没给出可读的思考[）)]$/;
    const list = (thoughts || []).filter((t) => t.text);
    q('rvThink').innerHTML = list.length
      ? list.map((t) => {
        const isPlaceholder = PLACEHOLDER.test(String(t.text).trim());
        return `
          <div class="rvthink${isPlaceholder ? ' rvthink--none' : ''}">
            <div class="rvthink__who">${escapeHtml(t.name)}</div>
            <div class="rvthink__text">${escapeHtml(t.text)}</div>
          </div>`;
      }).join('')
      : '<div class="review__empty">这一手没留下思考记录(可能是本地策略,或思考气泡被关掉了)。</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function show() { el.classList.add('is-open'); }
  function hide() { el.classList.remove('is-open'); }
  function isOpen() { return el.classList.contains('is-open'); }

  q('rvClose').addEventListener('click', () => { hide(); onClose?.(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { hide(); onClose?.(); }
  });

  return { el, fill, show, hide, isOpen };
}
