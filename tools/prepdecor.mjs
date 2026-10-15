// 把 assets/Background 里的挂画转成游戏用的 JPG(assets/decor/painting.jpg)
// 用法: node_modules/.bin/electron tools/prepdecor.mjs   (换画之后重跑一次即可)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app, nativeImage } = require('electron');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.whenReady().then(() => {
  const dir = path.join(ROOT, 'assets', 'Background');
  const src = fs.readdirSync(dir).find((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const img = nativeImage.createFromPath(path.join(dir, src));
  const { width, height } = img.getSize();
  const out = img.getSize().width > 1920 ? img.resize({ width: 1920, quality: 'best' }) : img;
  const buf = out.toJPEG(86);
  fs.writeFileSync(path.join(ROOT, 'assets', 'decor', 'painting.jpg'), buf);
  process.stdout.write(`${src} ${width}x${height} -> painting.jpg ${(buf.length / 1024).toFixed(0)}KB\n`);
  app.exit(0);
});
