/**
 * 构建浏览器版到 web/dist/
 *
 * 设计原则:**不做打包/转译**。
 *   src/ 里除了主进程(src/main/)之外全是标准 ES 模块,浏览器能直接跑。
 *   所以这里只做「复制 + 校验」,产物源码可读、无 sourcemap、出问题好排查。
 *   唯一要注意的是**相对路径必须保持原样** —— 五个 3D 模块都写着
 *   `import * as THREE from '../../vendor/three.module.js'`,
 *   所以 dist 里 src/ 与 vendor/ 必须仍然同级。
 *
 * dist 结构(**入口摊平在根**,与仓库根保持一致,这正是相对路径能work的原因):
 *   web/dist/
 *     index.html          ← 浏览器版入口(来自 web/index.html)
 *     main.js             ← 启动脚本(必须外部文件:CSP 禁止内联脚本)
 *     pokerApi.js         ← window.pokerAPI 的浏览器实现
 *     mobile.css          ← 移动端适配
 *     src/**              ← 原样复制(排除 src/main/)
 *     vendor/three.module.js
 *
 * 为什么入口不放在 web/dist/web/ 下:
 *   3D 模块里写的是 `../../vendor/three.module.js`(从 src/ui3d/ 往上两级),
 *   所以 src/ 与 vendor/ 必须和「src 的父目录」同级。入口摊在根最省事,
 *   静态服务器的根目录也直接就是 dist,不用额外配置。
 *
 * 用法:
 *   node tools/buildweb.mjs              构建
 *   node tools/buildweb.mjs --out <dir>  指定输出目录(默认 web/dist)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : 'web/dist');

const log = (m) => process.stdout.write(m + '\n');
let warnings = 0;
const warn = (m) => { warnings += 1; log('  ! ' + m); };

/* ------------------------------------------------------------ 工具 */

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to, filter = () => true) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      n += copyDir(src, dst, filter);
    } else if (filter(src, entry.name)) {
      fs.copyFileSync(src, dst);
      n += 1;
    }
  }
  return n;
}

/* ------------------------------------------------------------ 开始 */

log(`构建浏览器版 → ${path.relative(ROOT, OUT)}`);
rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

/* 1. 入口与 web 层(摊平放在 dist 根,理由见文件头注释) */
log('\n[1] 入口与 web 适配层');
const webFiles = ['index.html', 'main.js', 'pokerApi.js', 'mobile.css', 'mobileLayout.js'];
for (const f of webFiles) {
  const src = path.join(ROOT, 'web', f);
  if (!fs.existsSync(src)) { warn(`缺少 web/${f}`); continue; }
  fs.copyFileSync(src, path.join(OUT, f));
  log(`  + ${f}`);
}

/* 2. src/(排除主进程 —— 那是 Electron 专用,浏览器里没有 ipcMain/fs) */
log('\n[2] src/(排除 src/main/)');
const MAIN_DIR = path.join(ROOT, 'src', 'main') + path.sep;
const nSrc = copyDir(
  path.join(ROOT, 'src'),
  path.join(OUT, 'src'),
  (full) => !full.startsWith(MAIN_DIR),
);
log(`  + src/ 共 ${nSrc} 个文件(已排除 src/main/)`);

/* 3. vendor */
log('\n[3] vendor/three.module.js');
const nVendor = copyDir(path.join(ROOT, 'vendor'), path.join(OUT, 'vendor'));
log(`  + vendor/ 共 ${nVendor} 个文件`);

/* 3b. assets/portraits —— 2D 立绘
 *
 * 为什么必须复制:src/ui3d/portraits2d.js 用的是相对路径
 *   ../../assets/portraits/...
 * 在 Electron 里从 src/ui3d/ 往上两级 = 仓库根的 assets/;
 * 在网页版里从 web/dist/src/ui3d/ 往上两级 = web/dist/assets/,
 * 所以只要把 assets/ 整体放到 dist 根,两个环境的相对路径就一致了。
 *
 * 顺带把许可与来源说明一起带上 —— CC BY-NC-SA 4.0 要求署名,
 * 发布出去的静态站点里必须有 LICENSE.md / SOURCES.md。 */
