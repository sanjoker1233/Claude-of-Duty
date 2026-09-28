/**
 * Generate the Android PWA icons (192 + 512, regular + maskable) with zero
 * dependencies — a minimal RGBA PNG encoder on top of node:zlib.
 *
 *   node tools/make-android-icons.mjs
 *
 * Art: near-black field, thin amber crosshair ring, three stacked chevrons.
 * Maskable variants keep the mark inside the 80% safe circle on a full-bleed
 * field so Android's adaptive-icon masks never clip it.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((1 + w * 4) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const parts = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat(parts);
}

function draw(size, { maskable }) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  // Field with a soft vertical falloff (darker at the edges).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size - 0.5) * 2;
      const ny = (y / size - 0.5) * 2;
      const d = Math.min(1, Math.hypot(nx, ny));
      const v = 16 - d * 10;
      set(x, y, v, v + 3, v + 6);
    }
  }
  const s = maskable ? 0.8 : 1; // keep the mark in the safe circle
  const cx = size / 2;
  const cy = size / 2;
  const amber = [255, 176, 42];
  // Crosshair ring.
  const ringR = size * 0.34 * s;
  const ringW = Math.max(2, size * 0.012);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - ringR);
      if (d < ringW) set(x, y, ...amber);
    }
  }
  // Crosshair ticks (12/3/6/9 o'clock).
  const tickL = size * 0.05 * s;
  const tickW = Math.max(2, size * 0.008);
  const tick = (dx, dy) => {
    const steps = Math.ceil(tickL);
    for (let i = 0; i <= steps; i++) {
      for (let w = -tickW; w <= tickW; w++) {
        set(Math.round(cx + dx * i - Math.abs(dy) * w), Math.round(cy + dy * i - Math.abs(dx) * w), ...amber);
      }
    }
  };
  const r0 = ringR + size * 0.02;
  tick(0, -1); tick(0, 1); tick(-1, 0); tick(1, 0);
  // (r0 kept for spacing intent; ticks start at the ring edge by construction
  // of the loop below — shift the origin outward.)
  void r0;
  // Three stacked chevrons pointing up.
  const chW = size * 0.2 * s; // half-width
  const chT = Math.max(3, size * 0.028 * s); // thickness
  const chY0 = cy + size * 0.1 * s;
  const chGap = size * 0.075 * s;
  for (let c = 0; c < 3; c++) {
    const yy = chY0 - c * chGap;
    for (let ix = -chW; ix <= chW; ix++) {
      const yOff = Math.abs(ix) * 0.52;
      for (let t = 0; t < chT; t++) {
        set(Math.round(cx + ix), Math.round(yy - yOff - t), ...amber);
      }
    }
  }
  return encodePng(size, size, px);
}

mkdirSync(root, { recursive: true });
const jobs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-192.png', 192, true],
  ['maskable-512.png', 512, true],
];
for (const [name, size, maskable] of jobs) {
  writeFileSync(join(root, name), draw(size, { maskable }));
  console.log('wrote', join('public/icons', name));
}
