/*
 * make-icons.mjs — generates PNG app icons (192, 512, maskable 512) without
 * any image library: draws the droplet mark into an RGBA buffer with 2×
 * supersampling and writes PNGs via zlib.
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });

/* ---------- minimal PNG encoder ---------- */
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
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
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- drawing ---------- */
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));

// exact signed distance to a triangle (iq's formula)
function triangleSDF(px, py, p0, p1, p2) {
  const e0 = [p1[0] - p0[0], p1[1] - p0[1]];
  const e1 = [p2[0] - p1[0], p2[1] - p1[1]];
  const e2 = [p0[0] - p2[0], p0[1] - p2[1]];
  const v0 = [px - p0[0], py - p0[1]];
  const v1 = [px - p1[0], py - p1[1]];
  const v2 = [px - p2[0], py - p2[1]];
  const clamp01 = t => Math.max(0, Math.min(1, t));
  const proj = (v, e) => {
    const t = clamp01((v[0] * e[0] + v[1] * e[1]) / (e[0] * e[0] + e[1] * e[1]));
    return [v[0] - e[0] * t, v[1] - e[1] * t];
  };
  const q0 = proj(v0, e0), q1 = proj(v1, e1), q2 = proj(v2, e2);
  const d2 = Math.min(q0[0] ** 2 + q0[1] ** 2, q1[0] ** 2 + q1[1] ** 2, q2[0] ** 2 + q2[1] ** 2);
  const s = e0[0] * e2[1] - e0[1] * e2[0];
  const sgn = Math.min(
    s * (v0[0] * e0[1] - v0[1] * e0[0]),
    s * (v1[0] * e1[1] - v1[1] * e1[0]),
    s * (v2[0] * e2[1] - v2[1] * e2[0]),
  );
  return (sgn > 0 ? -1 : 1) * Math.sqrt(d2);
}

// droplet in unit space: circle centre (0.5, 0.605), r 0.242; apex (0.5, 0.155)
// = circle ∪ triangle(apex, two tangent points on the circle)
function dropletSDF(x, y) {
  const cx = 0.5, cy = 0.605, r = 0.242, ax = 0.5, ay = 0.155;
  const dCircle = Math.hypot(x - cx, y - cy) - r;
  const L = cy - ay;                       // apex to centre
  // tangent points: angle at centre between centre→apex and centre→tangent is acos(r/L)
  const beta = Math.acos(Math.min(1, r / L));
  const t1 = [cx + r * Math.sin(beta), cy - r * Math.cos(beta)];
  const t2 = [cx - r * Math.sin(beta), cy - r * Math.cos(beta)];
  const dTri = triangleSDF(x, y, [ax, ay], t1, t2);
  return Math.min(dCircle, dTri);
}

function render(size, { maskable }) {
  const SS = 2;
  const S = size * SS;
  const img = Buffer.alloc(size * size * 4);
  const bgTop = [14, 42, 74], bgBot = [6, 13, 24];
  const dropTop = [45, 212, 234], dropBot = [30, 111, 184];
  const cornerR = maskable ? 0 : S * 0.203;
  // maskable: shrink mark into the 80% safe zone
  const scale = maskable ? 0.72 : 0.92;
  const off = (1 - scale) / 2;

  const bubbles = [
    { x: 0.434, y: 0.586, r: 0.0332 },
    { x: 0.523, y: 0.484, r: 0.0234, a: 0.8 },
    { x: 0.473, y: 0.383, r: 0.0156, a: 0.6 },
  ];
  const strokeW = 0.0508; // ~26/512

  const px = new Float64Array(4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      px.fill(0);
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const X = x * SS + sx + 0.5, Y = y * SS + sy + 0.5;
          // rounded-rect mask
          const rx = Math.max(cornerR - X, X - (S - cornerR), 0);
          const ry = Math.max(cornerR - Y, Y - (S - cornerR), 0);
          if (cornerR > 0 && Math.hypot(rx, ry) > cornerR) continue; // transparent
          const u = X / S, v = Y / S;
          let c = mix(bgTop, bgBot, v);
          // mark coordinates
          const mu = (u - off) / scale, mv = (v - off) / scale;
          const d = dropletSDF(mu, mv);
          const t = mix(dropTop, dropBot, Math.min(1, Math.max(0, (mv - 0.15) / 0.7)));
          if (Math.abs(d) < strokeW / 2) c = t;
          for (const b of bubbles) {
            if (Math.hypot(mu - b.x, mv - b.y) < b.r) c = mix(c, dropTop, b.a ?? 1);
          }
          px[0] += c[0]; px[1] += c[1]; px[2] += c[2]; px[3] += 255;
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      img[i] = Math.round(px[0] / n);
      img[i + 1] = Math.round(px[1] / n);
      img[i + 2] = Math.round(px[2] / n);
      img[i + 3] = Math.round(px[3] / n);
    }
  }
  return encodePNG(img, size, size);
}

writeFileSync(join(outDir, 'icon-192.png'), render(192, { maskable: false }));
writeFileSync(join(outDir, 'icon-512.png'), render(512, { maskable: false }));
writeFileSync(join(outDir, 'icon-maskable-512.png'), render(512, { maskable: true }));
console.log('icons written to', outDir);
