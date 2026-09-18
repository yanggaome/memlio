// Draws the extension icons: an amber bookmark ribbon on the banner's dark rounded square.
// Run `node scripts/icons.mjs` after changing the shapes; the PNGs are committed.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const INK = [0x02, 0x06, 0x17];
const AMBER = [0xfb, 0xbf, 0x24];

const roundedSquare = (u, v) => {
  const r = 0.22;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
};
const ribbon = (u, v) => u >= 0.32 && u <= 0.68 && v >= 0.2 && v <= 0.8 && v <= 0.68 + 0.667 * Math.abs(u - 0.5);

/** Fraction of the pixel inside the shape, from a 4×4 supersample. */
function coverage(x, y, size, shape) {
  let hits = 0;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) if (shape((x + (i + 0.5) / 4) / size, (y + (j + 0.5) / 4) / size)) hits++;
  return hits / 16;
}

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = coverage(x, y, size, roundedSquare);
      const t = alpha ? coverage(x, y, size, ribbon) / alpha : 0;
      const at = y * stride + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[at + c] = Math.round(INK[c] * (1 - t) + AMBER[c] * t);
      raw[at + 3] = Math.round(alpha * 255);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL('../extension/icons/', import.meta.url), { recursive: true });
for (const size of [16, 48, 128]) writeFileSync(new URL(`../extension/icons/${size}.png`, import.meta.url), png(size));
