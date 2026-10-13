import { GameApp } from './app.js';

const app = new GameApp(document.getElementById('app'));
window.__poker = app;   // 方便在开发者工具里调试

app.init().catch((err) => {
  console.error(err);
  document.getElementById('app').innerHTML =
    `<pre style="color:#f88;padding:24px;font:13px/1.6 ui-monospace,monospace">启动失败:\n${err?.stack || err}</pre>`;
});
