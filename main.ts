// news-image-20261120 — "Friday 20 November 2026" front page.
// A program that draws one newspaper front page (1024x1024 PNG) summing up
// the world news of Friday 20 November 2026, using only the Node 22 standard
// library. It owns its bitmap font and its PNG encoder (fixed-Huffman DEFLATE
// written here), reads no files and makes no network calls at runtime, so two
// runs write byte-identical output.
//
// Layout (classic broadsheet, after the rank-1 pattern for this series):
//   masthead "FRIDAY 20 NOVEMBER 2026"
//   3 hero stories with code-drawn illustrations
//   10 more illustrated stories in two rows of five
//   a world map "WHERE IT HAPPENED" with numbered pins for stories 1-13
//   a digest "ALSO ON FRIDAY 20 NOVEMBER" with 30 more stories
//   43 stories in total, 13 illustrated, 6 continents.
//
// Sources for every story: the verified prep file for 20 November 2026
// (AP, Reuters, BBC, Morningstar/Dow Jones, Le Monde, EIN Presswire,
// Daily Baku, Clearview Politics). No story from 17 or 18 November is used
// as 20 November news; the unverified Visa/Mastercard cyber-attack claim
// from the prep file is left out entirely.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (((b << 16) | a) >>> 0);
}

// ---------------------------------------------------------------------------
// DEFLATE with fixed Huffman codes (RFC 1951), plus a small greedy LZ77.
// Written from the RFC tables, not copied from any library.
// ---------------------------------------------------------------------------

// Length codes: symbol 257+i, base length and extra bits for each i.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
// Distance codes: symbol i, base distance and extra bits for each i.
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

class BitWriter {
  bytes: number[] = [];
  cur = 0;
  nbits = 0;
  // write() packs bits least-significant first: right for the block header
  // and for length/distance extra bits (RFC 1951 section 3.1.1).
  write(code: number, len: number): void {
    for (let i = 0; i < len; i++) {
      if ((code >> i) & 1) this.cur |= (1 << this.nbits);
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }
  // Huffman codes, by contrast, are packed most-significant bit first
  // (RFC 1951 section 3.1.1): writeHuff emits bit len-1 down to bit 0.
  writeHuff(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      if ((code >> i) & 1) this.cur |= (1 << this.nbits);
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }
  finish(): Uint8Array {
    if (this.nbits > 0) this.bytes.push(this.cur);
    return new Uint8Array(this.bytes);
  }
}

// Fixed-Huffman code for a literal/length symbol (RFC 1951 section 3.2.6).
function litCode(sym: number): [number, number] {
  if (sym <= 143) return [0x30 + sym, 8];
  if (sym <= 255) return [0x190 + (sym - 144), 9];
  if (sym <= 279) return [sym - 256, 7];
  return [0xc0 + (sym - 280), 8];
}

type Tok = { lit: number } | { len: number; dist: number };

function tokenize(data: Uint8Array): Tok[] {
  const toks: Tok[] = [];
  const table = new Map<number, number[]>();
  const n = data.length;
  let i = 0;
  const register = (pos: number): void => {
    if (pos + 3 > n) return;
    const h = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
    let list = table.get(h);
    if (!list) {
      list = [];
      table.set(h, list);
    }
    list.push(pos);
    if (list.length > 64) list.shift();
  };
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 3 <= n) {
      const h = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      const cands = table.get(h);
      if (cands) {
        for (let k = cands.length - 1; k >= 0 && k >= cands.length - 24; k--) {
          const j = cands[k];
          const dist = i - j;
          if (dist > 32768) break;
          let len = 0;
          while (len < 258 && i + len < n && data[j + len] === data[i + len]) len++;
          if (len >= 3 && len > bestLen) {
            bestLen = len;
            bestDist = dist;
            if (len === 258) break;
          }
        }
      }
    }
    if (bestLen >= 3) {
      toks.push({ len: bestLen, dist: bestDist });
      for (let p = 0; p < bestLen; p++) register(i + p);
      i += bestLen;
    } else {
      toks.push({ lit: data[i] });
      register(i);
      i++;
    }
  }
  return toks;
}

function deflateFixed(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  w.write(1, 1); // BFINAL
  w.write(1, 2); // BTYPE = 01, fixed Huffman
  const toks = tokenize(data);
  for (const t of toks) {
    if ('lit' in t) {
      const [c, l] = litCode(t.lit);
      w.writeHuff(c, l);
    } else {
      let li = 0;
      while (li < LEN_BASE.length - 1 && LEN_BASE[li + 1] <= t.len) li++;
      const [c, l] = litCode(257 + li);
      w.writeHuff(c, l);
      if (LEN_EXTRA[li] > 0) w.write(t.len - LEN_BASE[li], LEN_EXTRA[li]);
      let di = 0;
      while (di < DIST_BASE.length - 1 && DIST_BASE[di + 1] <= t.dist) di++;
      w.writeHuff(di, 5);
      if (DIST_EXTRA[di] > 0) w.write(t.dist - DIST_BASE[di], DIST_EXTRA[di]);
    }
  }
  const [ec, el] = litCode(256); // end of block
  w.writeHuff(ec, el);
  return w.finish();
}

// ---------------------------------------------------------------------------
// PNG encoder (8-bit RGB, filter 0 on every scanline)
// ---------------------------------------------------------------------------

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8 + data.length), 0);
  dv.setUint32(8 + data.length, crc32(crcData));
  return out;
}

function encodePNG(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  }
  const deflated = deflateFixed(raw);
  const zlib = new Uint8Array(2 + deflated.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib.set(deflated, 2);
  const zv = new DataView(zlib.buffer);
  zv.setUint32(2 + deflated.length, adler32(raw));
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib), pngChunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canvas: an RGB framebuffer with small drawing primitives
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

const PAPER: RGB = [245, 238, 218]; // newsprint cream
const INK: RGB = [26, 26, 26];
const RED: RGB = [179, 32, 44];
const NAVY: RGB = [31, 58, 95];
const GREEN: RGB = [30, 77, 43];
const TAN: RGB = [233, 217, 166];
const TAN_DARK: RGB = [138, 122, 74];
const OCEAN: RGB = [188, 214, 232];
const GRID: RGB = [157, 184, 204];
const GREY: RGB = [120, 120, 116];
const LIGHT_GREY: RGB = [210, 205, 190];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const GOLD: RGB = [212, 175, 55];
const ORANGE: RGB = [230, 110, 30];
const SKY: RGB = [168, 205, 235];
const DARK_SKY: RGB = [38, 52, 84];
const SEA: RGB = [64, 110, 150];

