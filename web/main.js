/**
 * 浏览器版入口。
 *
 * 为什么需要这个文件:
 *   本来想直接在 index.html 里写内联 `<script type="module">` 来先装 pokerAPI、
 *   再启动应用。但项目的 CSP 是 `script-src 'self'`,内联脚本会被直接拦掉
 *   (控制台会报 "Refused to execute inline script")。放宽成 'unsafe-inline'
 *   或者算 hash 都不如直接挪到外部文件 —— CSP 保持严格,启动顺序也一目了然。
 *
 * 顺序很重要:pokerAPI 必须在 GameApp 之前装好,
 * 因为 GameApp.init() 第一件事就是 await window.pokerAPI.getConfig()。
 */
import { installWebApi } from './pokerApi.js';
import { GameApp } from './src/ui/app.js';
import { installMobileLayout } from './mobileLayout.js';

installWebApi();

// 注册 Service Worker(PWA 的离线与更新机制,策略见 web/sw.js 的文件头)。
// 放在应用启动**之前**、且不 await:SW 的安装是后台的事,
// 它绝不该拖慢首屏;注册失败(老浏览器 / 非 https)也绝不能影响游戏。
installServiceWorker();

const app = new GameApp(document.getElementById('app'));
window.__poker = app;

app.init().then(() => {
  // 手机上把占位的侧栏收起来,把屏幕还给 3D 牌桌。
  // 等一帧是因为 SceneTable 在 init() 里才建好。
  requestAnimationFrame(() => {
    if (app.table) installMobileLayout(app.table);
  });
  return runDebugScenario(app);          // ?snap= / ?resume= 调试入口,见下面
}).catch((err) => {
  console.error(err);
  const box = document.getElementById('app');
  if (box) {
    // 给出比堆栈更有用的排查提示
    const hint = /WebGL|webgl/i.test(String(err?.message || err))
      ? '<p style="margin-top:12px;color:#bbb">这台设备/浏览器没有可用的 WebGL,3D 牌桌无法渲染。</p>'
      : '';
    box.innerHTML = `<pre class="no-webgl">启动失败:\n${err?.stack || err}</pre>${hint}`;
  }
});

/**
 * URL 上的两个**调试入口**(只在 localhost / 127.0.0.1 生效)。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 「续玩」这条链路的验收必须在**真浏览器**里做:纯 Node 测不到 DOM
 * (主页那块「继续上一局」、按钮点击、恢复后牌桌有没有起来)。
 * 而 headless Chrome 的一次性跑法(`--dump-dom`)没法点按钮 ——
 * 于是把「造一份存档」「点继续」这两步做成 URL 参数,让无头浏览器一次跑完。
 *
 * ── 为什么只在本机生效 ──────────────────────────────────────────────
 *   · `?snap=1` 会往 localStorage 里写一份**编造的**快照。线上用户误触到它
 *     就会覆盖自己真实的存档;而本机是拿来跑验收和复现 bug 的,正需要这个能力。
 *   · 两个参数都不做任何「特殊逻辑」:snap 走的是页面里真实的引擎 + 真实的
 *     saveGameNow();resume 调的就是主页那个按钮的 click。
 *     所以它们验的是真链路,而不是另写一条测试专用的捷径。
 *
 * 用法(tools/pwaverify.mjs 里就是这么用的):
 *   ?snap=1              造 4 人一局、发一手、立刻强存 → 页面上出现「继续上一局」
 *   ?resume=1            点一次「继续上一局」
 *   ?snap=1&resume=1     一步走完「存档 → 恢复」(推荐)
 *   ?snap=1&drop=1       造完再点「放弃」(验「放弃」真的把存档删了)
 *   ?swprobe=1           把 Service Worker 的支持情况与已注册数量写进 data-* 标记
 *                        (headless 一次性跑法读不到 navigator,只能这样把它带出来)
 *   ?measure=1           把主页那块提示与两个按钮的**实际尺寸**写进 data-* 标记
 *
 * ⚠️ resume / drop 都会**先确保有一份存档**:没有就现场造一份小的(见 ensureSnapshot)。
 *    为什么:验收用 headless Chrome,**每次启动一个独立的 user-data-dir** ——
 *    跨进程复用同一个 profile 目录时,localStorage 落盘是异步的,
 *    下一次 Chrome 启动**不一定**读得到上一次写的内容(实测会偶发丢)。
 *    靠「同一 profile 连续启动」来做测试会变成随机失败,那种 flaky 测试比没有测试更糟。
 */
