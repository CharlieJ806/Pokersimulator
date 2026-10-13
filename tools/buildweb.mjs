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
for (const part of ['vendor', 'src', 'web']) {
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
