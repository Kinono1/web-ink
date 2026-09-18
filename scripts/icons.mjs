// Deterministic geometric extension icons, using only Node built-ins.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
const root = new URL('../public/icon/', import.meta.url);
await mkdir(root, { recursive: true });
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([size, t, data, crc]);
}
function distance(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));
  return Math.hypot(x-ax-t*(bx-ax), y-ay-t*(by-ay));
}
for (const n of [16, 32, 48, 128]) {
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n, v = (y + 0.5) / n;
    const rounded = Math.hypot(Math.max(0, Math.abs(u-.5)-.31), Math.max(0, Math.abs(v-.5)-.31)) <= .17;
    let color = [35, 78, 142, rounded ? 255 : 0];
    if (rounded && v > .71 && v < .82 && u > .18 && u < .82) color = [250, 204, 21, 255];
    const strokes = [[.23,.27,.34,.63],[.34,.63,.50,.37],[.50,.37,.66,.63],[.66,.63,.77,.27]];
    if (rounded && strokes.some(s => distance(u,v,...s)<.046)) color = [255,255,255,255];
    const offset = y * (n * 4 + 1) + 1 + x * 4;
    for (let i = 0; i < 4; i++) raw[offset+i] = color[i];
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(n); header.writeUInt32BE(n,4); header[8]=8; header[9]=6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  await writeFile(new URL(`${n}.png`, root), png);
}
