/**
 * 导航流程回归:主页 → 模型面板 → 关闭 → 玩家模式设置页 → 逐座位分配 → 返回主页。
 *
 * 这几个入口以前都是坏的(用户反馈「操作流程卡手」):
 *   · 主页「模型与 API Key」:面板打开了,但被主页整个挡在下面;
 *   · 开局设置页没有任何返回按钮;
 *   · 逐座位分配只能进了牌桌才能点。
 * 断言都查**真实可见性**(elementFromPoint),不只查 class。
 *
 * 用法: node tools/buildweb.mjs && node tools/webserve.mjs 5173 & node_modules/.bin/electron tools/navflow.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');
const log = (m) => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; log('  ok  ' + m); } else { fail++; log(`  x   ${m} ${d}`); } };

app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await win.loadURL(process.env.WEB_URL || 'http://127.0.0.1:5173/');
  const js = (c) => win.webContents.executeJavaScript(c, true);
  for (let i = 0; i < 60 && !(await js("!!document.querySelector('.modecard')")); i++) await sleep(150);
  await sleep(500);

  // 某个元素是不是真的「在最上面、点得到」
  const onTop = (sel) => js(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return false;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
    return !!hit && (hit === e || e.contains(hit));
  })()`);

  // 1. 主页 → 模型面板
  await js("document.querySelector('#homeModels').click()");
  await sleep(600);
  ok(await onTop('#mdlClose'), '主页点「模型与 API Key」→ 模型面板真的出现在最上层');
  await js("document.querySelector('#mdlClose').click()");
  await sleep(500);
  ok(await onTop('.modecard'), '关闭模型面板 → 回到主页');

  // 2. 玩家模式设置页 → 逐座位分配
  await js("[...document.querySelectorAll('.modecard')].find(e => /玩家/.test(e.textContent)).click()");
  await sleep(600);
  ok(await onTop('#setupBack'), '开局设置页有「返回主页」按钮');
  ok(await onTop('#btnSeatModels'), '开局设置页有「逐座位分配模型」入口');
  await js("const s = document.querySelector('.setup--lobby #seats'); s.value = 8; s.dispatchEvent(new Event('input'));");
  await js("document.querySelector('#btnSeatModels').click()");
  await sleep(600);
  ok(await onTop('#mdlClose'), '从设置页打开模型面板,盖在设置页上面');
  const rows = await js("document.querySelectorAll('[data-seat-provider]').length");
  ok(rows === 8, '模型面板按设置页当前的人数(8)列座位', `实际 ${rows}`);

  // 3. 在模型面板里换默认厂商 → 保存 → 设置页的默认厂商跟着变
  await js(`(() => { const s = document.querySelector('#defProvider'); s.value = 'openai'; s.dispatchEvent(new Event('change')); })()`);
  await js("document.querySelector('#mdlSave').click()");
  await sleep(700);
  const prov = await js("document.querySelector('.setup--lobby #provider').value");
  ok(prov === 'openai', '模型面板保存后,设置页的默认厂商同步更新(开局时不会被旧值覆盖)', `实际 ${prov}`);
  ok(await onTop('#setupBack'), '保存模型面板后回到设置页');

  // 4. 返回主页
  await js("document.querySelector('#setupBack').click()");
  await sleep(600);
  ok(await onTop('.modecard'), '设置页点「返回主页」→ 主页可见可点');
  const mode = await js('window.__poker.mode');
  ok(mode === null, '返回主页后模式已重置', `mode=${mode}`);
  ok(!(await js("document.body.classList.contains('is-player-mode')")), '玩家模式的界面改动已撤回');

  // 还原默认厂商,别把测试改动留在 localStorage 里
  await js("window.__poker.saveModelAssignment({ defaultProvider: 'deepseek' })");

  log(`\n===== 导航流程:通过 ${pass} 项,失败 ${fail} 项 =====`);
  app.exit(fail ? 1 : 0);
}).catch((e) => { log('!! ' + (e?.stack || e)); app.exit(1); });
