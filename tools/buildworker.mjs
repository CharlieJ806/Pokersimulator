/**
 * 构建 Cloudflare Worker 到一个自包含目录。
 *
 * 为什么需要构建:
 *   Worker 要复用仓库里的共享模块(src/shared/),而 Cloudflare 部署时
 *   只会上传一个目录。所以这里把 worker/src + src/shared 复制到一起,
 *   让 Worker 目录自包含,不需要相对路径跨出目录。
 *
 * 产物结构:
 *   worker/dist/
 *     index.js          ← Worker 入口(相对 import 已改写成 ./shared/...)
 *     shared/providers.mjs
 *     shared/providers.cjs
 *     shared/llmStream.mjs
 *     shared/llmStream.cjs
 *     wrangler.toml
 *
 * 用法: node tools/buildworker.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'worker', 'src');
const OUT = path.join(ROOT, 'worker', 'dist');
const SHARED = path.join(ROOT, 'src', 'shared');

const log = (m) => process.stdout.write(m + '\n');
let warnings = 0;
const warn = (m) => { warnings += 1; log('  ! ' + m); };

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

log(`构建 Cloudflare Worker → ${path.relative(ROOT, OUT)}`);

rmrf(OUT);
fs.mkdirSync(path.join(OUT, 'shared'), { recursive: true });

/* 1. 共享模块(Worker 与前端、桌面端共用的那一份) */
const sharedFiles = ['providers.mjs', 'providers.cjs', 'llmStream.mjs', 'llmStream.cjs'];
for (const f of sharedFiles) {
  const src = path.join(SHARED, f);
  if (!fs.existsSync(src)) { warn(`缺少 src/shared/${f}`); continue; }
  fs.copyFileSync(src, path.join(OUT, 'shared', f));
}
log(`\n[1] shared/ 已复制 ${sharedFiles.length} 个文件`);

/* 2. Worker 入口,并把共享模块的 import 指向复制过来的 ./shared/ */
const entrySrc = path.join(SRC, 'index.js');
if (!fs.existsSync(entrySrc)) {
  log('  ! 找不到 worker/src/index.js');
  process.exit(1);
}
let code = fs.readFileSync(entrySrc, 'utf8');
// 源码里写的是 './shared/providers.mjs'(worker/src 旁边有个软链式的约定),
// 统一改写成产物里的 './shared/...';两种写法都容错。
const before = code;
code = code.replace(/(['"])(?:\.\.\/)*src\/shared\/([^'"]+)\1/g, (_, q, file) => `${q}./shared/${file}${q}`);
code = code.replace(/(['"])\.\/shared\/([^'"]+)\1/g, (_, q, file) => `${q}./shared/${file}${q}`);
if (code === before) {
  // 已经是 ./shared/ 形式就不用改,这不是问题
  log('[2] 入口的 shared import 已就位(无需改写)');
} else {
  const n = (before.match(/shared\//g) || []).length;
  log(`[2] 入口已改写 ${n} 处 shared import`);
}
fs.writeFileSync(path.join(OUT, 'index.js'), code, 'utf8');
log('  + index.js');

/* 3. wrangler 配置(输出目录里也放一份,方便直接在该目录 deploy) */
const wtSrc = path.join(ROOT, 'worker', 'wrangler.toml');
if (fs.existsSync(wtSrc)) {
  let wt = fs.readFileSync(wtSrc, 'utf8');
  // wrangler.toml 是手写的,里面 [assets] directory 是**相对配置文件**的路径。
  // 源文件在 worker/,产物在 worker/dist/,两者深度不同,
  // 所以要按「同一个绝对目录」重新算相对路径 —— 直接改深度容易算错(曾把 ../ 叠了两遍)。
  wt = wt.replace(/(\[assets\][\s\S]*?directory\s*=\s*)"([^"]+)"/, (m, pre, dir) => {
    if (path.isAbsolute(dir)) return m;
    const abs = path.resolve(path.join(ROOT, 'worker'), dir);
    const rel = path.relative(OUT, abs).split(path.sep).join('/');
    return `${pre}"${rel}"`;
  });
  fs.writeFileSync(path.join(OUT, 'wrangler.toml'), wt, 'utf8');
  log('[3] wrangler.toml 已复制(assets 路径已按产物深度修正)');
} else {
  warn('worker/wrangler.toml 不存在,部署时需要自己提供');
}

/* 3a2. 校验 assets 目录真的存在 —— 这是部署时最常见的坑 */
{
  const wt = fs.readFileSync(path.join(OUT, 'wrangler.toml'), 'utf8');
  const m = wt.match(/\[assets\][\s\S]*?directory\s*=\s*"([^"]+)"/);
  if (m) {
    const assetsDir = path.resolve(OUT, m[1]);
    if (fs.existsSync(assetsDir) && fs.existsSync(path.join(assetsDir, 'index.html'))) {
      log(`  ok  assets 目录有效 → ${path.relative(ROOT, assetsDir)} (含 index.html)`);
    } else if (fs.existsSync(assetsDir)) {
      warn(`assets 目录存在但没有 index.html: ${path.relative(ROOT, assetsDir)} —— 先跑 node tools/buildweb.mjs`);
    } else {
      warn(`assets 目录不存在: ${m[1]} → ${assetsDir} —— 先跑 node tools/buildweb.mjs`);
    }
  }
}

/* 3b. 让 Node 知道产物是 ESM ——
   根 package.json 是 CJS(给 Electron 用的),不能加 "type":"module",
   所以在产物目录里放一个最小的 package.json 覆盖它。
   不加的话,用 Node 直接跑产物会报 MODULE_TYPELESS_PACKAGE_JSON 警告。 */
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  name: 'poker-dealer-llm-proxy',
  private: true,
  type: 'module',
  description: 'Cloudflare Worker:LLM CORS 转发层(由 tools/buildworker.mjs 生成,请勿手改)',
}, null, 2) + '\n', 'utf8');
log('[3b] package.json(type:module)已生成');

/* 4. 校验 */
log('\n[4] 校验');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const missing = [];
(function check(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { check(p); continue; }
    if (!/\.(js|mjs)$/.test(e.name)) continue;
    const text = stripComments(fs.readFileSync(p, 'utf8'));
    const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1] || m[2];
      if (!spec || !spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(p), spec);
      const ok = ['', '.js', '.mjs', '.cjs'].some((ext) => fs.existsSync(target + ext));
      if (!ok) missing.push(`${path.relative(OUT, p)} → ${spec}`);
    }
  }
}(OUT));
if (missing.length) for (const m of missing) warn(`import 解析不到: ${m}`);
else log('  ok  所有相对 import 都能解析到文件');

