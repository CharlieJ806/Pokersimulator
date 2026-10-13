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

const app = new GameApp(document.getElementById('app'));
window.__poker = app;

app.init().then(() => {
  // 手机上把占位的侧栏收起来,把屏幕还给 3D 牌桌。
  // 等一帧是因为 SceneTable 在 init() 里才建好。
  requestAnimationFrame(() => {
    if (app.table) installMobileLayout(app.table);
  });
}).catch((err) => {
  console.error(err);
  const box = document.getElementById('app');
  if (box) {
    // 给出比堆栈更有用的排查提示
    const hint = /WebGL|webgl/i.test(String(err?.message || ''))
      ? '<p style="margin-top:12px;color:#bbb">这台设备/浏览器没有可用的 WebGL,3D 牌桌无法渲染。</p>'
      : '';
    box.innerHTML = `<pre class="no-webgl">启动失败:\n${err?.stack || err}</pre>${hint}`;
  }
});
