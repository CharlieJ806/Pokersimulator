/**
 * 处理「手工加进来的立绘」(不是 crosspet 那批)。
 *
 * 为什么需要单独一步:
 *   手工素材常见两个问题 ——
 *   1. **白底 JPG,没有透明通道**。直接放上牌桌就是一块白方框。
 *      而且不能简单地「把白色像素抠掉」:Qwen 的裙子本身就是白的,
 *      一刀切会在裙子上开洞。必须**从画面边缘做 flood fill**,
 *      只把「与边界连通的白」当背景。
 *   2. 尺寸/长宽比各不相同,而且往往只有一张图(没有 idle/thinking/… 之分)。
 *      这里统一成一张 `idle`,缺的状态由 portraits2d 回退复用。
 *
 * 为什么跑在 Electron 的渲染进程里:
 *   Node 既没有 JPEG 解码也写不了 PNG;Electron 主进程的 nativeImage 虽然能解码,
 *   但**只能导出 PNG** —— 实测同一张图 PNG 516KB / 906KB,而 WebP 只要几十 KB
 *   (crosspet 那批全是 WebP,约 100KB/张)。
 *   所以把像素活儿放到渲染进程的 canvas 里做,顺便就能 `toDataURL('image/webp')`,
 *   格式和体积都跟现有素材对齐。全程零依赖。
 *
 * 输入约定(放在 assets/portraits/ 下,目录名随意、大小写随意):
 *   assets/portraits/Qwen/xxxx.jpg
 *   assets/portraits/Grok/xxxx.jpg
 * 输出:
 *   assets/portraits/qwen/idle.webp     ← 小写目录名 + WebP(带透明通道)
 *   assets/portraits/grok/idle.webp
 *   assets/portraits/manual.js          ← 给应用的 ESM 清单(与 manifest.js 分开维护)
 *
 * 用法: node_modules/.bin/electron tools/prepmanualportraits.mjs --no-sandbox
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'assets', 'portraits');
const log = (m) => process.stdout.write(m + '\n');

/** 从 crosspet 取来的那 6 套 —— 这些不是手工素材,跳过 */
const CROSSPET = new Set(['claude', 'deepseek', 'deepseek-hoodie', 'gemini', 'glm', 'gpt']);

/** 手工素材的角色信息(展示名与 accent;没配的用目录名 + 中性色) */
const META = {
  qwen: { name: 'Qwen', accent: '#6f7bd6' },
  grok: { name: 'Grok', accent: '#e2574c' },
};

/** 已处理产物的文件名 —— 选源图时必须排除,否则会把 idle.webp 再抠一遍 */
const OUTPUT_NAMES = new Set(['idle', 'thinking', 'happy', 'oops', 'surprised']);

app.commandLine.appendSwitch('enable-unsafe-swiftshader');