class Canvas {
  w: number;
  h: number;
  buf: Uint8Array;
  constructor(w: number, h: number, bg: RGB) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8Array(w * h * 3);
    this.fillRect(0, 0, w, h, bg);
  }
  px(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3;
    this.buf[o] = c[0];
    this.buf[o + 1] = c[1];
    this.buf[o + 2] = c[2];
  }
  fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w));
    const y1 = Math.min(this.h, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.px(xx, yy, c);
    }
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, t = 1): void {
    this.fillRect(x, y, w, t, c);
    this.fillRect(x, y + h - t, w, t, c);
    this.fillRect(x, y, t, h, c);
    this.fillRect(x + w - t, y, t, h, c);
  }
  hline(x0: number, x1: number, y: number, c: RGB, t = 1): void {
    this.fillRect(Math.min(x0, x1), y, Math.abs(x1 - x0) + 1, t, c);
  }
  vline(x: number, y0: number, y1: number, c: RGB, t = 1): void {
    this.fillRect(x, Math.min(y0, y1), t, Math.abs(y1 - y0) + 1, c);
  }
  // Bresenham line. Coordinates are rounded first: with fractional inputs
  // the exact x === x1 && y === y1 stop condition can never be met.
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, t = 1): void {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    if (x0 === x1 && y0 === y1) {
      this.fillRect(x0 - Math.floor(t / 2), y0 - Math.floor(t / 2), t, t, c);
      return;
    }
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.fillRect(x - Math.floor(t / 2), y - Math.floor(t / 2), t, t, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }
  circle(cx: number, cy: number, r: number, c: RGB): void {
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      this.hline(cx - dx, cx + dx, cy + dy, c);
    }
  }
  ring(cx: number, cy: number, r: number, c: RGB, t = 1): void {
    for (let a = 0; a < 360; a += 1) {
      const rad = (a * Math.PI) / 180;
      const x = Math.round(cx + r * Math.cos(rad));
      const y = Math.round(cy + r * Math.sin(rad));
      this.fillRect(x - Math.floor(t / 2), y - Math.floor(t / 2), t, t, c);
    }
  }
  // Scanline fill of a simple polygon.
  fillPoly(pts: Array<[number, number]>, c: RGB): void {
    if (pts.length < 3) return;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const [, y] of pts) {
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
    }
    for (let y = Math.ceil(ymin); y <= Math.floor(ymax); y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[(i + 1) % pts.length];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
          xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        this.hline(Math.ceil(xs[k]), Math.floor(xs[k + 1]), y, c);
      }
    }
  }
  polyLine(pts: Array<[number, number]>, c: RGB, t = 1): void {
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      this.line(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), c, t);
    }
  }
  // Filled triangle.
  tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: RGB): void {
    this.fillPoly([[x0, y0], [x1, y1], [x2, y2]], c);
  }
}

// ---------------------------------------------------------------------------
// Bitmap font: 5x7 capitals, digits and punctuation. Each glyph is 7 rows of
// 5 bits written as strings, left bit first. All text is set in capitals,
// which suits the broadsheet style and keeps the font table small.
// Lower-case input is upper-cased by drawText.
// ---------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ';': ['00000', '01100', '01100', '00000', '01100', '00100', '01000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '$': ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '"': ['01010', '01010', '00000', '00000', '00000', '00000', '00000'],
  '*': ['00000', '10101', '01110', '11111', '01110', '10101', '00000'],
};

// Width of one glyph cell at scale s, including the 1-cell gap.
function charAdvance(s: number): number {
  return 5 * s + s;
}

function textWidth(str: string, s: number): number {
  const up = str.toUpperCase();
  if (up.length === 0) return 0;
  return up.length * charAdvance(s) - s;
}

// Draw one glyph with its top-left corner at (x, y); scale s means each
// font pixel becomes an s-by-s block.
function drawChar(cv: Canvas, ch: string, x: number, y: number, s: number, c: RGB): void {
  const g = FONT[ch] ?? FONT['?'];
  for (let r = 0; r < 7; r++) {
    const row = g[r];
    for (let col = 0; col < 5; col++) {
      if (row[col] === '1') cv.fillRect(x + col * s, y + r * s, s, s, c);
    }
  }
}

// Draw text; returns the x coordinate just past the last glyph. When bold is
// set, every glyph is drawn twice, once shifted one pixel right, which reads
// as a heavier weight at headline scales.
function drawText(cv: Canvas, str: string, x: number, y: number, s: number, c: RGB, bold = false): number {
  const up = str.toUpperCase();
  let cx = x;
  for (const ch of up) {
    drawChar(cv, ch, cx, y, s, c);
    if (bold) drawChar(cv, ch, cx + 1, y, s, c);
    cx += charAdvance(s);
  }
  return cx - s;
}

function drawTextCentered(cv: Canvas, str: string, cx: number, y: number, s: number, c: RGB, bold = false): void {
  const w = textWidth(str, s);
  drawText(cv, str, Math.round(cx - w / 2), y, s, c, bold);
}

