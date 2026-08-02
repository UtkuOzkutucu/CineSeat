/**
 * Generate build/icon.ico — no image dependencies, just zlib.
 *
 * The mark is a miniature seat map: rows of seats with the middle-back pair
 * highlighted gold, which is exactly what the app picks for you.
 *
 *   node tools/make-icon.js
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = [0x14, 0x14, 0x14];
const SEAT = [0x98, 0xa7, 0x26]; // Cineverse olive
const PICK = [0xe8, 0xb6, 0x4c]; // the recommended-seat gold
const DIM = [0x3a, 0x36, 0x40];

const S = 256;

function render() {
  const px = Buffer.alloc(S * S * 4);
  const radius = 52;

  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  // Rounded-square background.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = Math.min(x, S - 1 - x);
      const cy = Math.min(y, S - 1 - y);
      let inside = true;
      if (cx < radius && cy < radius) {
        const dx = radius - cx;
        const dy = radius - cy;
        inside = dx * dx + dy * dy <= radius * radius;
      }
      if (inside) set(x, y, BG);
    }
  }

  const roundRect = (x0, y0, w, h, colour, r = 4) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const cx = Math.min(x - x0, x0 + w - 1 - x);
        const cy = Math.min(y - y0, y0 + h - 1 - y);
        if (cx < r && cy < r) {
          const dx = r - cx;
          const dy = r - cy;
          if (dx * dx + dy * dy > r * r) continue;
        }
        set(x, y, colour);
      }
    }
  };

  // Five rows of seats, narrowing toward the screen at the bottom.
  const rows = 5;
  const seatW = 26;
  const seatH = 20;
  const gapX = 9;
  const gapY = 12;
  const top = 46;

  for (let r = 0; r < rows; r++) {
    const count = r < 3 ? 5 : 4;
    const rowW = count * seatW + (count - 1) * gapX;
    const x0 = Math.round((S - rowW) / 2);
    const y = top + r * (seatH + gapY);

    for (let c = 0; c < count; c++) {
      const x = x0 + c * (seatW + gapX);
      // Row index 0 is the back of the hall; the sweet spot sits just in front
      // of it, dead centre — the pair the algorithm favours.
      const isPick = r === 1 && (c === 1 || c === 2);
      const isTaken = (r === 0 && c === 4) || (r === 2 && c === 0) || (r === 4 && c === 3);
      roundRect(x, y, seatW, seatH, isPick ? PICK : isTaken ? DIM : SEAT);
    }
  }

  // The screen, curving away at the bottom.
  for (let x = 44; x < S - 44; x++) {
    const t = (x - 44) / (S - 88);
    const dip = Math.round(Math.sin(t * Math.PI) * 7);
    for (let w = 0; w < 6; w++) set(x, 214 - dip + w, SEAT, 200);
  }

  return px;
}

function png(rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** ICO wrapping a PNG payload — supported since Vista, and what electron-builder wants. */
function ico(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = 0; // 0 means 256
  entry[1] = 0;
  entry[2] = 0; // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12); // offset

  return Buffer.concat([header, entry, pngBuf]);
}

const out = join(dirname(fileURLToPath(import.meta.url)), '../build');
mkdirSync(out, { recursive: true });

const pngBuf = png(render());
writeFileSync(join(out, 'icon.png'), pngBuf);
writeFileSync(join(out, 'icon.ico'), ico(pngBuf));
console.log(`build/icon.ico  ${(ico(pngBuf).length / 1024).toFixed(1)} KB`);
