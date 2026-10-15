/**
 * 把 crosspet 的角色立绘取进 assets/portraits/。
 *
 * ⚠️ 许可证:这批立绘是 **CC BY-NC-SA 4.0**(署名 / 非商业 / 相同方式共享),
 *    与仓库根的 MIT **不同**,只覆盖 crosspet 的 characters/ 目录。
 *    所以这里会把原许可文件一起复制过来,并生成一份来源清单(index.json),
 *    满足「署名 + 可追溯」的要求。商用前必须另行取得授权。
 *
 * 素材来源: https://github.com/lokicorvus/crosspet  (characters/)
 *
 * 为什么用本地 sparse clone 而不是直接下载:
 *   raw.githubusercontent.com 在本地网络不通(只有 api.github.com 通),
 *   而未认证的 API 限额只有 60 次/小时,下 30 张图会被限流。
 *   git 走 github.com 是通的,所以先稀疏克隆,再从本地复制。
 *
 * 用法:
 *   git clone --depth 1 --filter=blob:none --sparse https://github.com/lokicorvus/crosspet.git _crosspet
 *   cd _crosspet && git sparse-checkout set characters/claude characters/deepseek \
 *       characters/deepseek-hoodie characters/gemini characters/glm characters/gpt
 *   node tools/fetchportraits.mjs [--src <clone 路径>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webpSize } from './_webpsize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const log = (m) => process.stdout.write(m + '\n');

const si = process.argv.indexOf('--src');
const SRC = si >= 0 ? path.resolve(process.argv[si + 1])
  : path.resolve(ROOT, '..', '_crosspet', 'characters');
const OUT = path.join(ROOT, 'assets', 'portraits');

/**
 * 牌桌上真正用得到的 5 个状态,以及各自的取图优先级。
 *
 * crosspet 的命名**不统一**:claude 没有 happy.webp(只有 proud),
 * 而大部分角色没有 oops.webp(用 dizzy/sorry 顶)。所以每个状态给一串候选,
 * 按顺序取第一个存在的;都不存在就报错(而不是静默少一张图 ——
 * 那样上线后才会发现某个人物在某个状态下是空白)。
 */
const STATES = {
  idle: ['idle'],
  thinking: ['thinking'],
  happy: ['happy', 'proud', 'pat'],
  oops: ['oops', 'sorry', 'sulk', 'dizzy', 'tired'],
  surprised: ['surprised', 'puffed', 'redhot'],
};

/** 只收有对应模型的角色;egg-* 那几套只有 4 张图,不是全身立绘 */
const CHARS = ['claude', 'deepseek', 'deepseek-hoodie', 'gemini', 'glm', 'gpt'];

if (!fs.existsSync(SRC)) {
  log(`!! 找不到源目录: ${SRC}`);
  log('   先按文件头注释里的命令做一次 sparse clone,或用 --src 指定路径。');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const manifest = { source: 'https://github.com/lokicorvus/crosspet', license: 'CC BY-NC-SA 4.0', characters: {} };
let copied = 0, bytes = 0;
const problems = [];

for (const c of CHARS) {
  const dir = path.join(SRC, c);
  if (!fs.existsSync(dir)) { problems.push(`${c}: 源目录不存在`); continue; }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -5));

  const metaPath = path.join(dir, 'character.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { problems.push(`${c}: character.json 解析失败 ${e.message}`); }
  } else problems.push(`${c}: 缺 character.json`);

  fs.mkdirSync(path.join(OUT, c), { recursive: true });
  const states = {};
  for (const [state, alts] of Object.entries(STATES)) {
    const pick = alts.find((a) => files.includes(a));
    if (!pick) { problems.push(`${c}: 状态 ${state} 找不到候选图(${alts.join('/')})`); continue; }
    const from = path.join(dir, `${pick}.webp`);
    const to = path.join(OUT, c, `${state}.webp`);
    fs.copyFileSync(from, to);
    const sz = webpSize(fs.readFileSync(to));
    if (!sz) problems.push(`${c}/${state}: 读不出尺寸`);
    states[state] = { file: `${state}.webp`, from: `${pick}.webp`, w: sz?.w, h: sz?.h };
    copied += 1;
    bytes += fs.statSync(to).size;
  }

  manifest.characters[c] = {
    id: c,
    name: meta.name || c,
    accent: meta.accent || '#e8a33d',
    greeting: meta.greeting || '',
    states,
  };
  log(`  ${c.padEnd(18)} ${Object.keys(states).length}/5 态  accent=${manifest.characters[c].accent}`
    + `  name=${manifest.characters[c].name}`);
}