// Greedy word wrap into lines that fit maxW pixels at scale s.
function wrapText(str: string, maxW: number, s: number): string[] {
  const words = str.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const trial = cur === '' ? w : cur + ' ' + w;
    if (textWidth(trial, s) <= maxW || cur === '') {
      cur = trial;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// Draw up to maxLines wrapped lines starting at (x, y) with the given
// leading; returns the y coordinate below the last line drawn.
function drawBlock(cv: Canvas, str: string, x: number, y: number, maxW: number, s: number, c: RGB, leading: number, maxLines: number): number {
  const lines = wrapText(str, maxW, s).slice(0, maxLines);
  let yy = y;
  for (const ln of lines) {
    drawText(cv, ln, x, yy, s, c);
    yy += leading;
  }
  return yy;
}

// ---------------------------------------------------------------------------
// Code-drawn illustrations. Each draws inside the box (x, y, w, h) it is
// given; nothing is loaded from disk. The number in the comment is the story
// it illustrates.
// ---------------------------------------------------------------------------

// 1 — The Hague: the Peace Palace at dusk, scales of justice in front.
function illCourthouse(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, DARK_SKY);
  cv.circle(x + w * 0.82, y + h * 0.22, 10, GOLD);
  cv.fillRect(x, y + h * 0.72, w, h * 0.28, [70, 78, 60]); // lawn
  const bx = x + w * 0.18;
  const bw = w * 0.64;
  const by = y + h * 0.30;
  // Pediment and roof.
  cv.tri(bx + bw * 0.08, by, bx + bw * 0.5, by - h * 0.16, bx + bw * 0.92, by, [235, 225, 200]);
  cv.fillRect(bx, by, bw, h * 0.06, [235, 225, 200]);
  // Columns and wall.
  cv.fillRect(bx + bw * 0.06, by + h * 0.06, bw * 0.88, h * 0.36, [245, 238, 218]);
  for (let i = 0; i < 5; i++) {
    const cx = bx + bw * (0.12 + i * 0.19);
    cv.fillRect(cx, by + h * 0.08, w * 0.025, h * 0.32, WHITE);
    cv.fillRect(cx - 2, by + h * 0.06, w * 0.025 + 4, 3, WHITE);
  }
  // Steps.
  cv.fillRect(bx - 6, by + h * 0.42, bw + 12, 4, LIGHT_GREY);
  cv.fillRect(bx - 12, by + h * 0.42 + 4, bw + 24, 4, GREY);
  // Scales of justice, small, in front of the steps.
  const sx = x + w * 0.5;
  const sy = y + h * 0.52;
  cv.vline(sx, sy - 14, sy + 12, GOLD, 2);
  cv.hline(sx - 16, sx + 16, sy - 14, GOLD, 2);
  cv.line(sx - 16, sy - 14, sx - 22, sy - 2, GOLD);
  cv.line(sx - 16, sy - 14, sx - 10, sy - 2, GOLD);
  cv.line(sx + 16, sy - 14, sx + 10, sy - 2, GOLD);
  cv.line(sx + 16, sy - 14, sx + 22, sy - 2, GOLD);
  cv.tri(sx - 24, sy - 2, sx - 10, sy - 2, sx - 17, sy + 6, GOLD);
  cv.tri(sx + 10, sy - 2, sx + 24, sy - 2, sx + 17, sy + 6, GOLD);
  cv.circle(sx, sy - 17, 3, GOLD);
  // Verdict banner.
  cv.fillRect(x, y + h - 16, w, 16, RED);
  drawTextCentered(cv, '9-6  GENOCIDE', x + w / 2, y + h - 13, 1, WHITE, true);
}

// 2 — Shenzhen: three leaders at a table under three flags and a skyline.
function illSummit(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, SKY);
  // Skyline.
  const base = y + h * 0.62;
  const heights = [0.34, 0.48, 0.28, 0.42, 0.55, 0.30, 0.38];
  for (let i = 0; i < 7; i++) {
    const bx = x + w * (0.03 + i * 0.14);
    const bh = h * heights[i];
    cv.fillRect(bx, base - bh, w * 0.11, bh + h * 0.1, [96, 104, 122]);
    cv.fillRect(bx + 3, base - bh + 5, w * 0.11 - 6, 3, GOLD);
  }
  cv.fillRect(x, base, w, h * 0.1, [70, 78, 92]);
  // Table.
  cv.fillRect(x + w * 0.14, y + h * 0.74, w * 0.72, 5, [120, 72, 40]);
  cv.fillRect(x + w * 0.16, y + h * 0.74 + 5, 4, h * 0.12, [120, 72, 40]);
  cv.fillRect(x + w * 0.80, y + h * 0.74 + 5, 4, h * 0.12, [120, 72, 40]);
  // Three seated figures.
  const suits: RGB[] = [NAVY, RED, [58, 58, 58]];
  for (let i = 0; i < 3; i++) {
    const fx = x + w * (0.24 + i * 0.26);
    const fy = y + h * 0.60;
    cv.circle(fx, fy, 7, [232, 196, 160]); // head
    cv.fillRect(fx - 9, fy + 7, 18, h * 0.14, suits[i]); // shoulders
  }
  // Flags on poles above the table.
  const flagX = [0.20, 0.47, 0.74];
  for (let i = 0; i < 3; i++) {
    const fx = x + w * flagX[i];
    const fy = y + h * 0.10;
    cv.vline(fx, fy, fy + h * 0.44, INK, 2);
    const fw = w * 0.16;
    const fh = h * 0.16;
    if (i === 0) {
      // United States: stripes and blue canton.
      for (let s = 0; s < 5; s++) cv.fillRect(fx, fy + (s * fh) / 5, fw, fh / 5 + 1, s % 2 === 0 ? RED : WHITE);
      cv.fillRect(fx, fy, fw * 0.45, fh * 0.55, NAVY);
      cv.circle(fx + fw * 0.22, fy + fh * 0.27, 2, WHITE);
    } else if (i === 1) {
      // China: red field, gold stars.
      cv.fillRect(fx, fy, fw, fh, RED);
      cv.circle(fx + fw * 0.25, fy + fh * 0.30, 3, GOLD);
      cv.circle(fx + fw * 0.55, fy + fh * 0.18, 2, GOLD);
      cv.circle(fx + fw * 0.68, fy + fh * 0.38, 2, GOLD);
    } else {
      // Russia: white, blue, red bands.
      cv.fillRect(fx, fy, fw, fh / 3, WHITE);
      cv.fillRect(fx, fy + fh / 3, fw, fh / 3, NAVY);
      cv.fillRect(fx, fy + (2 * fh) / 3, fw, fh / 3, RED);
    }
  }
  cv.fillRect(x, y + h - 16, w, 16, NAVY);
  drawTextCentered(cv, 'SHENZHEN', x + w / 2, y + h - 13, 1, WHITE, true);
}

// 3 — Anthropic IPO: rising bars on a dark board, +34% and $2T.
function illIpo(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, GREEN);
  const bars = [0.18, 0.26, 0.24, 0.38, 0.48, 0.60];
  const base = y + h * 0.78;
  for (let i = 0; i < bars.length; i++) {
    const bx = x + w * (0.08 + i * 0.15);
    const bh = h * bars[i];
    cv.fillRect(bx, base - bh, w * 0.10, bh, i === bars.length - 1 ? GOLD : [86, 190, 120]);
  }
  // Trend line over the bars, ending clear of the tallest bar.
  cv.line(x + w * 0.10, base - h * 0.18, x + w * 0.88, base - h * 0.62, GOLD, 2);
  cv.circle(x + w * 0.88, base - h * 0.62, 4, GOLD);
  drawText(cv, '+34%', x + w * 0.60, y + h * 0.08, 3, WHITE, true);
  drawText(cv, '$2T', x + w * 0.08, y + h * 0.08, 2, GOLD, true);
  drawText(cv, 'ANT  NASDAQ', x + w * 0.08, y + h * 0.30, 1, [200, 220, 200]);
  cv.fillRect(x, y + h - 16, w, 16, [20, 50, 30]);
  drawTextCentered(cv, 'BIGGEST AI DEBUT', x + w / 2, y + h - 13, 1, WHITE, true);
}

// 4 — Kyiv: skyline at night, missile trails and orange bursts, three bridges.
function illKyiv(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, DARK_SKY);
  cv.circle(x + w * 0.86, y + h * 0.16, 8, [220, 220, 200]);
  // Skyline silhouette.
  const base = y + h * 0.78;
  const hs = [0.30, 0.44, 0.26, 0.50, 0.34, 0.40];
  for (let i = 0; i < hs.length; i++) {
    const bx = x + w * (0.02 + i * 0.165);
    cv.fillRect(bx, base - h * hs[i], w * 0.13, h * hs[i] + h * 0.08, [20, 28, 48]);
    cv.fillRect(bx + 4, base - h * hs[i] + 6, 3, 3, GOLD);
    cv.fillRect(bx + w * 0.07, base - h * hs[i] + 12, 3, 3, GOLD);
  }
  // Three bridges across the river at the bottom.
  cv.fillRect(x, base, w, h * 0.22, [52, 84, 120]);
  for (let i = 0; i < 3; i++) {
    const by = base + h * (0.04 + i * 0.07);
    cv.hline(x + 4, x + w - 4, by, [200, 205, 210], 2);
  }
  // Missile trails from the top.
  const trails: Array<[number, number, number, number]> = [
    [0.18, 0.04, 0.30, 0.42],
    [0.52, 0.02, 0.46, 0.36],
    [0.78, 0.06, 0.68, 0.40],
  ];
  for (const [ax, ay, bx, by] of trails) {
    cv.line(x + w * ax, y + h * ay, x + w * bx, y + h * by, WHITE, 1);
    cv.circle(x + w * bx, y + h * by, 3, WHITE);
  }
  // Explosions where they land.
  const bursts: Array<[number, number, number]> = [
    [0.30, 0.46, 9],
    [0.46, 0.40, 7],
    [0.68, 0.44, 9],
  ];
  for (const [bx, by, r] of bursts) {
    cv.circle(x + w * bx, y + h * by, r, ORANGE);
    cv.circle(x + w * bx, y + h * by, Math.floor(r * 0.55), GOLD);
  }
  cv.fillRect(x, y + h - 16, w, 16, RED);
  drawTextCentered(cv, '4 MISSILES', x + w / 2, y + h - 13, 1, WHITE, true);
}

