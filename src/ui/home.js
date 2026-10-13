/**
 * 主页:选模式。
 *
 *   · 荷官模式 —— 就是现有的玩法:你坐在桌边发牌、控节奏、看 6~9 个 AI 打牌。
 *   · 玩家模式 —— 入口先放这里,具体玩法待定(点进去是一个「还在做」的占位页)。
 *
 * 这一屏只负责选模式,选完把控制权交回 GameApp:
 *   onPick('dealer') → 打开现有的开局设置面板
 *   onPick('player') → 目前弹提示,等玩法确定后接上
 */

const MODES = [
  {
    id: 'dealer',
    icon: '<span class="ic ic--dealer">♠</span>',
    title: '荷官模式',
    // 描述原本是「前半句 + 下面一串列表项」拼起来的,列表数据删掉后
    // 这里补成完整的一句,免得正文以逗号结尾。
    desc: '你是荷官:发牌、控节奏、看别人打。桌上全是独立的大模型牌手,'
      + '每个人有自己的性格和思路。',
    cta: '进入荷官模式'
  },
  {
    id: 'player',
    icon: '<span class="ic ic--player"><i></i></span>',
    title: '玩家模式',
    desc: '你自己上桌打,牌局进行中看不到别人的思考 —— 等这一手结束,再翻记录回头看。',
    cta: '进入玩家模式',
    ready: true,
  },
];

export function createHome(root, { onPick } = {}) {
  const el = document.createElement('div');
  el.className = 'setup home';
  el.innerHTML = `
    <div class="setup__card setup__card--wide home__card">
      <div class="home__brand">
        <div class="home__logo">♠</div>
        <div>
          <h1>扑克模拟器 <span class="setup__ver">POKER DEALER</span></h1>
        </div>
      </div>

      <div class="home__modes">
        ${MODES.map((m) => `
          <button class="modecard ${m.soon ? 'modecard--soon' : ''}" data-mode="${m.id}">
            <div class="modecard__top">
              <span class="modecard__icon">${m.icon}</span>
              ${m.tag ? `<span class="modecard__tag ${m.soon ? 'is-soon' : 'is-ready'}">${m.tag}</span>` : ''}
            </div>
            <h2 class="modecard__title">${m.title}</h2>
            <p class="modecard__desc">${m.desc}</p>
            ${m.points?.length ? `<ul class="modecard__points">
              ${m.points.map((p) => `<li>${p}</li>`).join('')}
            </ul>` : ''}
            <span class="modecard__cta">${m.cta} <b>→</b></span>
          </button>`).join('')}
      </div>

      <div class="setup__foot">
        <div class="setup__footInfo">模型请求走本机主进程代理,API Key 只存在你自己的设置文件里。</div>
      </div>
    </div>`;

  root.appendChild(el);

  const q = (s) => el.querySelector(s);
  let closeTimer = null;

  el.querySelectorAll('.modecard').forEach((card) => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      hide();
      onPick?.(mode);
    });
  });

  function showSoon(card) {
    let note = card.querySelector('.modecard__note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'modecard__note';
      note.textContent = '这个模式还没实现。';
      card.appendChild(note);
    }
    note.classList.add('is-show');
  }
  void showSoon;

  function show() {
    clearTimeout(closeTimer);
    el.classList.add('is-open');
  }

  function hide() {
    el.classList.remove('is-open');
    // 等淡出动画结束再真正隐藏,避免闪一下
    closeTimer = setTimeout(() => { el.style.display = 'none'; }, 260);
  }

  return { show, hide, el, isOpen: () => el.classList.contains('is-open') };
}