/* 原许可文件必须一起带上(署名/相同方式共享的要求) */
const licSrc = path.join(SRC, 'LICENSE.md');
if (fs.existsSync(licSrc)) {
  fs.copyFileSync(licSrc, path.join(OUT, 'LICENSE.md'));
  log('\n  + LICENSE.md(原样复制)');
} else {
  problems.push('缺 characters/LICENSE.md');
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

/* 同时产出一份 ESM 清单。
   为什么不直接 fetch index.json:
     · Electron 走 file://,fetch 本地 json 要放开 CSP 且路径写法与网页版不同;
     · 网页版要等一次异步请求,首帧拿不到尺寸 —— 而 table3d 是**同步**
       用 Box3 量头顶高度来摆思考气泡的(见 table3d.js 的 seatAnchors)。
   做成 ESM 之后两边都变成普通 import,同步可用、不需要任何加载状态。 */
fs.writeFileSync(path.join(OUT, 'manifest.js'),
  '/* 由 tools/fetchportraits.mjs 生成,请勿手改。\n'
  + ' * 角色立绘来源:https://github.com/lokicorvus/crosspet (characters/)\n'
  + ' * 许可:CC BY-NC-SA 4.0 —— 署名 / 非商业性使用 / 相同方式共享。\n'
  + ' * 完整条款见同目录 LICENSE.md 与 SOURCES.md。\n'
  + ' */\n'
  + `export default ${JSON.stringify(manifest, null, 2)};\n`, 'utf8');
fs.writeFileSync(path.join(OUT, 'SOURCES.md'), [
  '# 角色立绘来源与授权',
  '',
  '本目录(`assets/portraits/`)下的角色立绘取自开源项目 **CrossPet**:',
  '',
  '- 仓库: <https://github.com/lokicorvus/crosspet>(目录 `characters/`)',
  '- 许可: **CC BY-NC-SA 4.0**(署名 — 非商业性使用 — 相同方式共享 4.0 国际)',
  '- 完整条款见同目录的 [LICENSE.md](LICENSE.md)',
  '',
  '## 署名',
  '',
  '立绘与角色设定由 CrossPet 及其社区作者创作(DeepSeek「溟月」、GPT「御姐白龙」、',
  'Gemini 娘、Claude 娘等设定分别来自上善无形、B 站 ZipZipPipe 及社区)。',
  '逐角色的设定来源见 `LICENSE.md`。',
  '',
  '「Claude」「GPT」「ChatGPT」「DeepSeek」「Gemini」是各自公司的商标;',
  'CrossPet 与本项目均为非官方同人项目,与这些公司无关。',
  '',
  '## 本项目如何使用',
  '',
  '按 CC BY-NC-SA 4.0 的**相同方式共享**要求,本项目包含这些立绘的部分同样以',
  'CC BY-NC-SA 4.0 发布,**不得用于商业目的**。',
  '',
  '## 取图清单',
  '',
  '每个角色取 5 个状态;`index.json` 里记录了每个状态对应的 crosspet 原文件名,',
  '便于核对与追溯。取图流程见 `tools/fetchportraits.mjs`。',
  '',
].join('\n'), 'utf8');

log(`\n复制 ${copied} 张,共 ${(bytes / 1024 / 1024).toFixed(1)} MB → assets/portraits/`);
log('  + index.json(给人的清单:角色名 / accent / 状态 / 原文件名)');
log('  + manifest.js(给应用的 ESM 清单,同步 import 即可拿到尺寸)');
log('  + SOURCES.md(署名与授权说明)');
if (problems.length) {
  log(`\n⚠ ${problems.length} 个问题:`);
  for (const p of problems) log('  - ' + p);
  process.exitCode = 1;
} else {
  log('\n完成,无问题。');
}
