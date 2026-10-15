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

export function createHome(root, { onPick, onModels } = {}) {
  const el = document.createElement('div');
  el.className = 'setup home';
  el.innerHTML = `
    <div class="setup__card setup__card--wide home__card">
      <!-- 头图:牌室后墙上挂的那幅画(样式里引用 assets/decor/painting.jpg) -->
      <div class="home__hero" aria-hidden="true"></div>
      <div class="home__brand">
        <div class="home__logo">♠</div>
        <div>
          <h1>扑克模拟器 <span class="setup__ver">POKER SIMULATOR</span></h1>
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
        <div class="setup__footInfo">${window.pokerAPI?.isWeb
    ? '模型请求经同源 Worker 转发,API Key 只存在这个浏览器的本地存储里。'
    : '模型请求走本机主进程代理,API Key 只存在你自己的设置文件里。'}</div>
        <!-- 开局**之前**也能配模型。
             以前这个入口只在游戏里的顶栏,于是必须先随便开一局、再进去改 ——
             而那时候名字/立绘早就按默认模型建好了,用户看到的就是
             「只能在开局后配,配了又不生效」这个逻辑漏洞。 -->
        <button class="btn btn--ghost" id="homeModels">⚙ 模型与 API Key</button>
        <!-- 角色立绘的署名 —— CC BY-NC-SA 4.0 要求署名,分发出去的应用里必须看得见。
             完整条款与逐作者署名见 THIRD-PARTY-NOTICES.md 与 assets/portraits/SOURCES.md。 -->
        <div class="setup__credit">
          角色立绘来自 <b>CrossPet</b> 及其社区作者 · 许可 <b>CC BY-NC-SA 4.0</b>
          (署名 · 非商业性使用 · 相同方式共享)
        </div>
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

  // 开局前也能配模型。**不关主页** —— 关掉的话用户配置完还得重新找入口;
  // 模型面板是盖在最上层的抽屉,回车/保存后回到主页正好接着选模式。
  q('#homeModels')?.addEventListener('click', () => onModels?.());

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
    // ⚠️ 这里必须把可能残留的内联 display 清掉。
    //    以前 hide() 会设 el.style.display = 'none',而内联样式的优先级
    //    高于 .setup.is-open 的 opacity —— 于是「退出本局,回主页」点了以后
    //    主页永远是 hidden(状态其实已经重置了,只是屏幕上看不到,像是按钮失灵)。
    //    现在改成完全依赖 CSS 的 opacity + pointer-events,不再碰 display。
    el.style.display = '';
    el.classList.add('is-open');
  }

  function hide() {
    el.classList.remove('is-open');
    // 不再延时设 display:none —— 隐藏交给 CSS(.setup 的 opacity:0 + pointer-events:none),
    // 淡出由 transition 完成。额外设 display 既多余,又会把 show() 堵死(见上面的注释)。
    clearTimeout(closeTimer);
  }

  return { show, hide, el, isOpen: () => el.classList.contains('is-open') };
}
