/*
 * Generates the extension's toolbar/store icons with no image dependencies.
 *
 *   node extensions/apify-analytics-plus/scripts/gen-icons.mjs
 *
 * Draws three white ascending bars on a rounded-rect blue→teal gradient
 * (distinct from apify-power-tools' purple→pink bolt so the two extensions
 * are easy to tell apart in the toolbar), rendered fresh at each target size
 * with 4x supersampling, then hand-encoded to PNG via zlib.
 * Writes src/icons/icon{16,48,128}.png.
 */
import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "icons");

// Brand gradient endpoints (top-left → bottom-right).
const C0 = [37, 99, 235]; // #2563eb
const C1 = [45, 212, 191]; // #2dd4bf

// Three ascending bars, each a rect [x0, y0, x1, y1] in a normalized 0..1 box.
const BARS = [
  [0.22, 0.6, 0.38, 0.82],
  [0.44, 0.42, 0.6, 0.82],
  [0.66, 0.2, 0.82, 0.82],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function inAnyBar(x, y, bars) {
  for (const [x0, y0, x1, y1] of bars) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  }
  return false;
}

// Inside a rounded rectangle [0,1]² with corner radius r (normalized)?
function inRoundedRect(x, y, r) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = x < r ? r : x > 1 - r ? 1 - r : x;
  const cy = y < r ? r : y > 1 - r ? 1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Render an RGBA buffer of `size` px, supersampled `ss`x then box-downsampled.
function render(size, ss = 4) {
  const S = size * ss;
  const radius = 0.22;
  const hi = new Uint8ClampedArray(S * S * 4);
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const nx = (px + 0.5) / S;
      const ny = (py + 0.5) / S;
      const o = (py * S + px) * 4;
      if (!inRoundedRect(nx, ny, radius)) {
        hi[o + 3] = 0;
        continue;
      }
      const t = (nx + ny) / 2;
      if (inAnyBar(nx, ny, BARS)) {
        hi[o] = 255;
        hi[o + 1] = 255;
        hi[o + 2] = 255;
      } else {
        hi[o] = lerp(C0[0], C1[0], t);
        hi[o + 1] = lerp(C0[1], C1[1], t);
        hi[o + 2] = lerp(C0[2], C1[2], t);
      }
      hi[o + 3] = 255;
    }
  }
  // Downsample ssxss → 1 (averaging, premultiplied alpha for clean edges).
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const o = ((y * ss + dy) * S + (x * ss + dx)) * 4;
          const af = hi[o + 3] / 255;
          r += hi[o] * af;
          g += hi[o + 1] * af;
          b += hi[o + 2] * af;
          a += hi[o + 3];
        }
      }
      const n = ss * ss;
      const aAvg = a / n;
      const o = (y * size + x) * 4;
      if (aAvg === 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        const wf = a / 255; // sum of alpha fractions
        out[o] = r / wf;
        out[o + 1] = g / wf;
        out[o + 2] = b / wf;
        out[o + 3] = aAvg;
      }
    }
  }
  return out;
}

// --- minimal PNG encoder (RGBA, no interlace) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePng(render(size), size);
  await writeFile(join(outDir, `icon${size}.png`), png);
  console.log(`✓ icon${size}.png (${png.length} bytes)`);
}
