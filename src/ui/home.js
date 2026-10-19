/**
 * 主页:先选**游戏**,再选这个游戏的**模式**。
 *
 *   第一层(游戏卡,来自 src/games/registry.mjs 的 listGames())
 *     ♠ 德州扑克 / 🐺 狼人杀 / 🕵️ 谁是卧底 —— 后两个 available:false,是灰卡。
 *   第二层(模式卡,只有点了能玩的游戏才出现)
 *     ♠ 荷官模式 / 玩家模式 —— 就是原来那两张卡,**样式与流程一字未改**。
 *
 * 为什么是两层而不是把「游戏 × 模式」摊平成一排卡:
 *   · 摊平之后每加一个游戏,主页就多两张卡,四个游戏就八张 —— 主页会变成菜单;
 *   · 而且「模式」对每个游戏含义完全不同(扑克是荷官/玩家,狼人杀以后是主持人/上帝视角),
 *     只有先选游戏,第二行的卡才说得清自己是什么。
 *
 * ⚠️ 交互层级:扑克**没有多出第三层**。点「德州扑克」= 现在主页上的那两张卡,
 *    点其中一张 = 和从前完全一样(onPick('dealer'|'player') → 设置页 / 玩家模式)。
 *    多的只有「先选哪个游戏」这一下 —— 而这一下 2a 阶段只有扑克能点。
 *
 * ⚠️ 第二层的两张卡**从第一帧起就在 DOM 里**(只是 hidden),不是点开游戏才创建:
 *    ① 现有的测试与截图工具都是直接 `document.querySelector('.modecard[data-mode="dealer"]').click()`,
 *       它们不经过游戏卡。把模式卡做成「点开才渲染」会让一大批回归和工具全部变红;
 *    ② 点 hidden 的元素在程序里仍然会触发 click —— 对测试是必需,对用户不可达
 *       (hidden 的层不接收鼠标事件),所以不构成「层级被绕过」。
 *
 * 回调(app.js 的调用点保持原样,只多了两个可选的):
 *   onPick(mode)      'dealer' | 'player'  ← 与从前完全一致
 *   onModels()        打开「模型与 API Key」
 *   onPickGame(game)  点了某张**能玩的**游戏卡(宿主用它记住 ui.lastGame)
 *   onResume/hideResume 见文件底部的说明
 */

import { DEFAULT_GAME_ID, getGame, listGames } from '../games/registry.mjs';
// 全局排行榜的 HTML 在共享模块里(纯字符串)。主页只负责「打开/关闭/读数据」——
// 换算与排序属于共享模块,主页再写一遍必然出现两套口径。
import { leaderboardHtml } from '../shared/leaderboard.mjs';

/**
 * 注册表里的玩法 key → 主页上那张卡。
 *
 * ⚠️ 为什么需要这张对照表(而不是直接拿 modes 里的字符串当 data-mode):
 *    modes 是**游戏**的说法('watch' 看 AI / 'join' 自己上桌),data-mode 是
 *    **界面**的历史叫法('dealer' / 'player'),app.js 与一批测试都在用后者。
 *    两边各自演进时,对照表只有这一份,加玩法只改这里。
 * ⚠️ 表里没有的 mode 会被安静跳过(filter(Boolean)):游戏声明了一个主页还不会画的
 *    玩法时,不该整页报错 —— 但也别在表里留「猜」出来的条目。
 */
const MODE_CARDS = {
  // 看 AI 打(荷官模式)
  watch: {
    mode: 'dealer',
    icon: '<span class="ic ic--dealer">♠</span>',
    title: '荷官模式',
    // 描述原本是「前半句 + 下面一串列表项」拼起来的,列表数据删掉后
    // 这里补成完整的一句,免得正文以逗号结尾。
    desc: '你是荷官:发牌、控节奏、看别人打。桌上全是独立的大模型牌手,'
      + '每个人有自己的性格和思路。',
    cta: '进入荷官模式',
  },
  // 自己上桌(玩家模式)
  join: {
    mode: 'player',
    icon: '<span class="ic ic--player"><i></i></span>',
    title: '玩家模式',
    desc: '你自己上桌打,牌局进行中看不到别人的思考 —— 等这一手结束,再翻记录回头看。',
    cta: '进入玩家模式',
  },
};