// 5 — US Senate: the Capitol dome and a 51-48 vote tally.
function illSenate(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, PAPER);
  const cx = x + w * 0.5;
  const base = y + h * 0.62;
  // Dome: a half-circle that stays inside the box, on a short drum.
  const dr = w * 0.13;
  const dcy = base - h * 0.22;
  cv.circle(cx, dcy, dr, WHITE);
  cv.fillRect(cx - dr, dcy, dr * 2, h * 0.22, WHITE);
  cv.fillRect(cx - 1, dcy - dr - 7, 2, 7, INK); // spire
  cv.circle(cx, dcy - dr - 8, 2, INK);
  // Wings and columns.
  cv.fillRect(x + w * 0.08, base - h * 0.10, w * 0.84, h * 0.10, WHITE);
  for (let i = 0; i < 6; i++) {
    const px = x + w * (0.14 + i * 0.14);
    cv.vline(px, base - h * 0.10, base, GREY, 2);
  }
  cv.fillRect(x + w * 0.06, base, w * 0.88, 4, GREY);
  // Vote bars.
  const by = y + h * 0.70;
  drawText(cv, '51', x + w * 0.06, by, 1, NAVY, true);
  cv.fillRect(x + w * 0.20, by + 1, w * 0.51, 8, NAVY);
  drawText(cv, '48', x + w * 0.06, by + 12, 1, RED, true);
  cv.fillRect(x + w * 0.20, by + 13, w * 0.48, 8, RED);
  drawText(cv, 'NO', x + w * 0.72, by + 12, 1, RED, true);
}

// 6 — Poland: a radar screen sweeping, one unknown blip at the border.
function illRadar(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, [16, 40, 26]);
  const cx = x + w * 0.5;
  const cy = y + h * 0.42;
  const r = Math.min(w, h) * 0.36;
  cv.ring(cx, cy, r, [86, 190, 120], 1);
  cv.ring(cx, cy, r * 0.62, [86, 190, 120], 1);
  cv.ring(cx, cy, r * 0.28, [86, 190, 120], 1);
  cv.line(cx - r, cy, cx + r, cy, [60, 140, 90]);
  cv.line(cx, cy - r, cx, cy + r, [60, 140, 90]);
  // Sweep arm.
  cv.line(cx, cy, cx + r * 0.85, cy - r * 0.5, [140, 230, 160], 2);
  // The unknown blip.
  cv.circle(cx + r * 0.55, cy - r * 0.30, 4, ORANGE);
  cv.ring(cx + r * 0.55, cy - r * 0.30, 8, ORANGE, 1);
  // Dashed border at the bottom.
  for (let bx = x + 4; bx < x + w - 4; bx += 10) cv.hline(bx, bx + 5, y + h * 0.74, WHITE, 1);
  cv.fillRect(x, y + h - 16, w, 16, [10, 26, 16]);
  drawTextCentered(cv, '07:30  WARNING LIFTED', x + w / 2, y + h - 13, 1, [140, 230, 160]);
}

// 7 — Britain's drones: five quadcopters crossing a pale sky.
function illDrones(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, SKY);
  cv.circle(x + w * 0.80, y + h * 0.18, 11, [255, 244, 200]);
  // Dotted flight paths.
  for (let i = 0; i < 3; i++) {
    const yy = y + h * (0.30 + i * 0.18);
    for (let dx = x + 6; dx < x + w - 6; dx += 8) cv.fillRect(dx, yy, 3, 1, WHITE);
  }
  const spots: Array<[number, number, number]> = [
    [0.18, 0.34, 1.0],
    [0.42, 0.26, 0.85],
    [0.62, 0.42, 1.0],
    [0.80, 0.30, 0.75],
    [0.30, 0.55, 0.9],
  ];
  for (const [fx, fy, sc] of spots) {
    const dx = x + w * fx;
    const dy = y + h * fy;
    const s = 7 * sc;
    // Four rotors.
    cv.circle(dx - s, dy - s, 3, INK);
    cv.circle(dx + s, dy - s, 3, INK);
    cv.circle(dx - s, dy + s, 3, INK);
    cv.circle(dx + s, dy + s, 3, INK);
    cv.line(dx - s, dy - s, dx + s, dy + s, INK, 1);
    cv.line(dx + s, dy - s, dx - s, dy + s, INK, 1);
    cv.fillRect(dx - 4, dy - 3, 8, 6, NAVY);
  }
  cv.fillRect(x, y + h - 16, w, 16, NAVY);
  drawTextCentered(cv, '1,000+ DRONES', x + w / 2, y + h - 13, 1, WHITE, true);
}

// 8 — Pete Rose: a baseball diamond, a ball and a bat.
function illBaseball(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, [58, 140, 70]);
  // Outfield wall arc.
  cv.fillRect(x, y + h * 0.78, w, h * 0.22, [40, 110, 55]);
  // Diamond.
  const cx = x + w * 0.5;
  const cy = y + h * 0.62;
  cv.line(cx, cy, cx - w * 0.30, cy - h * 0.30, WHITE, 2);
  cv.line(cx, cy, cx + w * 0.30, cy - h * 0.30, WHITE, 2);
  cv.line(cx - w * 0.30, cy - h * 0.30, cx, cy - h * 0.60, WHITE, 2);
  cv.line(cx + w * 0.30, cy - h * 0.30, cx, cy - h * 0.60, WHITE, 2);
  // Bases.
  cv.fillRect(cx - 3, cy - 3, 6, 6, WHITE);
  cv.fillRect(cx - w * 0.30 - 3, cy - h * 0.30 - 3, 6, 6, WHITE);
  cv.fillRect(cx + w * 0.30 - 3, cy - h * 0.30 - 3, 6, 6, WHITE);
  cv.fillRect(cx - 3, cy - h * 0.60 - 3, 6, 6, WHITE);
  // Pitcher's mound.
  cv.circle(cx, cy - h * 0.30, 6, [220, 190, 140]);
  // The ball, large, top right, with red stitching.
  const bx = x + w * 0.78;
  const by = y + h * 0.22;
  cv.circle(bx, by, 13, WHITE);
  cv.ring(bx, by, 13, RED, 1);
  cv.line(bx - 8, by - 8, bx - 2, by + 8, RED, 1);
  cv.line(bx + 8, by - 8, bx + 2, by + 8, RED, 1);
  // A bat leaning at the left.
  cv.line(x + w * 0.12, y + h * 0.55, x + w * 0.20, y + h * 0.18, [200, 160, 110], 3);
  cv.fillRect(x, y + h - 16, w, 16, RED);
  drawTextCentered(cv, 'HIT KING', x + w / 2, y + h - 13, 1, WHITE, true);
}