async function runDebugScenario(app) {
  let q;
  try { q = new URLSearchParams(location.search); } catch { return; }
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!local) return;

  /** 确保 localStorage 里有一份**能通过校验**的存档(没有就造一份小的) */
  const ensureSnapshot = () => {
    if (app.gameStore?.load()) return 'kept';
    // 这一段刻意用**小筹码、少座位**:验收只关心「有没有存档、能不能续上」,
    // 不需要真打一局,越快越好。走的是与 ?snap=1 完全相同的真实链路。
    const keep = { gameSettings: app.gameSettings, mode: app.mode, engine: app.engine, running: app.running };
    app.gameSettings = {
      seats: 2, startingStack: 200, smallBlind: 5, bigBlind: 10,
      ante: 0, bigBlindAnte: false, blindLevelUp: false, blindLevelHands: 20, shortDeck: false,
    };
    app.mode = 'dealer';
    app.buildEngine();
    app.table.buildSeats(2);
    app.running = true;
    app.engine.startHand();
    app.saveGameNow();
    // 把「临时牌局」撤掉,回到冷启动的样子(否则「继续上一局」显得多余)
    app.exitToHome();
    app.checkPendingSnapshot();
    void keep;
    return 'created';
  };
  // 收尾标记:验收脚本(tools/pwaverify.mjs)靠它判断「页面确实跑完了启动流程」。
  // 放在 try 外面 —— 里面任何一步失败也要留下这个标记,否则验收脚本会把
  // 「入口抛错」误判成「页面根本没起来」。
  try {
    if (q.get('snap') === '1') {
      app.gameSettings = {
        seats: 4, startingStack: 2000, smallBlind: 10, bigBlind: 20,
        ante: 0, bigBlindAnte: false, blindLevelUp: true, blindLevelHands: 3, shortDeck: false,
      };
      app.mode = 'dealer';
      app.buildEngine();
      app.table.buildSeats(4);
      app.running = true;
      app.engine.startHand();
      app.saveGameNow();
      // 造完存档后把这个「临时牌局」撤掉,让页面回到**冷启动**的样子 ——
      // 否则「继续上一局」会显得多余(牌桌本来就在),验不出启动时读存档这条路径
      app.exitToHome();
      app.checkPendingSnapshot();
      document.documentElement.dataset.snapSeeded = '1';
    }
    if (q.get('drop') === '1') {
      // ⚠️ 先确保有存档再点「放弃」:验收是每次一个干净 profile,
      //    没有存档时那个按钮根本不存在(display:none),点了等于没测
      document.documentElement.dataset.snapPre = ensureSnapshot();
      // 走主页那个按钮,而不是直接调 abandonSnapshot —— 验的是真链路
      const btn = document.getElementById('homeResumeDrop');
      if (btn) btn.click();
      // 删完之后必须**再读一次存储**才算验到:不能只看内存里那个引用被清了
      document.documentElement.dataset.snapDropped = app.gameStore?.load() ? '0' : '1';
    }
    if (q.get('resume') === '1') {
      // 同上:先确保有存档(可能是本次现场造的,也可能上一次写下的还在)
      document.documentElement.dataset.snapPre = ensureSnapshot();
      /**
       * ★ 造完档之后**停掉自动出牌**。
       *
       * 为什么必须停:验收脚本用的是 `chrome --headless=new --virtual-time-budget=N
       * --dump-dom` 这种一次性跑法 —— 它靠「虚拟时间预算耗尽」来判定「页面跑完了」。
       * 而恢复之后 `resumeCurrentHand()` 会接着打这一手,打完还会自动开下一手;
       * 每一步的 `await sleep(...)` 都在推进虚拟时钟 —— 于是预算永远不耗尽,
       * Chrome 一直不输出 DOM,验收直接卡死(实测就是这个现象)。
       *
       * 所以:这一趟只验「恢复本身」(引擎有没有接上、牌桌有没有起来、手数对不对),
       * 「恢复之后还能不能继续打」由 tools/snapshotest.mjs 的 [2] 项在纯 Node 里
       * 逐条断言(那里是确定性的、不会挂)。
       * ⚠️ 只 stub「发下一手」这两个入口,引擎状态与恢复流程都是真的 ——
       *    所以这一步不会把「恢复坏了」伪装成通过。
       */
      app.dealNext = async () => {};
      app.resumeCurrentHand = async () => {};
      const btn = document.getElementById('homeResumeGo');
      if (btn) btn.click();
      // 恢复是异步的(startGame + restore),等牌桌真的起来再打标记
      for (let i = 0; i < 80 && !(app.engine && app.engine.state.handNo >= 1); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      document.documentElement.dataset.resumed = app.engine ? String(app.engine.state.handNo) : '0';
    }
    if (q.get('swprobe') === '1') {
      const supported = !!navigator.serviceWorker;
      let count = -1;
      if (supported) {
        try { count = (await navigator.serviceWorker.getRegistrations()).length; } catch { count = -2; }
      }
      document.documentElement.dataset.swSupported = supported ? '1' : '0';
      document.documentElement.dataset.swCount = String(count);
    }
    if (q.get('measure') === '1') {
      /**
       * 把几个关键元素的**实际尺寸**写进 data-* 标记。
       *
       * 为什么要这一手:验收是「headless 一次性跑法」(chrome --dump-dom),
       * 脚本拿到的只有 HTML,没法在里面执行 JS 去量 getBoundingClientRect。
       * 而「手机上这块提示会不会挡到模式卡、按钮够不够大」正是必须**量**的东西
       * (拍脑袋写 CSS 在这个仓库已经出过好几次「看着对、量了不对」)。
       * 所以让页面自己量好,把结果放进 DOM 让脚本读走。
       * 强制布局是同步的,量完立刻就有值,不需要等 rAF。
       */
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'none';
        const r = el.getBoundingClientRect();
        return `${r.width.toFixed(1)}x${r.height.toFixed(1)}`;
      };
      document.documentElement.dataset.measureBar = rect('#homeResume');
      document.documentElement.dataset.measureGo = rect('#homeResumeGo');
      document.documentElement.dataset.measureDrop = rect('#homeResumeDrop');
      document.documentElement.dataset.measureVp = `${window.innerWidth}x${window.innerHeight}`;
    }
  } catch (err) {
    // 调试入口出错不能影响正常游戏:只留个标记,验收脚本会看到
    document.documentElement.dataset.debugError = String(err?.message || err);
    console.warn('[debug] 调试场景失败:', err);
  } finally {
    document.documentElement.dataset.booted = '1';
  }
}