log('\n[3b] assets/portraits(2D 立绘)');
const PORTRAIT_SRC = path.join(ROOT, 'assets', 'portraits');
let nPortraits = 0;
if (fs.existsSync(PORTRAIT_SRC)) {
  nPortraits = copyDir(PORTRAIT_SRC, path.join(OUT, 'assets', 'portraits'));
  log(`  + assets/portraits 共 ${nPortraits} 个文件`);
  for (const f of ['LICENSE.md', 'SOURCES.md', 'manifest.js']) {
    if (!fs.existsSync(path.join(OUT, 'assets', 'portraits', f))) {
      warn(`assets/portraits/${f} 缺失 —— 许可是 CC BY-NC-SA 4.0,署名文件不能丢`);
    }
  }
  // manual.js 是手工素材的清单,portraits2d.js 会**静态 import** 它。
  // 缺了的话不是「少两个角色」而是整个模块加载失败(立绘全没),
  // 所以必须在构建期就拦住,而不是等运行时白屏。
  if (!fs.existsSync(path.join(OUT, 'assets', 'portraits', 'manual.js'))) {
    warn('assets/portraits/manual.js 缺失 —— portraits2d.js 静态 import 它,缺了整个立绘模块会加载失败。'
      + '先跑 node_modules/.bin/electron tools/prepmanualportraits.mjs');
  }

  /* 3c. **路径大小写**校验 —— 这条很值钱,别删。
   *
   * 为什么必须查:Worker 的 not_found_handling 是 single-page-application,
   * 找不到的资源会**返回 index.html + HTTP 200**,而不是 404。
   * 于是「清单里写 qwen/idle.webp,目录却叫 Qwen」这种错在本地完全看不出来
   * (Windows 不区分大小写),线上也不报错 —— 只是浏览器把 HTML 当图片解码失败,
   * **立绘静默变空白**。实测线上 /assets/portraits/Qwen/idle.webp 返回的
   * 就是 200 + text/html 的 index.html。
   *
   * 而 fs.existsSync 在 Windows 上不区分大小写,所以不能直接用它判 ——
   * 必须拿父目录的 readdirSync 结果做**严格字符串比对**。 */
  const caseProblems = [];
  for (const mf of ['manifest.js', 'manual.js']) {
    const abs = path.join(OUT, 'assets', 'portraits', mf);
    if (!fs.existsSync(abs)) continue;
    // manifest.js 是 ESM,这里只要里面的路径字符串,直接用正则扫,不 import
    const text = fs.readFileSync(abs, 'utf8');
    const pairs = [...text.matchAll(/"id":\s*"([^"]+)"|"file":\s*"([^"]+)"/g)];
    let currentDir = null;
    for (const m of pairs) {
      if (m[1] !== undefined) { currentDir = m[1]; continue; }
      if (!currentDir || !m[2]) continue;
      const dirAbs = path.join(OUT, 'assets', 'portraits', currentDir);
      if (!fs.existsSync(dirAbs)) { caseProblems.push(`${mf}: 目录 ${currentDir} 不存在`); continue; }
      // 严格比对目录名(排除大小写不同但 existsSync 为真的情况)
      const realDirs = fs.readdirSync(path.join(OUT, 'assets', 'portraits'));
      if (!realDirs.includes(currentDir)) {
        caseProblems.push(`${mf}: 目录名大小写不符,清单写 "${currentDir}",实际是 `
          + `"${realDirs.find((d) => d.toLowerCase() === currentDir.toLowerCase()) || '?'}"`);
      }
      const realFiles = fs.readdirSync(dirAbs);
      if (!realFiles.includes(m[2])) {
        const near = realFiles.find((f) => f.toLowerCase() === m[2].toLowerCase());
        caseProblems.push(`${mf}: ${currentDir}/${m[2]} ${near ? `大小写不符(实际 ${near})` : '不存在'}`);
      }
    }
  }
  if (caseProblems.length) {
    for (const p of caseProblems) warn(`立绘路径大小写问题 —— ${p}`);
  } else {
    log('  ok  立绘清单里的路径大小写与实际文件完全一致');
  }
} else {
  warn('assets/portraits 不存在 —— 立绘会全部退化成通用占位。先跑 node tools/fetchportraits.mjs');
}

/* 3c. assets/decor —— 房间装饰(后墙挂画)
 * scene.js 用 ../../assets/decor/painting.jpg 加载,路径规则同立绘。
 * 只复制 decor/,不复制 assets/Background/ 里的原图(3MB PNG,游戏不用它)。 */
log('\n[3c] assets/decor(房间装饰)');
const DECOR_SRC = path.join(ROOT, 'assets', 'decor');
if (fs.existsSync(DECOR_SRC)) {
  const n = copyDir(DECOR_SRC, path.join(OUT, 'assets', 'decor'));
  log(`  + assets/decor 共 ${n} 个文件`);
  if (!fs.existsSync(path.join(OUT, 'assets', 'decor', 'painting.jpg'))) {
    warn('assets/decor/painting.jpg 缺失 —— 后墙挂画会是空白画框');
  }
} else {
  warn('assets/decor 不存在 —— 后墙挂画会是空白画框');
}

/* ------------------------------------------------------------ 校验 */

log('\n[4] 校验');

