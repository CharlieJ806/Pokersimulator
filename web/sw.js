/* 桌游模拟器 —— Service Worker(PWA 的离线与更新机制)
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 手机上「加到主屏幕」只加了个快捷方式不够:没有 SW 就没有离线可用性,
 * 也没有任何生命周期保护。用户的三个诉求里,「刷新/被系统回收 → 对局全丢」
 * 靠对局快照解决(见 src/core/gameStore.js),而「PWA 化不完整」靠这个文件
 * 加上 manifest.json 解决。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  缓存策略(**按资源类型分开,核心目的是「不能把用户钉在旧版本上」**)
 * ══════════════════════════════════════════════════════════════════════
 * 这是 SW 最常见的坑:只要把 html/js 做成 cache-first,用户就会一直跑到旧版本 ——
 * 而且他自己完全看不出来(界面正常、数据正常,就是少个新功能)。
 * 所以这里**按资源分成三类**:
 *
 *   1. app shell(index.html / *.js / *.mjs / *.css / manifest.json)
 *      → **network-first,失败才回落到缓存**。
 *        联网时永远拿最新代码;断网时用缓存兜底(这时旧总比白屏好)。
 *   2. 静态素材(assets/portraits/**、assets/decor/**)
 *      → **cache-first + 后台刷新(stale-while-revalidate)**。
 *        立绘有几 MB,每次进页面都重新下载纯属浪费流量;用旧的先渲染,
 *        同时在后台更新缓存,下次进页面就是新的。
 *   3. **API 请求(模型调用)/ 非 GET / 跨域 / localhost 开发环境
 *      → 一律**不拦截**,直接穿透到网络。
 *        模型调用绝对不能缓存:它带 Key、带上下文,缓存一份既没意义又危险
 *        (还会让「重试」拿到上一次的响应)。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 更新机制(为什么能保证用户拿到新版本)────────────────────────────
 *   · CACHE_VERSION 变了 → 新 SW 装好 → skipWaiting + clients.claim 立即接管;
 *   · 接管后向所有页面发 'sw-updated';页面(web/main.js)收到后**只刷新一次**
 *     (用 sessionStorage 打标记,避免刷新风暴);
 *   · app shell 是 network-first,所以即使页面没刷新,下一次导航也已经拿到新代码;
 *   · activate 里删掉所有**非当前版本**的缓存,不占用户的存储额度。
 *   ⚠️ 改前端代码后**必须**把 CACHE_VERSION 加一,否则第 2 类(素材)的旧缓存
 *      不会被清,而 app shell 走 network-first 又会拿到新代码 —— 新旧混着跑更难查。
 *
 * ── 走过的坑(别踩回去)──────────────────────────────────────────────
 *   · Worker 的 assets 绑定配了 not_found_handling = single-page-application:
 *     找不到的路径会返回 **index.html + HTTP 200**,而不是 404。
 *     所以这里的 precache **只缓存真正需要的固定列表**,而且每次都看
 *     response.ok / content-type —— 否则会把一份 HTML 当成 .js 缓存下来,
 *     之后所有模块加载都报 MIME 错误(整站白屏,且清缓存前一直坏)。
 *   · sw.js 必须放在站点根且有**顶层作用域**(scope 默认就是它所在目录),
 *     所以它直接放在 web/dist 根,和 index.html 同级。
 *   · localhost / 127.0.0.1 一律不缓存:开发时每次都要拿到最新代码,
 *     被 SW 缓存住会浪费大量时间在「为什么我的改动没生效」上。
 */