// Worker 里不该出现 Node/Electron 的东西
const bad = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p); continue; }
    if (!e.name.endsWith('.js')) continue;
    const text = stripComments(fs.readFileSync(p, 'utf8'));
    if (/require\s*\(/.test(text)) bad.push(`${path.relative(OUT, p)}: 用了 require`);
    if (/from\s+['"]node:/.test(text)) bad.push(`${path.relative(OUT, p)}: 引用了 node:`);
    if (/process\.env/.test(text)) bad.push(`${path.relative(OUT, p)}: 用了 process.env(Worker 里应改用 env 参数)`);
  }
}(OUT));
if (bad.length) for (const b of bad) warn(b);
else log('  ok  没有 require / node: / process.env');

// 入口必须同时处理静态资源与 /api/llm
const entry = fs.readFileSync(path.join(OUT, 'index.js'), 'utf8');
if (/env\.ASSETS|ASSETS\?\.fetch/.test(entry)) {
  log('  ok  入口会把非 API 请求交给 assets(静态站点 + 转发合体)');
} else {
  warn('入口没有处理 ASSETS 绑定 —— 静态页面会 404');
}
if (/\/api\/llm/.test(entry)) {
  log('  ok  转发的路由是 /api/llm(与前端默认值一致)');
} else {
  warn('入口里没有 /api/llm 路由 —— 前端默认会请求这个路径,对不上就调不通');
}

// 流式相关:必须显式设置 text/event-stream,否则前端「实时思考」会失效
if (/text\/event-stream/.test(entry)) log('  ok  显式设置了 text/event-stream(流式不会被缓冲)');
else warn('入口没有设置 text/event-stream —— 流式会被攒成一大块返回');

// 白名单:确认厂商域名是从共享表推导的
if (/DEFAULT_HOSTS/.test(entry) && /PROVIDERS/.test(entry)) {
  log('  ok  转发白名单由共享厂商表推导(改厂商表会自动同步)');
} else {
  warn('没有看到基于 PROVIDERS 的白名单 —— 转发层可能变成开放代理');
}

log('');
if (warnings) {
  log(`完成,但有 ${warnings} 条警告。`);
  process.exitCode = 1;
} else {
  log('构建完成,无警告。');
  log('');
  log('本地起 Worker:');
  log('  cd worker/dist && npx wrangler dev');
  log('部署:');
  log('  cd worker/dist && npx wrangler deploy');
}