// 9 — Measles: red virus particles over a white cross.
function illMeasles(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, [250, 244, 230]);
  // White cross, faint, as the background.
  cv.fillRect(x + w * 0.44, y + h * 0.10, w * 0.12, h * 0.70, [235, 228, 210]);
  cv.fillRect(x + w * 0.20, y + h * 0.32, w * 0.60, h * 0.26, [235, 228, 210]);
  // Virus particles: spiked circles.
  const spots: Array<[number, number, number]> = [
    [0.24, 0.26, 11],
    [0.62, 0.20, 14],
    [0.80, 0.52, 10],
    [0.38, 0.58, 13],
    [0.58, 0.68, 9],
  ];
  for (const [fx, fy, r] of spots) {
    const px = x + w * fx;
    const py = y + h * fy;
    for (let a = 0; a < 360; a += 30) {
      const rad = (a * Math.PI) / 180;
      cv.line(px + Math.round(r * 0.8 * Math.cos(rad)), py + Math.round(r * 0.8 * Math.sin(rad)),
        px + Math.round(r * 1.5 * Math.cos(rad)), py + Math.round(r * 1.5 * Math.sin(rad)), RED, 1);
    }
    cv.circle(px, py, r, RED);
    cv.circle(px - 3, py - 3, 3, [255, 120, 110]);
    cv.circle(px + 4, py + 3, 2, [255, 120, 110]);
  }
  cv.fillRect(x, y + h - 16, w, 16, RED);
  drawTextCentered(cv, 'SINCE 2000', x + w / 2, y + h - 13, 1, WHITE, true);
}

// 10 — UK-EU youth mobility: Union Jack and EU stars, arrows between them.
function illFlags(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, PAPER);
  const fw = w * 0.36;
  const fh = h * 0.52;
  const fy = y + h * 0.12;
  // Union Jack, simplified: blue field, white and red crosses.
  const ux = x + w * 0.06;
  cv.fillRect(ux, fy, fw, fh, NAVY);
  cv.fillRect(ux, fy + fh * 0.42, fw, fh * 0.16, WHITE);
  cv.fillRect(ux + fw * 0.44, fy, fw * 0.12, fh, WHITE);
  cv.fillRect(ux, fy + fh * 0.46, fw, fh * 0.08, RED);
  cv.fillRect(ux + fw * 0.47, fy, fw * 0.06, fh, RED);
  cv.line(ux, fy, ux + fw, fy + fh, WHITE, 2);
  cv.line(ux + fw, fy, ux, fy + fh, WHITE, 2);
  // EU flag: blue field, ring of gold stars.
  const ex = x + w * 0.58;
  cv.fillRect(ex, fy, fw, fh, NAVY);
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6 - Math.PI / 2;
    const sx = ex + fw / 2 + Math.cos(a) * fw * 0.32;
    const sy = fy + fh / 2 + Math.sin(a) * fh * 0.32;
    cv.circle(sx, sy, 2, GOLD);
  }
  // Two-way arrows between the flags.
  const ay = fy + fh * 0.30;
  cv.line(x + w * 0.44, ay, x + w * 0.56, ay, RED, 2);
  cv.tri(x + w * 0.56, ay, x + w * 0.53, ay - 3, x + w * 0.53, ay + 3, RED);
  const ay2 = fy + fh * 0.68;
  cv.line(x + w * 0.56, ay2, x + w * 0.44, ay2, RED, 2);
  cv.tri(x + w * 0.44, ay2, x + w * 0.47, ay2 - 3, x + w * 0.47, ay2 + 3, RED);
  drawTextCentered(cv, 'YOUTH MOBILITY', x + w / 2, y + h - 13, 1, INK, true);
}

// 11 — Japan inflation: a rising red line over a yen mark, +2.2%.
function illInflation(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, WHITE);
  // Grid.
  for (let i = 1; i < 4; i++) cv.hline(x + 4, x + w - 4, y + (i * h) / 4, LIGHT_GREY);
  // Rising line.
  const pts: Array<[number, number]> = [
    [0.10, 0.68], [0.28, 0.62], [0.46, 0.64], [0.62, 0.48], [0.78, 0.34], [0.92, 0.18],
  ];
  for (let i = 0; i + 1 < pts.length; i++) {
    cv.line(x + w * pts[i][0], y + h * pts[i][1], x + w * pts[i + 1][0], y + h * pts[i + 1][1], RED, 2);
    cv.circle(x + w * pts[i][0], y + h * pts[i][1], 3, RED);
  }
  cv.circle(x + w * 0.92, y + h * 0.18, 3, RED);
  // Yen mark: a Y with two bars, drawn in ink at the left.
  const yx = x + w * 0.12;
  const yy = y + h * 0.16;
  cv.line(yx, yy, yx + 8, yy + 10, INK, 2);
  cv.line(yx + 16, yy, yx + 8, yy + 10, INK, 2);
  cv.line(yx + 8, yy + 10, yx + 8, yy + 20, INK, 2);
  cv.hline(yx - 2, yx + 18, yy + 13, INK, 2);
  cv.hline(yx - 2, yx + 18, yy + 17, INK, 2);
  drawText(cv, '+2.2%', x + w * 0.52, y + h * 0.52, 2, RED, true);
  cv.fillRect(x, y + h - 16, w, 16, RED);
  drawTextCentered(cv, 'OCTOBER', x + w / 2, y + h - 13, 1, WHITE, true);
}

// 12 — China AI chips: a black chip with gold pins and circuit traces.
function illChip(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, [24, 32, 44]);
  // Circuit traces.
  cv.line(x + w * 0.08, y + h * 0.20, x + w * 0.30, y + h * 0.20, [70, 140, 110], 1);
  cv.line(x + w * 0.30, y + h * 0.20, x + w * 0.30, y + h * 0.32, [70, 140, 110], 1);
  cv.line(x + w * 0.92, y + h * 0.75, x + w * 0.70, y + h * 0.75, [70, 140, 110], 1);
  cv.line(x + w * 0.70, y + h * 0.75, x + w * 0.70, y + h * 0.62, [70, 140, 110], 1);
  cv.circle(x + w * 0.08, y + h * 0.20, 2, [70, 140, 110]);
  cv.circle(x + w * 0.92, y + h * 0.75, 2, [70, 140, 110]);
  // Chip body.
  const cx = x + w * 0.30;
  const cy = y + h * 0.18;
  const cw = w * 0.40;
  const ch = h * 0.56;
  cv.fillRect(cx, cy, cw, ch, [10, 12, 16]);
  cv.rect(cx, cy, cw, ch, GOLD, 1);
  // Pins on all four sides.
  for (let i = 0; i < 5; i++) {
    const py = cy + ch * (0.12 + i * 0.19);
    cv.fillRect(cx - 6, py, 6, 2, GOLD);
    cv.fillRect(cx + cw, py, 6, 2, GOLD);
    const px = cx + cw * (0.12 + i * 0.19);
    cv.fillRect(px, cy - 6, 2, 6, GOLD);
    cv.fillRect(px, cy + ch, 2, 6, GOLD);
  }
  // Inner die.
  cv.fillRect(cx + cw * 0.22, cy + ch * 0.22, cw * 0.56, ch * 0.56, [26, 60, 44]);
  drawTextCentered(cv, 'AI', cx + cw / 2, cy + ch * 0.38, 2, [140, 230, 160], true);
  cv.fillRect(x, y + h - 16, w, 16, [20, 50, 30]);
  drawTextCentered(cv, 'NO US CHIPS?', x + w / 2, y + h - 13, 1, GOLD, true);
}

