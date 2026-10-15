/**
 * 读 WebP 头部拿尺寸(不依赖任何图片库)。
 * 支持 VP8(lossy) / VP8L(lossless) / VP8X(extended) 三种块。
 */
import fs from 'node:fs';

export function webpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { w, h, fmt: 'VP8X' };
  }
  if (fourcc === 'VP8 ') {
    // 帧头里 14 字节处是宽高(低 14 位有效)
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return { w, h, fmt: 'VP8' };
  }
  if (fourcc === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff), fmt: 'VP8L' };
  }
  return null;
}

if (process.argv[2]) {
  const buf = fs.readFileSync(process.argv[2]);
  console.log(JSON.stringify(webpSize(buf)));
}