// 4a. 不该出现 Electron/Node 专属的东西
// 注意:要忽略注释行 —— web/pokerApi.js 的注释里会提到「Electron 的 IPC」做说明,
// 那是文档不是代码,不该报警。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const forbidden = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p); continue; }
    if (!/\.(js|mjs|html)$/.test(e.name)) continue;
    const rel = path.relative(OUT, p);
    let text = fs.readFileSync(p, 'utf8');
    if (e.name.endsWith('.html')) {
      // HTML 里去掉注释块,再取 <script> 内的代码
      text = text.replace(/<!--[\s\S]*?-->/g, '');
    }
    const code = stripComments(text);
    if (/require\(\s*['"]electron['"]\s*\)/.test(code)) forbidden.push(`${rel}: 引用了 electron`);
    if (/from\s+['"]node:/.test(code)) forbidden.push(`${rel}: 引用了 node: 内置模块`);
    if (/\bipcRenderer\b|\bipcMain\b|\bcontextBridge\b/.test(code)) forbidden.push(`${rel}: 用到 Electron IPC`);
  }
}(OUT));
if (forbidden.length) for (const f of forbidden) warn(f);
else log('  ok  产物里没有 electron / node: / ipc 引用');

// 4b. 所有相对 import 必须能在产物里解析到实际文件
// 注意:必须先剥掉注释 —— 共享模块的 JSDoc 里会举例提到别的路径
// (例如 "主进程通过 llmStream.cjs 桥接"),那是文档,不是真 import。
const EXT_TRY = ['', '.js', '.mjs', '.cjs', '/index.js'];
const missing = [];
(function checkImports(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { checkImports(p); continue; }
    if (!/\.(js|mjs)$/.test(e.name)) continue;
    const text = stripComments(fs.readFileSync(p, 'utf8'));
    const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1] || m[2];
      if (!spec || !spec.startsWith('.')) continue;      // 只查相对路径
      const target = path.resolve(path.dirname(p), spec);
      const ok = EXT_TRY.some((ext) => fs.existsSync(target + ext) && fs.statSync(target + ext).isFile());
      if (!ok) missing.push(`${path.relative(OUT, p)} → ${spec}`);
    }
  }
}(OUT));
if (missing.length) for (const m of missing) warn(`import 解析不到: ${m}`);
else log('  ok  所有相对 import 都能解析到文件');

// 4b2. HTML 里引用的本地资源必须存在
const htmlMissing = [];
for (const htmlFile of ['index.html']) {
  const hp = path.join(OUT, htmlFile);
  if (!fs.existsSync(hp)) continue;
  const html = fs.readFileSync(hp, 'utf8');
  const re = /(?:href|src)\s*=\s*["']([^"'#?]+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const spec = m[1];
    if (/^(https?:|data:|blob:|\/\/)/.test(spec)) continue;
    const target = path.resolve(path.dirname(hp), spec);
    if (!fs.existsSync(target)) htmlMissing.push(`${htmlFile} → ${spec}`);
  }
  // <script type="module"> 内联代码里的相对 import 也要查
  const inline = html.match(/<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/g) || [];
  for (const block of inline) {
    const code = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    const ire = /import\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s*['"]([^'"]+)['"]/g;
    let im;
    while ((im = ire.exec(code))) {
      const spec = im[1] || im[2];
      if (!spec || !spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(hp), spec);
      const ok = EXT_TRY.some((ext) => fs.existsSync(target + ext) && fs.statSync(target + ext).isFile());
      if (!ok) htmlMissing.push(`${htmlFile} 内联脚本 → ${spec}`);
    }
  }
}
if (htmlMissing.length) for (const m of htmlMissing) warn(`HTML 资源缺失: ${m}`);
else log('  ok  HTML 引用的资源与内联 import 都存在');

// 4c. three.js 必须在位(否则 3D 直接白屏)
if (fs.existsSync(path.join(OUT, 'vendor', 'three.module.js'))) {
  log('  ok  vendor/three.module.js 已就位');
} else {
  warn('vendor/three.module.js 缺失,3D 场景会白屏');
}

// 4d. 入口必须带 viewport meta(手机适配的前提)
const idx = path.join(OUT, 'index.html');
if (fs.existsSync(idx) && /name=["']viewport["']/.test(fs.readFileSync(idx, 'utf8'))) {
  log('  ok  index.html 带 viewport meta');
} else if (!fs.existsSync(idx)) {
  warn('index.html 不存在 —— 入口丢了');
} else {
  warn('index.html 缺少 viewport meta,手机上按钮会被缩小到点不准');
}

/* ------------------------------------------------------------ 体积统计 */

function dirSize(dir) {
  let total = 0, files = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { total += fs.statSync(p).size; files += 1; }
    }
  }(dir));
  return { total, files };
}

const { total, files } = dirSize(OUT);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
log('\n[5] 产物统计');
log(`  文件 ${files} 个,合计 ${kb(total)}`);
for (const part of ['vendor', 'src', 'web', 'assets']) {
  const d = path.join(OUT, part);
  if (fs.existsSync(d)) {
    const s = dirSize(d);
    log(`  ${part.padEnd(8)} ${String(s.files).padStart(3)} 个  ${kb(s.total).padStart(10)}`);
  }
}
const three = path.join(OUT, 'vendor', 'three.module.js');
if (fs.existsSync(three)) {
  log(`  (其中 three.js 占 ${kb(fs.statSync(three).size)} —— 主要为它就没什么可压缩的)`);
}

log('');
if (warnings) {
  log(`完成,但有 ${warnings} 条警告(见上)。`);
  process.exitCode = 1;
} else {
  log('构建完成,无警告。');
  log('');
  log('本地预览:');
  log('  npx serve web/dist        (或任意静态服务器)');
  log('  注意:直接双击 index.html 用 file:// 打开会因为 ES 模块的 CORS 限制而失败,');
  log('        必须用 http 服务器。');
}