// 13 — Strait of Hormuz: a tanker on a blue sea, flames and a spiked mine.
function illTanker(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, SKY);
  cv.fillRect(x, y + h * 0.60, w, h * 0.40, SEA);
  // Wave lines.
  for (let i = 0; i < 3; i++) {
    const wy = y + h * (0.68 + i * 0.10);
    for (let dx = x + 4; dx < x + w - 10; dx += 14) cv.hline(dx, dx + 7, wy, [140, 190, 220], 1);
  }
  // Tanker hull and containers.
  const hx = x + w * 0.12;
  const hy = y + h * 0.48;
  cv.fillRect(hx, hy, w * 0.62, h * 0.14, [40, 40, 44]);
  cv.fillRect(hx + w * 0.02, hy - h * 0.12, w * 0.14, h * 0.12, [200, 60, 50]);
  cv.fillRect(hx + w * 0.18, hy - h * 0.12, w * 0.14, h * 0.12, [60, 120, 200]);
  cv.fillRect(hx + w * 0.34, hy - h * 0.12, w * 0.14, h * 0.12, [230, 180, 60]);
  cv.fillRect(hx + w * 0.50, hy - h * 0.16, w * 0.10, h * 0.16, WHITE); // bridge
  // Flames from the bow.
  const fx = hx + w * 0.58;
  const fy = hy - h * 0.02;
  cv.tri(fx - 8, fy, fx, fy - h * 0.22, fx + 8, fy, ORANGE);
  cv.tri(fx - 4, fy, fx + 3, fy - h * 0.14, fx + 10, fy, GOLD);
  cv.circle(fx + 2, fy - h * 0.10, 4, GOLD);
  // Smoke.
  cv.circle(fx + 6, fy - h * 0.28, 5, [90, 90, 90]);
  cv.circle(fx + 12, fy - h * 0.36, 6, [110, 110, 110]);
  // A spiked mine drifting to the right.
  const mx = x + w * 0.84;
  const my = y + h * 0.72;
  for (let a = 0; a < 360; a += 45) {
    const rad = (a * Math.PI) / 180;
    cv.line(mx + Math.round(6 * Math.cos(rad)), my + Math.round(6 * Math.sin(rad)),
      mx + Math.round(11 * Math.cos(rad)), my + Math.round(11 * Math.sin(rad)), INK, 1);
  }
  cv.circle(mx, my, 7, INK);
  cv.fillRect(x, y + h - 16, w, 16, NAVY);
  drawTextCentered(cv, 'MINE STRIKE', x + w / 2, y + h - 13, 1, WHITE, true);
}

// ---------------------------------------------------------------------------
// World map: simplified continent outlines in [longitude, latitude] pairs,
// drawn with an equirectangular projection. Stylised, not survey-grade —
// the pins and the story numbers are what the reader uses it for.
// ---------------------------------------------------------------------------

const CONTINENTS: Array<Array<[number, number]>> = [
  // North America.
  [[-168, 66], [-150, 70], [-135, 69], [-125, 71], [-115, 73], [-100, 73], [-90, 74], [-85, 70], [-80, 73], [-70, 62], [-60, 55], [-55, 52], [-60, 46], [-68, 45], [-75, 38], [-76, 35], [-80, 32], [-84, 30], [-89, 29], [-90, 21], [-94, 19], [-97, 16], [-93, 15], [-88, 14], [-84, 12], [-80, 9], [-79, 9], [-83, 10], [-87, 13], [-91, 14], [-95, 16], [-97, 16], [-105, 20], [-110, 23], [-114, 28], [-120, 34], [-125, 40], [-124, 48], [-130, 55], [-140, 60], [-152, 58], [-158, 58], [-165, 60], [-168, 66]],
  // Greenland.
  [[-55, 60], [-45, 60], [-32, 68], [-22, 70], [-20, 76], [-30, 80], [-50, 78], [-58, 72], [-55, 64]],
  // South America.
  [[-79, 9], [-77, 8], [-75, 10], [-72, 12], [-64, 11], [-60, 9], [-54, 6], [-51, 4], [-50, 0], [-44, -3], [-35, -8], [-37, -13], [-39, -17], [-41, -23], [-48, -27], [-52, -32], [-57, -38], [-62, -41], [-66, -45], [-68, -50], [-70, -54], [-73, -50], [-73, -44], [-72, -37], [-71, -30], [-70, -22], [-75, -15], [-79, -8], [-81, -4], [-80, 0], [-79, 5], [-79, 9]],
  // Africa.
  [[-17, 15], [-16, 20], [-13, 27], [-9, 31], [-5, 35], [-1, 35], [3, 37], [10, 37], [15, 32], [20, 32], [25, 32], [30, 31], [32, 31], [34, 28], [35, 24], [37, 20], [39, 16], [41, 12], [43, 11], [46, 11], [48, 11], [51, 11], [51, 7], [48, 2], [44, -2], [41, -6], [40, -10], [38, -15], [36, -20], [34, -25], [32, -29], [28, -33], [24, -34], [20, -35], [16, -32], [14, -25], [12, -18], [12, -13], [13, -10], [11, -6], [9, 0], [9, 4], [6, 4], [2, 6], [-3, 5], [-8, 5], [-11, 7], [-13, 8], [-15, 11], [-17, 15]],
  // Europe.
  [[-10, 36], [-9, 38], [-9, 43], [-4, 44], [-2, 47], [-2, 49], [-4, 50], [0, 50], [2, 51], [4, 53], [7, 54], [8, 57], [10, 59], [12, 58], [10, 60], [6, 62], [10, 64], [14, 67], [18, 69], [22, 70], [26, 71], [30, 70], [32, 69], [35, 68], [40, 67], [44, 68], [45, 66], [42, 64], [38, 64], [35, 65], [32, 66], [30, 66], [28, 65], [25, 64], [23, 60], [21, 57], [21, 55], [19, 54], [18, 52], [16, 50], [14, 48], [13, 45], [12, 44], [10, 44], [8, 44], [6, 43], [4, 43], [3, 42], [0, 40], [-2, 37], [-6, 36], [-9, 37], [-10, 36]],
  // Britain.
  [[-5, 50], [-3, 53], [-5, 56], [-3, 58], [-1, 57], [0, 53], [1, 51], [-1, 50], [-5, 50]],
  // Asia.
  [[40, 68], [50, 69], [60, 69], [70, 72], [80, 73], [90, 75], [100, 76], [110, 76], [120, 73], [130, 71], [140, 72], [150, 70], [160, 69], [170, 66], [178, 65], [170, 60], [162, 56], [158, 52], [152, 56], [150, 59], [144, 60], [141, 58], [140, 52], [140, 45], [138, 40], [135, 37], [130, 34], [127, 35], [124, 39], [122, 37], [120, 32], [120, 27], [117, 23], [112, 21], [109, 18], [106, 12], [104, 9], [101, 7], [100, 10], [98, 14], [96, 16], [93, 17], [91, 22], [88, 22], [86, 20], [83, 17], [80, 14], [78, 9], [76, 11], [74, 17], [72, 20], [70, 22], [67, 24], [64, 25], [61, 25], [58, 26], [56, 27], [54, 27], [52, 28], [50, 29], [48, 30], [46, 29], [44, 29], [42, 30], [40, 31], [38, 32], [36, 36], [35, 36], [33, 36], [30, 36], [28, 37], [27, 38], [28, 40], [30, 42], [32, 44], [34, 46], [36, 48], [38, 50], [40, 52], [42, 55], [44, 58], [46, 60], [45, 63], [43, 65], [41, 67], [40, 68]],
  // Australia.
  [[113, -22], [114, -28], [115, -33], [118, -35], [124, -33], [129, -32], [132, -32], [135, -35], [137, -35], [140, -38], [145, -38], [149, -37], [150, -35], [153, -32], [153, -27], [151, -24], [148, -20], [146, -19], [144, -15], [142, -11], [140, -17], [139, -17], [137, -12], [135, -12], [134, -12], [132, -11], [130, -13], [128, -14], [126, -14], [124, -16], [122, -17], [120, -19], [117, -20], [114, -21], [113, -22]],
  // New Zealand.
  [[167, -45], [170, -42], [173, -40], [175, -38], [177, -38], [178, -37], [175, -40], [173, -42], [170, -45], [167, -46]],
];