const STREET_TEXT = {
  idle: '还没开局', preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈', showdown: '摊牌',
};

/** 存档时间的口语化说法:手机上看「3 分钟前」比一串时间戳有用得多 */
function agoText(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/**
 * 一张游戏卡。
 *
 * 视觉**完全复用** `.modecard` 那套样式(styles3d.css 里 `.gamecard` 与 `.modecard`
 * 同一组规则):底子、圆角、阴影、图标框、标题/正文/CTA 的字号全部一致 ——
 * 用户明确要求「主页风格不变」,所以这里不新造任何视觉,只多一个根类名。
 * ⚠️ 卡内部的类名照抄 `modecard__top` 之类**是为了白蹭现成规则**;root 不能叫
 *    `.modecard`,因为 `.modecard` 现在是「模式卡」的选择器(smoke.mjs 断言主页上
 *    恰好两张 `.modecard`,而且模式卡是可点的)。
 *
 * 灰卡(available:false):
 *   · `disabled` —— 让浏览器**真的不派发点击**,而不是靠 onPickGame 里判一下;
 *   · `gamecard--soon` —— 压淡 + 悬停时不抬起来(见 styles3d.css);
 *   · 右上「敬请期待」小标 —— 明确说清为什么点不动(灰着不解释等于坏掉)。
 */
function gameCardHtml(game) {
  const soon = !game.available;
  // CTA 不给箭头:箭头是「点了会进去」的承诺,灰卡上没有这件事。
  const cta = soon ? '内部装修中' : '进入游戏 <b>→</b>';
  return `
          <button class="gamecard ${soon ? 'gamecard--soon' : ''}" data-game="${game.id}"${soon ? ' disabled aria-disabled="true"' : ''}>
            <div class="modecard__top">
              <span class="modecard__icon"><span class="ic">${game.icon}</span></span>
              ${soon ? '<span class="modecard__tag is-soon">敬请期待</span>' : ''}
            </div>
            <h2 class="modecard__title">${game.title}</h2>
            <p class="modecard__desc">${game.desc}</p>
            <span class="modecard__cta">${cta}</span>
          </button>`;
}

/**
 * 主页「游戏卡」那一屏的 HTML(**纯函数**)。
 *
 * 导出它不是为了别处复用,是为了 tools/registrytest.mjs 能在**纯 Node**里断言
 * 「卡片数量 = listGames().length」:渲染是模板层的事,没必要为此开一个 Electron。
 * 有人在这里写死卡片数量时,那条断言会立刻红。
 * @param {object[]} [games] 默认取注册表(顺序 = 卡片顺序)
 */
export function gameCardsHtml(games = listGames()) {
  return games.map((g) => gameCardHtml(g)).join('');
}

/**
 * 「继续上一局」那一块的 HTML。
 *
 * 为什么放在主页**显眼**的位置、而且必须由用户点:
 *   手机浏览器/PWA 一进后台就可能被系统回收,回来时页面等于重新加载。
 *   如果静默恢复成牌桌,用户会以为「我刚才在看主页,怎么突然进了牌局」;
 *   而直接丢掉又等于白打。所以给两个明确的入口:**继续**或**放弃**。
 * 默认 display:none —— 没有存档时它不该占任何位置(showResume 里才打开)。
 */
function resumeBarHtml() {
  return `
      <div class="home__resume" id="homeResume" hidden>
        <div class="home__resumeHead">
          <span class="home__resumeIcon" aria-hidden="true">↻</span>
          <div>
            <div class="home__resumeTitle">发现上一局存档</div>
            <div class="home__resumeSub" id="homeResumeSub"></div>
          </div>
        </div>
        <div class="home__resumeBtns">
          <button class="btn btn--primary" id="homeResumeGo">继续上一局</button>
          <button class="btn btn--ghost" id="homeResumeDrop">放弃</button>
        </div>
      </div>`;
}

export function createHome(root, {
  onPick, onModels, onPickGame, onResume, onDiscard,
  // 全局排行榜:主页不自己读存储 —— 版本校验/排序/换算都在 shared/leaderboard.mjs,
  // 这里只拿「一排已经排好序的行」来画(与「继续上一局」同一条原则:
  // 主页不重复实现存储层的判断)。
  getLeaderboard, clearLeaderboard,
} = {}) {
  const el = document.createElement('div');
  el.className = 'setup home';
  el.innerHTML = `
    <div class="setup__card setup__card--wide home__card">
      <!-- 头图:牌室后墙上挂的那幅画(样式里引用 assets/decor/painting.jpg) -->
      <div class="home__hero" aria-hidden="true"></div>
      <div class="home__brand">
        <div class="home__logo">♠</div>
        <div>
          <h1>桌游模拟器 <span class="setup__ver">TABLETOP SIMULATOR</span></h1>
        </div>
      </div>

      <!-- 第一层:游戏卡(数量由注册表决定,别在这里写死) -->
      <div class="home__games" id="homeGames">
        ${gameCardsHtml()}
      </div>

      <!-- 第二层:选中的那个游戏的模式卡。默认 hidden —— 主页第一眼是游戏列表,
           点了一张能玩的卡才切过来(setLayer)。模式卡的内容由 renderModes 填。 -->
      <div id="homeModes" hidden>
        <div class="home__layerHead">
          <button class="btn btn--ghost" id="homeBack">← 全部游戏</button>
          <div class="home__layerTitle" id="homeGameTitle"></div>
        </div>
        <div class="home__modes" id="homeModeGrid"></div>
      </div>

      ${resumeBarHtml()}

      <div class="setup__foot">
        <div class="setup__footInfo">${window.pokerAPI?.isWeb
    ? '模型请求经同源 Worker 转发,API Key 只存在这个浏览器的本地存储里。'
    : '模型请求走本机主进程代理,API Key 只存在你自己的设置文件里。'}</div>
        <!-- 开局**之前**也能配模型。
             以前这个入口只在游戏里的顶栏,于是必须先随便开一局、再进去改 ——
             而那时候名字/立绘早就按默认模型建好了,用户看到的就是
             「只能在开局后配,配了又不生效」这个逻辑漏洞。 -->
        <button class="btn btn--ghost" id="homeModels">⚙ 模型与 API Key</button>
        <!-- 全局排行榜:跨游戏、跨会话的持久化战绩(局内积分仍在各游戏的结算卡里)。
             入口放在主页页脚 —— 它是「平台级」的东西,不属于任何一个游戏的大厅。 -->
        <button class="btn btn--ghost" id="homeLeaderboard">🏆 全局排行榜</button>
        <!-- 角色立绘的署名 —— CC BY-NC-SA 4.0 要求署名,分发出去的应用里必须看得见。
             完整条款与逐作者署名见 THIRD-PARTY-NOTICES.md 与 assets/portraits/SOURCES.md。 -->
        <div class="setup__credit">
          角色立绘来自 <b>CrossPet</b> 及其社区作者 · 许可 <b>CC BY-NC-SA 4.0</b>
          (署名 · 非商业性使用 · 相同方式共享)
        </div>
      </div>

      <!-- 全局排行榜:与「游戏卡 / 模式卡」同一套**层**切换(第三层)。
           为什么不做成悬浮弹窗:主页这张卡片是 overflow:hidden 的滚动容器,
           祖先还有 backdrop-filter —— 在这两种祖先下 position:fixed 会被当成
           相对祖先定位并被裁掉,弹窗在手机上会跑出可见区域。做成一整层最稳,
           也顺手复用了现成的 .home__layerHead / .uc__rank 样式。 -->
      <div class="home__board" id="homeBoard" hidden>
        <div class="home__layerHead">
          <button class="btn btn--ghost" id="homeBoardClose">← 返回</button>
          <div class="home__layerTitle">🏆 全局排行榜</div>
        </div>
        <div class="home__boardBody uc__rank" id="homeBoardBody"></div>
      </div>
    </div>`;

  root.appendChild(el);

  const q = (s) => el.querySelector(s);
  let closeTimer = null;
  // 「继续上一局」按钮要交回去的那份快照(由 showResume 的第二个参数填)
  let resumeSnapshot = null;
  // 当前停在第二层的是哪个游戏(只用于第二层标题;能不能进由注册表的 available 决定)
  let openGameId = null;

  /* ------------------------------------------------ 两层之间的切换 */

  /**
   * 显示哪一层。`hidden` 属性 + CSS 的 `[hidden]{display:none}`。
   * ⚠️ 只写 `hidden` 是不够的:`.home__modes` 自己带 `display:grid`,
   *    作者样式的 display 会盖掉浏览器默认的 `[hidden]{display:none}` ——
   *    所以 styles3d.css 里另有一条 `.home__modes[hidden]{display:none}`
   *    (`.home__resume[hidden]` 早就踩过同一个坑,写法照抄)。
   */
  function setLayer(which) {
    const gamesBox = q('#homeGames');
    const modesBox = q('#homeModes');
    const boardBox = q('#homeBoard');
    if (gamesBox) gamesBox.hidden = which !== 'games';
    if (modesBox) modesBox.hidden = which !== 'modes';
    if (boardBox) boardBox.hidden = which !== 'board';
  }

  /** 把某个游戏的模式卡画进第二层(只画注册表声明过、且表里认识的玩法) */
  function renderModes(game) {
    const box = q('#homeModeGrid');
    if (!box) return;
    // 认不出的 mode 安静跳过:游戏声明了一个主页还不会画的玩法时不该整页报错。
    // 文案优先用**游戏自己给的**(game.modeCards),没有才用下面 MODE_CARDS 的扑克兜底 ——
    // 「荷官 / 发牌」对谁是卧底毫无意义,让文案跟着游戏走,主页就不用为每个游戏长一条分支。
    const cards = (game.modes || [])
      .filter((key) => MODE_CARDS[key])
      .map((key) => ({ key, ...MODE_CARDS[key], ...(game.modeCards?.[key] || {}) }));
    box.innerHTML = cards.map((m) => `
            <button class="modecard" data-mode="${m.mode}" data-game-mode="${m.key}">
              <div class="modecard__top">
                <span class="modecard__icon">${m.icon}</span>
              </div>
              <h2 class="modecard__title">${m.title}</h2>
              <p class="modecard__desc">${m.desc}</p>
              <span class="modecard__cta">${m.cta} <b>→</b></span>
            </button>`).join('');
    const title = q('#homeGameTitle');
    if (title) title.textContent = `${game.icon} ${game.title} · 选一个玩法`;
  }

  /**
   * 点了一张游戏卡。
   * @returns {boolean} 真的进去了没有
   */
  function openGame(gameId) {
    const game = getGame(gameId);
    // 灰卡靠 `disabled` 就点不动了,这里再判一次 available 是因为
    // 「用代码点它」的路(测试、键盘快捷键、以后的手势)绕得过 disabled ——
    // 而「能不能进」的判据只有注册表那一个字段。
    if (!game || !game.available) return false;
    openGameId = game.id;
    renderModes(game);
    setLayer('modes');
    // 宿主侧只需要知道「用户选了哪个游戏」(记 ui.lastGame);它不该在这里重建引擎 ——
    // 真正的开局仍然由第二层的模式卡走到 app.startGame。
    onPickGame?.(game);
    return true;
  }

  /* ------------------------------------------------ 第一层:游戏卡 */

  // 事件委托:游戏卡是**一次渲染**出来的,但委托在容器上就不用管以后
  // 「换一批游戏要重画」这类事(卡上不会再各自挂 listener,删了也不会留悬空引用)。
  q('#homeGames')?.addEventListener('click', (ev) => {
    const card = ev.target?.closest?.('.gamecard');
    if (!card) return;
    openGame(card.dataset.game);
  });

  /* ------------------------------------------------ 第二层:模式卡 */

  // 与从前一致:点一张模式卡 = 收主页 + 把模式名交回 GameApp。
  // (第二层的卡是 renderModes 画的,所以同样用委托。)
  q('#homeModeGrid')?.addEventListener('click', (ev) => {
    const card = ev.target?.closest?.('.modecard');
    if (!card) return;
    const mode = card.dataset.mode;
    hide();
    onPick?.(mode);
  });

  /** 回到第一层(点「← 全部游戏」,以及每次 show()) */
  function backToGames() {
    setLayer('games');
    openGameId = null;
  }

  // 「← 全部游戏」:回到第一层。没有这一颗的话,用户点了扑克就只能进一局再退出才看得到
  // 别的游戏 —— 那等于把「多游戏」这个改动变成了死路。
  q('#homeBack')?.addEventListener('click', () => backToGames());

  // 开局前也能配模型。**不关主页** —— 关掉的话用户配置完还得重新找入口;
  // 模型面板是盖在最上层的抽屉,回车/保存后回到主页正好接着选模式。
  q('#homeModels')?.addEventListener('click', () => onModels?.());

  /* ------------------------------------------------ 全局排行榜 */

  /** gameId → 中文名。榜里只存 id,标题由注册表给(模块不 import 注册表)。 */
  const GAME_NAMES = Object.fromEntries(listGames().map((g) => [g.id, g.title]));
  let boardOpen = false;

  /** 读一次并重画。读失败(存储被禁 / 坏数据)→ 画空榜,不弹错。 */
  async function renderBoard() {
    const body = q('#homeBoardBody');
    if (!body) return;
    body.innerHTML = '<div class="uc__rankDetail">读取中…</div>';
    let rows = [];
    try { rows = (await getLeaderboard?.()) || []; } catch { rows = []; }
    body.innerHTML = leaderboardHtml(rows, { gameNames: GAME_NAMES });
  }

  function openBoard() {
    const box = q('#homeBoard');
    if (!box) return;
    boardOpen = true;
    setLayer('board');
    renderBoard();
  }

  function closeBoard() {
    boardOpen = false;
    // 回到第一层(游戏列表):排行榜是「从主页点进去看看」的一层,
    // 关掉之后用户要接着选游戏,而不是停在第二层的某个游戏的模式卡上。
    backToGames();
  }

  q('#homeLeaderboard')?.addEventListener('click', () => openBoard());
  q('#homeBoardClose')?.addEventListener('click', () => closeBoard());

  /**
   * 面板内的点击:点「清空排行榜」= 两步确认。
   *
   * 为什么清空要两步:榜是长期战绩,误触一次全没了很恼人;而 confirm() 在 Electron
   * 里会卡住渲染进程(自动化 / 截图工具直接卡死)—— 与卧底「清空积分」同一个手法。
   */
  q('#homeBoard')?.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-board-clear]');
    if (!btn) return;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = '再点一次清空';
      return;
    }
    btn.dataset.armed = '';
    try { await clearLeaderboard?.(); } catch { /* 清不掉也把面板重画一遍,界面别停在旧数据上 */ }
    await renderBoard();
  });

  // 默认游戏(2a:扑克)的模式卡**在创建时就画好**:见文件头「从第一帧起就在 DOM 里」。
  // 认不出默认游戏时退回第一个能玩的 —— 不给一个空白的第二层。
  const defaultGame = getGame(DEFAULT_GAME_ID);
  const bootGame = defaultGame?.available ? defaultGame : listGames().find((g) => g.available);
  if (bootGame) renderModes(bootGame);

  /* ------------------------------------------------ 继续上一局(对局快照) */

  /**
   * 显示「继续上一局(第 N 手)」。第二个参数是快照本体,点「继续」时原样交回去。
   *
   * ⚠️ 这里**只负责显示与暂存** —— 快照的解析/校验/丢弃全在 GameApp 那边
   *    (shared/gameStore.js 与 engine.validateSnapshot)。主页不重复实现一遍校验,
   *    否则「主页认为能用、引擎认为不能用」这种分歧迟早出现。
   * @param {{handNo:number, street:string, handOver:boolean, players:number, savedAt:number}} info
   * @param {object} [snap] 原样的快照对象
   */
  function showResume(info, snap) {
    const bar = q('#homeResume');
    if (!bar || !info) return;
    if (snap) resumeSnapshot = snap;
    const sub = q('#homeResumeSub');
    if (sub) {
      const parts = [
        `第 ${info.handNo} 手`,
        STREET_TEXT[info.street] || info.street || '',
        info.players ? `${info.players} 人` : '',
        agoText(info.savedAt),
      ].filter(Boolean);
      sub.textContent = parts.join(' · ');
    }
    bar.hidden = false;
    bar.classList.add('is-open');
  }

  function hideResume() {
    const bar = q('#homeResume');
    if (!bar) return;
    bar.hidden = true;
    bar.classList.remove('is-open');
    // 顺手把快照引用放掉:留着的话「放弃」之后它还在内存里,
    // 下次 showResume 忘了传第二个参数就会拿着旧快照恢复
    resumeSnapshot = null;
  }

  q('#homeResumeGo')?.addEventListener('click', () => {
    const bar = q('#homeResume');
    if (bar) bar.hidden = true;     // 先收起来:恢复失败时也不会留一个点不动的按钮
    const snap = resumeSnapshot;
    // ⚠️ 这里**不调 hide()**:恢复要先把牌桌建起来,由 GameApp 决定什么时候收主页。
    //    提前收掉的话,恢复失败(存档损坏)就会停在一片空白上。
    onResume?.(snap);
  });
  q('#homeResumeDrop')?.addEventListener('click', () => {
    hideResume();
    onDiscard?.();
  });

  function show() {
    clearTimeout(closeTimer);
    // 回主页永远从第一层开始 —— 也顺手收掉排行榜面板:
    // 从「一场打完 → 回主页」回来时,用户要看的是游戏列表,不是刚才那张榜。
    closeBoard();
    // ★ 每次回主页都从**第一层(游戏列表)**开始,而不是记住上次选了哪个游戏:
    //   「退出本局」的语义是回到入口,而入口现在就是游戏列表。停在第二层的话,
    //   用户会以为自己被困在扑克里(想看狼人杀得先猜「返回」在哪)。
    backToGames();
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

  return {
    show,
    hide,
    el,
    isOpen: () => el.classList.contains('is-open'),
    /** 当前停在第二层的是哪个游戏(第一层时为 null)。2a 里只可能是 'poker'。 */
    openGameId: () => openGameId,
    /**
     * 「继续上一局」那一块的显隐。
     * ⚠️ 必须由 GameApp 显式调这两下,别在这里自动读存储:
     *    读存档要经过版本校验与「坏档就丢」的处理,那些逻辑在
     *    shared/gameStore.js + engine.validateSnapshot 里只有一份,
     *    主页再写一遍必然出现两条判据不一致的情况。
     */
    showResume,
    hideResume,
    /**
     * 刚记完一场 → 如果面板开着就重画一次(没开就什么都不做)。
     * 由宿主在写榜成功后调;主页不自己去猜「什么时候有新数据」。
     */
    refreshLeaderboard: () => { if (boardOpen) renderBoard(); },
  };
}
