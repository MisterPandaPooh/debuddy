// Generates images/icon.png (128×128): a rounded dark tile with a play glyph and a comment bubble.
// No dependencies: raw RGBA → zlib → PNG chunks.
const fs = require('fs');
const zlib = require('zlib');
const S = 128;
const px = new Uint8Array(S * S * 4);
const put = (x, y, r, g, b, a = 255) => { if (x < 0 || y < 0 || x >= S || y >= S) return; const i = (y * S + x) * 4; const al = a / 255; px[i] = px[i] * (1 - al) + r * al; px[i + 1] = px[i + 1] * (1 - al) + g * al; px[i + 2] = px[i + 2] * (1 - al) + b * al; px[i + 3] = Math.max(px[i + 3], a); };
const inRound = (x, y, x0, y0, w, h, rad) => { const cx = Math.max(x0 + rad, Math.min(x, x0 + w - rad)), cy = Math.max(y0 + rad, Math.min(y, y0 + h - rad)); return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad; };
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  if (inRound(x + 0.5, y + 0.5, 0, 0, S, S, 24)) { const t = y / S; put(x, y, 30 + 20 * t, 34 + 30 * t, 60 + 60 * t); }
}
// play glyph (the debugger), cyan
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const X = x - 34, Y = y - 40; if (X >= 0 && X <= 40 && Math.abs(Y - 24) <= 24 - X * 0.6) put(x, y, 86, 212, 255);
}
// comment bubble (the explanation), white, bottom-right
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  if (inRound(x + 0.5, y + 0.5, 62, 70, 50, 32, 10)) put(x, y, 245, 247, 250);
  const X = x - 74, Y = y - 101; if (X >= 0 && X <= 10 && Y >= 0 && Y <= 10 - X) put(x, y, 245, 247, 250);
}
for (const [yy, w] of [[80, 30], [88, 22]]) for (let x = 72; x < 72 + w; x++) for (let y = yy; y < yy + 3; y++) put(x, y, 60, 70, 110);
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1); }
const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync('images', { recursive: true }); fs.writeFileSync('images/icon.png', png); console.log('images/icon.png', png.length, 'bytes');