// Pin for each illustrated story: [longitude, latitude, offsetX, offsetY].
// The offset moves the numbered circle away from its true spot (with a
// leader line) where several pins would otherwise sit on top of each other
// in western Europe and on the US east coast.
const PINS: Array<[number, number, number, number]> = [
  [4.3, 52.1, 0, -18], // 1 The Hague
  [114.1, 22.5, 0, 0], // 2 Shenzhen
  [-74.0, 40.7, 10, -8], // 3 New York
  [30.5, 50.5, 11, -9], // 4 Kyiv
  [-77.0, 38.9, -2, 10], // 5 Washington
  [23.5, 50.0, -14, -16], // 6 Poland-Ukraine border
  [-0.1, 51.5, -24, -16], // 7 London
  [-84.5, 39.1, -12, 8], // 8 Cincinnati
  [-100.0, 36.0, -4, 16], // 9 United States
  [4.4, 50.8, 16, 14], // 10 Brussels
  [139.7, 35.7, 0, 0], // 11 Tokyo
  [116.4, 39.9, 0, 0], // 12 Beijing
  [56.2, 26.5, 0, 0], // 13 Strait of Hormuz
];

function drawMap(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, OCEAN);
  const project = (lon: number, lat: number): [number, number] => [
    x + ((lon + 180) / 360) * w,
    y + ((75 - lat) / 135) * h,
  ];
  // Graticule every 30 degrees.
  for (let lon = -150; lon <= 150; lon += 30) {
    const px = x + ((lon + 180) / 360) * w;
    cv.vline(Math.round(px), y, y + h, GRID, 1);
  }
  for (let lat = 60; lat >= -60; lat -= 30) {
    const py = y + ((75 - lat) / 135) * h;
    cv.hline(x, x + w, Math.round(py), GRID, 1);
  }
  // Continents.
  for (const poly of CONTINENTS) {
    const pts = poly.map(([lon, lat]) => project(lon, lat));
    cv.fillPoly(pts, TAN);
    cv.polyLine(pts, TAN_DARK, 1);
  }
  // Pins: a small dot at the true spot, a leader line, then the numbered
  // red circle (white ring so it reads over land and sea alike).
  for (let i = 0; i < PINS.length; i++) {
    const [lon, lat, ox, oy] = PINS[i];
    const [px, py] = project(lon, lat);
    const cx = Math.round(px + ox);
    const cy = Math.round(py + oy);
    cv.circle(Math.round(px), Math.round(py), 2, RED);
    if (ox !== 0 || oy !== 0) cv.line(Math.round(px), Math.round(py), cx, cy, RED, 1);
    cv.circle(cx, cy, 8, RED);
    cv.ring(cx, cy, 8, WHITE, 1);
    const label = String(i + 1);
    const lw = textWidth(label, 1);
    drawText(cv, label, Math.round(cx - lw / 2), cy - 3, 1, WHITE, true);
  }
}

// ---------------------------------------------------------------------------
// Stories. All 43 come from the verified 20 November 2026 prep file.
// Illustrated stories carry a kicker, a headline, a deck and a drawing.
// Digest stories are one line each in the "ALSO ON FRIDAY 20 NOVEMBER" list.
// ---------------------------------------------------------------------------

interface Story {
  n: number;
  kicker: string;
  headline: string;
  deck: string;
  draw: (cv: Canvas, x: number, y: number, w: number, h: number) => void;
}

const HERO: Story[] = [
  {
    n: 1,
    kicker: '1 THE HAGUE - JUSTICE',
    headline: 'ICJ: Myanmar committed genocide',
    deck: "Court rules 9-6 Myanmar is responsible for genocide in northern Rakhine, the first such finding in the court's 80-year history.",
    draw: illCourthouse,
  },
  {
    n: 2,
    kicker: '2 SHENZHEN - SUMMIT',
    headline: 'Trump, Xi and Putin sign peace declaration',
    deck: 'First three-way meeting of the leaders ends in a vague declaration with no deal on Ukraine or nuclear arms; Europe hopes to join talks soon.',
    draw: illSummit,
  },
  {
    n: 3,
    kicker: '3 TECH - MARKETS',
    headline: 'Anthropic IPO: shares soar 34% to $2 trillion',
    deck: 'First pure AI company to list on Wall Street; shares up more than 34% on debut to a valuation of about $2 trillion.',
    draw: illIpo,
  },
];

const ROW2: Story[] = [
  {
    n: 4,
    kicker: '4 UKRAINE - WAR',
    headline: 'Russian missiles hit Kyiv',
    deck: 'Four ballistic missiles hit the capital; three bridges struck.',
    draw: illKyiv,
  },
  {
    n: 5,
    kicker: '5 US - SENATE',
    headline: 'Senate votes down Iran war powers, 51-48',
    deck: 'Pentagon puts the cost of an Iran war at $48.3bn, before base damage.',
    draw: illSenate,
  },
  {
    n: 6,
    kicker: '6 POLAND - SECURITY',
    headline: 'Poland probes unknown object at border',
    deck: 'Air-threat warning lifted by 07:30 Polish time.',
    draw: illRadar,
  },
  {
    n: 7,
    kicker: '7 UK - DEFENCE',
    headline: 'Britain pledges 1,000+ drones for Ukraine',
    deck: '260m-pound package announced for Kyiv.',
    draw: illDrones,
  },
  {
    n: 8,
    kicker: '8 US - SPORT',
    headline: 'Trump pardons baseball legend Pete Rose',
    deck: "Posthumous pardon for the game's hit king.",
    draw: illBaseball,
  },
];