app.whenReady().then(async () => {
  const entries = fs.readdirSync(DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !CROSSPET.has(e.name.toLowerCase()));
  if (!entries.length) { log('没找到手工素材目录(除 crosspet 那 6 套之外)。'); app.exit(0); return; }

  const win = new BrowserWindow({
    width: 400, height: 300, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const manifest = {
    source: '手工添加',
    license: '见 assets/portraits/SOURCES.md',
    characters: {},
  };
  let done = 0;
  const problems = [];

  for (const e of entries) {
    const id = e.name.toLowerCase();
    let srcDir = path.join(DIR, e.name);

    /* ⚠️ 目录名统一成小写。
       为什么必须做:Windows 不区分大小写,所以 `Qwen/` 和 `qwen/` 是同一个目录,
       本地跑起来一切正常;但 **Cloudflare 的静态资源是区分大小写的**,
       清单里写 `qwen/idle.webp` 而目录实际叫 `Qwen`,线上就会 404。
       大小写改名在 Windows 上要两步走(直接改成同名大小写会被当成"没变")。 */
    if (e.name !== id) {
      const tmp = path.join(DIR, `_case_tmp_${id}_${Date.now()}`);
      fs.renameSync(srcDir, tmp);
      fs.renameSync(tmp, path.join(DIR, id));
      srcDir = path.join(DIR, id);
      log(`  (目录名 ${e.name} → ${id}:线上区分大小写,必须统一)`);
    }

    const imgs = fs.readdirSync(srcDir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      // 排除处理产物本身,免得把 idle.webp 当成源图再抠一遍
      .filter((f) => !OUTPUT_NAMES.has(path.basename(f, path.extname(f)).toLowerCase()))
      .sort();
    if (!imgs.length) { problems.push(`${id}: 目录里没有可用源图(只有已处理的产物?)`); continue; }

    const pick = imgs[0];                     // 手工素材一般只有一张
    // 以 data URL 递给渲染进程。
    // 不要用 file:///… :这个窗口的页面不是 file:// 来源(空页),跨来源加载本地图片
    // 会被直接拒掉(实测 "图片加载失败")。转成 data URL 就没有来源问题了。
    const ext = path.extname(pick).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const srcDataUrl = `data:${mime};base64,${fs.readFileSync(path.join(srcDir, pick)).toString('base64')}`;

    // 像素活儿全在渲染进程做:解码 JPG → 抠底 → 裁边 → 导出 WebP
    const res = await js(`(async () => {
      const srcUrl = ${JSON.stringify(srcDataUrl)};
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('图片加载失败')); img.src = srcUrl; });
      const W = img.naturalWidth, H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, W, H);
      g.drawImage(img, 0, 0);
      const idat = g.getImageData(0, 0, W, H);
      const px = idat.data;

      // —— 从四条边 flood fill,只把与边界连通的白当背景 ——
      //
      // ⚠️ 阈值必须**严格**。第一版用「三通道 ≥ 208 就算白」,结果 Grok 的
      //    奶白色头发和脸部皮肤整片被抠掉(只剩眼睛和嘴),Qwen 的白裙子也受损。
      //    实测这批图的背景是 (254,254,254) 而不是纯白,白度直方图上
      //    背景是 250~259 那根尖峰,而人物的浅色区域大片落在 240 以下。
      //    所以取 246:既能吃掉背景与 JPEG 噪声,又不会顺着浅色头发漏进去。
      const FILL_MIN = 246;
      // 边缘软化:紧邻背景的像素按白度给半透明,免得切口全是硬齿。
      // 只作用于**紧邻背景的那一圈**,所以不会影响人物内部的白色(裙子、高光)。
      const EDGE_HI = 250, EDGE_LO = 234;
      const whiteish = (i) => Math.min(px[i], px[i+1], px[i+2]) >= FILL_MIN;
      const marked = new Uint8Array(W * H);
      const queue = [];
      const push = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const k = y * W + x;
        if (marked[k] || !whiteish(k * 4)) return;
        marked[k] = 1; queue.push(k);
      };
      for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
      for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
      for (let head = 0; head < queue.length; head++) {
        const k = queue[head], x = k % W, y = (k - x) / W;
        push(x-1, y); push(x+1, y); push(x, y-1); push(x, y+1);
      }
      let cleared = 0;
      for (let k = 0; k < W * H; k++) if (marked[k]) cleared++;
      for (let k = 0; k < W * H; k++) {
        const i = k * 4;
        px[i+3] = marked[k] ? 0 : 255;
      }
      // 边缘软化:非背景但紧邻背景的像素,按白度给部分 alpha。
      // 这样抗锯齿的过渡带不会变成一圈白边,也不会被整块吃掉。
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (marked[k]) continue;
        let nearBg = false;
        for (let dy = -1; dy <= 1 && !nearBg; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (marked[ny * W + nx]) { nearBg = true; break; }
        }
        if (!nearBg) continue;
        const i4 = k * 4;
        const w = Math.min(px[i4], px[i4+1], px[i4+2]);
        if (w <= EDGE_LO) continue;
        const a = Math.round((EDGE_HI - w) / (EDGE_HI - EDGE_LO) * 255);
        px[i4+3] = Math.max(0, Math.min(255, a));
      }

      // —— 裁掉四周全透明的边 ——
      const A = (x, y) => px[(y * W + x) * 4 + 3];
      let top = 0, bottom = H - 1, left = 0, right = W - 1;
      const rowEmpty = (y) => { for (let x = 0; x < W; x++) if (A(x, y) > 8) return false; return true; };
      const colEmpty = (x) => { for (let y = 0; y < H; y++) if (A(x, y) > 8) return false; return true; };
      while (top < bottom && rowEmpty(top)) top++;
      while (bottom > top && rowEmpty(bottom)) bottom--;
      while (left < right && colEmpty(left)) left++;
      while (right > left && colEmpty(right)) right++;
      const ow = right - left + 1, oh = bottom - top + 1;

      const out = document.createElement('canvas');
      out.width = ow; out.height = oh;
      const og = out.getContext('2d');
      og.putImageData(idat, -left, -top);

      return {
        srcW: W, srcH: H, w: ow, h: oh,
        clearedPct: +(cleared / (W * H) * 100).toFixed(1),
        dataUrl: out.toDataURL('image/webp', 0.92),
      };
    })()`);

    const b64 = String(res.dataUrl || '').split(',')[1] || '';
    if (!b64) { problems.push(`${e.name}/${pick}: 导出 WebP 失败`); continue; }
    const buf = Buffer.from(b64, 'base64');

    const outDir = path.join(DIR, id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'idle.webp'), buf);

    const meta = META[id] || { name: e.name, accent: '#8b98ab' };
    manifest.characters[id] = {
      id,
      name: meta.name,
      accent: meta.accent,
      greeting: '',
      // 手工素材只有一张:所有状态都用它(portraits2d 里缺状态会自动回退到 idle)
      states: { idle: { file: 'idle.webp', from: pick, w: res.w, h: res.h } },
      source: 'manual',
    };
    done++;
    log(`  ${id.padEnd(8)} ${pick.slice(0, 20)}…  ${res.srcW}x${res.srcH}`
      + ` → 裁到 ${res.w}x${res.h}  清背景 ${res.clearedPct}%  ${(buf.length / 1024).toFixed(0)} KB`);
  }

  fs.writeFileSync(path.join(DIR, 'manual.js'),
    '/* 由 tools/prepmanualportraits.mjs 生成,请勿手改。\n'
    + ' * 手工加入的立绘(白底图 → 抠底 → WebP)。\n'
    + ' * 与 crosspet 那批(manifest.js)分开维护,避免两个脚本互相覆盖。\n'
    + ' * 许可与来源见 MANUAL-SOURCES.md。\n'
    + ' */\n'
    + `export default ${JSON.stringify(manifest, null, 2)};\n`, 'utf8');

  // 单独一份来源说明。**不要**写进 SOURCES.md —— 那个文件由 fetchportraits.mjs
  // 整体重写,两边都写会互相覆盖。而且这两批素材的授权来源确实不同,分开写更清楚。
  const lines = [
    '# 手工加入的立绘 —— 来源与授权',
    '',
    '本文件对应的素材由**项目使用者自行提供**,与 `SOURCES.md` 里那批(crosspet,',
    'CC BY-NC-SA 4.0)**不是同一个来源**,授权状态需要使用者自行确认。',
    '',
    '> ⚠️ 这里不做任何授权声明。如果要公开分发或商用,请先确认每个角色的原作者与许可。',
    '',
    '## 取用清单',
    '',
    '| 角色 | 本地文件 | 原始文件 | 尺寸(裁切后) |',
    '| --- | --- | --- | --- |',
  ];
  for (const [id, c] of Object.entries(manifest.characters)) {
    const st = c.states.idle;
    lines.push(`| ${c.name} | \`assets/portraits/${id}/idle.webp\` | \`${c.id === id ? '' : ''}${st.from}\` | ${st.w}×${st.h} |`);
  }
  lines.push(
    '',
    '## 处理方式',
    '',
    '原图是**白底 JPG(无透明通道)**。若直接使用,牌桌上会出现白色方块;',
    '而简单地「把白色像素抠掉」也不行 —— Qwen 的裙子本身是白的,一刀切会在衣服上开洞。',
    '所以用**从画面四边 flood fill** 的方式:只有与边界连通的白才被当作背景。',
    '照片随即裁掉四周全透明的边、导出 WebP(与 crosspet 那批格式一致)。',
    '',
    '处理脚本:`tools/prepmanualportraits.mjs`(跑在 Electron 里,零依赖)。',
    '每个角色只有一张图,所以**所有状态都复用这一张**;',
    '缺状态时的回退逻辑见 `src/ui3d/portraits2d.js` 的 `stateMeta()`。',
    '',
  );
  fs.writeFileSync(path.join(DIR, 'MANUAL-SOURCES.md'), lines.join('\n'), 'utf8');

  log(`\n处理 ${done} 套 → assets/portraits/<名字>/idle.webp`);
  log('  + manual.js(与 crosspet 的 manifest.js 分开)');
  if (problems.length) { log('\n⚠ 问题:'); for (const p of problems) log('  - ' + p); }
  app.exit(problems.length ? 1 : 0);
}).catch((e) => { log('!! ' + (e?.stack || e)); app.exit(1); });