/* 缓存版本:改前端代码后**必须**加一(见文件头「更新机制」) */
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `poker-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `poker-assets-${CACHE_VERSION}`;

/**
 * 安装时预缓存的东西(**只要 app shell**)。
 * 刻意**不含**立绘:
 *   · 立绘有 40 多张、合计约 4MB,一次性 addAll 在弱网下会把 install 拖到超时,
 *     而 install 失败 = SW 完全不工作(连离线兜底都没有);
 *   · 立绘走运行时 cache-first,用户实际看到哪几张就缓存哪几张,首次访问也更快。
 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './main.js',
  './pokerApi.js',
  './mobileLayout.js',
  './mobile.css',
  './src/ui/styles3d.css',
  './manifest.json',
];

/** 静态素材的路径前缀(cache-first + 后台刷新) */
const ASSET_PREFIXES = ['./assets/portraits/', './assets/decor/'];

/* ------------------------------------------------------------ 工具 */

/** 这个请求该不该由 SW 接管 */
function shouldHandle(request, url) {
  if (request.method !== 'GET') return false;             // POST(模型调用)一律放行
  if (url.origin !== self.location.origin) return false;   // 跨域(各家 API)不碰
  if (url.pathname.startsWith('/api/')) return false;      // Worker 的转发接口

  // 开发环境不缓存:本地起服务时永远要拿到最新代码,否则调半天才发现是缓存。
  // 判据用 hostname 而不是端口 —— wrangler dev / serve 的端口不固定。
  const h = self.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false;
  return true;
}

function isAsset(pathname) {
  return ASSET_PREFIXES.some((p) => pathname.includes(p));
}

/** app shell 的判据:文档、脚本、样式、清单 */
function isShell(request, url) {
  if (request.mode === 'navigate' || request.destination === 'document') return true;
  const d = request.destination;
  if (d === 'script' || d === 'style' || d === 'worker' || d === 'manifest') return true;
  return /\.(?:js|mjs|css|html|json)$/.test(url.pathname);
}

/**
 * 把响应放进缓存。
 * ⚠️ 只缓存**真正成功**的响应,而且拒绝把 HTML 当脚本/样式存
 *    (SPA 回退会返回 200 + text/html,见文件头的坑)。
 */
async function putInCache(cacheName, request, response) {
  if (!response || !response.ok || response.status !== 200) return;
  try {
    const url = new URL(request.url);
    const type = String(response.headers.get('content-type') || '');
    const wantsCode = /\.(?:js|mjs|css)$/.test(url.pathname) || request.destination === 'script' || request.destination === 'style';
    if (wantsCode && type.includes('text/html')) return;    // SPA 回退的 HTML,别存
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch { /* 缓存失败不影响这次请求 */ }
}

/* ------------------------------------------------------------ 生命周期 */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 逐个 add 而不是 addAll:addAll 是一个失败全失败,
    // 而 app shell 里任何一个文件缺失都不该让「整个 SW 装不上」。
    await Promise.all(SHELL_ASSETS.map(async (p) => {
      try {
        const req = new Request(p, { cache: 'reload' });
        const res = await fetch(req);
        await putInCache(SHELL_CACHE, req, res);
      } catch { /* 单个文件失败:运行时那条 network-first 兜底 */ }
    }));
    // 新版本立即接管(不等所有旧页面关掉)—— 配合页面的「刷新一次」
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉旧版本的缓存。**必须**做:否则用户的存储里会一直堆着历史版本,
    // 而且旧缓存里的文件可能被误用(比如同样的 URL、旧的内容)。
    const names = await caches.keys();
    await Promise.all(names.map((n) => (
      (n === SHELL_CACHE || n === ASSET_CACHE) ? null : caches.delete(n)
    )));
    await self.clients.claim();
    // 通知页面:可以刷新了(页面自己决定要不要刷,见 web/main.js)
    const list = await self.clients.matchAll({ type: 'window' });
    for (const c of list) {
      try { c.postMessage({ type: 'sw-updated', version: CACHE_VERSION }); } catch { /* 忽略 */ }
    }
  })());
});

/* ------------------------------------------------------------ 请求处理 */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!shouldHandle(request, url)) return;      // 不拦截 = 完全走网络

  if (isAsset(url.pathname)) {
    // 素材:cache-first + 后台刷新(stale-while-revalidate)
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(request);
      // 后台更新不 await:这次先把旧图给用户,更新完下一次就生效
      const refresh = fetch(request).then((res) => putInCache(ASSET_CACHE, request, res)).catch(() => {});
      if (hit) return hit;
      const res = await fetch(request);
      await putInCache(ASSET_CACHE, request, res);
      void refresh;
      return res;
    })());
    return;
  }

  if (isShell(request, url)) {
    // app shell:network-first —— 联网时永远拿最新代码,断网才回落到缓存。
    // 这是「用户不会卡在旧版本」的关键:cache-first 会让旧版本一直跑下去。
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        await putInCache(SHELL_CACHE, request, res);
        return res;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(request)
          // 导航失败的兜底:任何路径都给 index.html(SPA 的前端路由要它)
          || (request.mode === 'navigate' ? await cache.match('./index.html') : null);
        if (hit) return hit;
        return new Response('离线,而且这一项还没有被缓存过。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
  }
  // 其他同源 GET(比如字体、图片的其它目录):不拦截,交给浏览器自己的 HTTP 缓存
});

/**
 * 允许页面主动问版本(排查用),也留一个「立刻更新」的口子。
 * 不用 postMessage 直接调 skipWaiting 是刻意的:更新时机交给页面判断,
 * 免得用户正在等 AI 思考时页面自己刷新。
 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'version') {
    try { event.source?.postMessage({ type: 'version', version: CACHE_VERSION }); } catch { /* 忽略 */ }
  }
});