const ROW3: Story[] = [
  {
    n: 9,
    kicker: '9 US - HEALTH',
    headline: 'US loses measles-free status',
    deck: 'First time since 2000.',
    draw: illMeasles,
  },
  {
    n: 10,
    kicker: '10 UK - EUROPE',
    headline: 'UK and EU agree youth mobility scheme',
    deck: 'Deal reported by the BBC.',
    draw: illFlags,
  },
  {
    n: 11,
    kicker: '11 JAPAN - ECONOMY',
    headline: 'Japan inflation at 2.2%, rate bets rise',
    deck: 'Core consumer prices up 2.2% in October.',
    draw: illInflation,
  },
  {
    n: 12,
    kicker: '12 CHINA - TECH',
    headline: 'China AI firms hooked on Nvidia chips',
    deck: 'Now face losing access to US chips.',
    draw: illChip,
  },
  {
    n: 13,
    kicker: '13 THE GULF - ENERGY',
    headline: 'Tanker ablaze after hitting mine off Hormuz',
    deck: 'Blaze in the east of the Strait of Hormuz.',
    draw: illTanker,
  },
];

// Digest: stories 14-43, each trimmed to fit one line in the digest column.
const DIGEST: string[] = [
  'UK borrowing up in October, deficit smaller',
  'UK consumer confidence rises despite headwinds',
  'Spain stays Europe\'s star economy; people yet to feel richer',
  'US Senate fast-tracks energy projects, cuts consumer costs',
  'Fed: Goolsbee open to bigger rise; staff pay rises cut',
  'US diesel prices keep falling',
  'Cumin soda challenges cola giants in India',
  'US sanctions Comancheros and \'Ndrangheta',
  'Houthis claim strikes on four Saudi targets; two downed',
  'Israeli strikes hit Hezbollah missile sites in east Lebanon',
  'Saudi-led coalition: missile debris damages Riyadh',
  'Saudi Arabia warns of thunderstorms until Tuesday 24 Nov',
  'Life in a Houthi-besieged Yemeni city: "just fireworks"',
  'White House names cyber chief; Trump fires cyber director',
  'US court limits minister\'s religious emails to staff',
  'Trump asks court to let EPA cancel Biden climate grants',
  'Democrats take House by wide margin, add Senate seats',
  'Jeffries set to be Speaker; Musk spent about $500m in 2026',
  'Kamala Harris meets Macron in Paris',
  'Argentina Senate backs permanent disability framework, 71-0',
  'Nigeria moves to scrap jail for attempted suicide',
  'APEC stage for great-power politics, not trade or AI',
  'Italy: young people targeted on security, ignored on economy',
  'Quake 5.6 strikes near New Caledonia',
  'Genoa airport halts flights after unknown drone',
  'Six killed in gas blast in Georgia housing block',
  'One dead, 15 hurt in French apartment tower fire',
  'Fiona the hippo dies after swallowing hat at Cincinnati Zoo',
  'Las Vegas Grand Prix opening practice cancelled by rain',
  'Ex-MLB pitcher and actor Lance Broadway dies aged 43',
];

// ---------------------------------------------------------------------------
// Page layout (1024 x 1024)
// ---------------------------------------------------------------------------

const W = 1024;
const H = 1024;

function drawStory(cv: Canvas, s: Story, x: number, y: number, w: number, illH: number, headScale: number, headLines: number, deckLines: number): void {
  s.draw(cv, x, y, w, illH);
  const ky = y + illH + 6;
  drawText(cv, s.kicker, x, ky, 1, RED, true);
  const hy = ky + 11;
  const leading = headScale === 3 ? 24 : 16;
  drawBlock(cv, s.headline, x, hy, w, headScale, INK, leading, headLines);
  const dy = hy + headLines * leading + 2;
  drawBlock(cv, s.deck, x, dy, w, 1, [60, 60, 56], 9, deckLines);
}

function main(): void {
  const cv = new Canvas(W, H, PAPER);

  // Outer double border.
  cv.rect(4, 4, W - 8, H - 8, INK, 2);
  cv.rect(8, 8, W - 16, H - 16, INK, 1);

  // Top strip.
  drawText(cv, "THE WORLD'S NEWS IN ONE PICTURE", 14, 14, 1, RED, true);
  const right = '43 STORIES - 6 CONTINENTS - ALL FROM FRIDAY';
  drawText(cv, right, W - 14 - textWidth(right, 1), 14, 1, RED, true);
  cv.hline(14, W - 14, 30, INK, 1);

  // Masthead.
  drawTextCentered(cv, 'Friday 20 November 2026', W / 2, 40, 6, INK, true);
  cv.hline(14, W - 14, 88, INK, 2);
  cv.hline(14, W - 14, 91, INK, 1);

  // Subhead: the three lead stories in one line.
  drawTextCentered(
    cv,
    'ICJ: MYANMAR GUILTY OF GENOCIDE - TRUMP, XI AND PUTIN DECLARE PEACE - ANTHROPIC SHARES +34% ON DEBUT',
    W / 2, 97, 1, RED, true,
  );
  cv.hline(14, W - 14, 110, INK, 1);

  // Hero row: three big stories.
  const heroW = 322;
  const heroX = [14, 350, 686];
  for (let i = 0; i < HERO.length; i++) {
    drawStory(cv, HERO[i], heroX[i], 116, heroW, 100, 3, 3, 3);
  }
  cv.hline(14, W - 14, 344, INK, 1);

  // Rows of five illustrated stories.
  const colW = 189;
  const colX = [14, 215, 416, 617, 818];
  for (let i = 0; i < ROW2.length; i++) {
    drawStory(cv, ROW2[i], colX[i], 350, colW, 76, 2, 3, 3);
  }
  cv.hline(14, W - 14, 532, INK, 1);
  for (let i = 0; i < ROW3.length; i++) {
    drawStory(cv, ROW3[i], colX[i], 538, colW, 76, 2, 3, 3);
  }
  cv.hline(14, W - 14, 720, INK, 1);

  // Map section: world map on the left, digest on the right.
  drawText(cv, 'WHERE IT HAPPENED', 14, 728, 1, RED, true);
  drawText(cv, 'ALSO ON FRIDAY 20 NOVEMBER', 616, 728, 1, RED, true);
  drawMap(cv, 14, 746, 592, 222);
  let dy = 746;
  for (let i = 0; i < DIGEST.length; i++) {
    const label = `${14 + i} ${DIGEST[i]}`;
    drawText(cv, label, 616, dy, 1, INK);
    dy += 8;
  }
  drawText(cv, 'PINS 1-13. SOURCES: AP, REUTERS, BBC, MORNINGSTAR, LE MONDE, EIN, DAILY BAKU', 14, 976, 1, [90, 84, 70]);

  // Footer.
  cv.hline(14, W - 14, 994, INK, 1);
  drawTextCentered(
    cv,
    'EVERY STORY HERE HAPPENED OR WAS FIRST REPORTED ON FRIDAY 20 NOVEMBER 2026 - 43 STORIES - 13 ILLUSTRATED',
    W / 2, 1002, 1, INK,
  );

  const png = encodePNG(W, H, cv.buf);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
}

main();
