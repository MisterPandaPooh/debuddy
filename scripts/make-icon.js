// Generates images/icon.png (128×128): a placebo capsule with a friendly face on a dark rounded tile.
// No dependencies: raw RGBA → zlib → PNG chunks.
const fs = require('fs');
const zlib = require('zlib');
const S = 128;
const px = new Float32Array(S * S * 4);
const put = (x, y, r, g, b, a = 1) => { if (x < 0 || y < 0 || x >= S || y >= S) return; const i = (y * S + x) * 4; px[i] = px[i] * (1 - a) + r * a; px[i + 1] = px[i + 1] * (1 - a) + g * a; px[i + 2] = px[i + 2] * (1 - a) + b * a; px[i + 3] = Math.max(px[i + 3], a * 255); };
const inRound = (x, y, x0, y0, w, h, rad) => { const cx = Math.max(x0 + rad, Math.min(x, x0 + w - rad)), cy = Math.max(y0 + rad, Math.min(y, y0 + h - rad)); return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad; };
// 4× supersampling for smooth edges
const SS = 4;
const shade = (X, Y) => {
  // tile
  if (!inRound(X, Y, 0, 0, S, S, 26)) return null;
  const t = Y / S;
  let c = [28 + 14 * t, 32 + 24 * t, 58 + 52 * t];
  // capsule: 84×40, tilted -30°, centred
  const cx = 64, cy = 62, ang = -Math.PI / 6;
  const dx = X - cx, dy = Y - cy;
  const u = dx * Math.cos(ang) + dy * Math.sin(ang), v = -dx * Math.sin(ang) + dy * Math.cos(ang);
  const W = 84, H = 40, R = H / 2;
  const inside = inRound(u + W / 2, v + H / 2, 0, 0, W, H, R);
  if (inside) {
    c = u < 0 ? [86, 212, 255] : [245, 247, 250];               // cyan half / white half
    if (Math.abs(u) < 1.2) c = [30, 34, 60];                       // seam
    // face on the white half: two eyes and a smile
    const ex = u - 21, ey = v;
    if ((ex + 7) ** 2 + (ey + 5) ** 2 <= 2.6 ** 2 || (ex - 7) ** 2 + (ey + 5) ** 2 <= 2.6 ** 2) c = [30, 34, 60];
    const sd = Math.hypot(ex, ey - 1);
    if (sd >= 9 && sd <= 11.5 && ey > 3) c = [30, 34, 60];
    // highlight on the cyan half
    if (u < -8 && v < -8 && (u + 26) ** 2 / 100 + (v + 11) ** 2 / 16 <= 1) c = [160, 232, 255];
  }
  // small "step" triangle bottom-right, the debugger hint
  const tx = X - 94, ty = Y - 96;
  if (tx >= 0 && tx <= 16 && Math.abs(ty - 8) <= 8 - tx * 0.5) c = [86, 212, 255];
  return c;
};
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
    if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
  }
  if (n) put(x, y, r / n, g / n, b / n, n / (SS * SS));
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; for (let x = 0; x < S; x++) for (let k = 0; k < 4; k++) raw[y * (S * 4 + 1) + 1 + x * 4 + k] = Math.round(px[(y * S + x) * 4 + k]); }
const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync('images', { recursive: true }); fs.writeFileSync('images/icon.png', png); console.log('images/icon.png', png.length, 'bytes');