/**
 * 注册 Service Worker。
 *
 * ── 为什么要「新版本接管后自动刷新一次」────────────────────────────────
 * sw.js 里新版本会 skipWaiting + clients.claim 立即接管。这时**页面里的 JS
 * 还是旧的那一份**(已经加载进内存了),于是会出现「代码是旧的、SW 是新的」
 * 这种最难查的状态:用户报「我明明更新了」,而我们看到的是他跑着旧代码。
 * 所以接管之后刷一次页面,让新代码真正生效。
 *
 * ⚠️ 三个必须守住的边界:
 *   1. **只在「本来就有 SW 在控制」时才刷**。首次安装也会触发 controllerchange,
 *      不加这个判断的话第一次访问就自己刷一次(用户会看到闪一下);
 *   2. 用 sessionStorage 打标记,**一个会话只刷一次** —— 否则一旦
 *      controllerchange 反复触发就是刷新风暴;
 *   3. 正在打一手牌(引擎存在且这一手没结束)时**不刷**:刷新虽然不丢牌局
 *      (有快照),但会把用户正在看的动画和思考过程打断。留到他自己刷新。
 *
 * ── 为什么不在 localhost 上注册 ────────────────────────────────────
 * 本机开发时 SW 会把请求缓存住,改一行代码要清缓存才看得到 ——
 * 这是最浪费时间的坑之一,而本地又不需要离线能力。sw.js 里也有一道同样的判断。
 */
function installServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const { protocol, hostname } = location;
  if (protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    // http 的局域网地址(比如手机上连 192.168.x.x 调试)不是安全上下文,注册必然失败
    return;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') return;

  // 注册前先记下「有没有 SW 在控制本页」:首次安装时它是 null,
  // 有了它才能区分「首次安装」与「版本更新」(见上面边界 1)
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
    // 每次回到前台顺手查一次更新:手机上的 PWA 可能几天都不关,
    // 只靠「下次启动」查更新的话,用户会一直跑着几天前的版本。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
    // 新 SW 装好等接管(它自己会 skipWaiting,这里只是尽早发现)
    reg.addEventListener?.('updatefound', () => { /* 具体动作统一放在 controllerchange */ });
  }).catch((err) => {
    console.warn('[sw] 注册失败(不影响游戏):', err?.message || err);
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;                                     // 边界 1
    try {
      if (sessionStorage.getItem('poker-sw-reloaded') === '1') return;  // 边界 2
      sessionStorage.setItem('poker-sw-reloaded', '1');
    } catch { /* 隐私模式下 sessionStorage 可能不可用:那就退化成不自动刷,由用户手动刷 */ }
    const app = window.__poker;
    const st = app?.engine?.state;
    if (st && st.handNo > 0 && !st.handOver) {                      // 边界 3
      console.info('[sw] 新版本已就绪,但你正在打一手牌 —— 打完后手动刷新即可生效');
      return;
    }
    console.info('[sw] 已更新到新版本,正在刷新…');
    location.reload();
  });
}
