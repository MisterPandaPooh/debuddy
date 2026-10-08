// Turns a generated logo (BMP from `sips`) into images/icon.png: white margins → transparent,
// cropped to the tile, box-downscaled to 256×256. No dependencies.
const fs = require('fs'); const zlib = require('zlib');
const [, , input, output = 'images/icon.png', sizeArg = '256'] = process.argv;
const OUT = Number(sizeArg);
const bmp = fs.readFileSync(input);
const off = bmp.readUInt32LE(10), W = bmp.readInt32LE(18), Hraw = bmp.readInt32LE(22), bpp = bmp.readUInt16LE(28);
const H = Math.abs(Hraw), bottomUp = Hraw > 0, stride = Math.floor((W * bpp + 31) / 32) * 4;
const get = (x, y) => { const row = bottomUp ? H - 1 - y : y; const i = off + row * stride + x * (bpp / 8); return [bmp[i + 2], bmp[i + 1], bmp[i], bpp === 32 ? bmp[i + 3] : 255]; };
// alpha: flood-fill near-white from the corners (the generator's margin), everything else opaque
const alpha = new Uint8Array(W * H).fill(255);
const isMargin = (x, y) => { const [r, g, b] = get(x, y); return r > 235 && g > 235 && b > 235; };
const stack = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
const seen = new Uint8Array(W * H);
while (stack.length) { const [x, y] = stack.pop(); if (x < 0 || y < 0 || x >= W || y >= H || seen[y * W + x]) continue; seen[y * W + x] = 1; if (!isMargin(x, y)) continue; alpha[y * W + x] = 0; stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]); }
// soften the edge: pixels adjacent to margin get partial alpha from their brightness
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (alpha[y * W + x] === 255 && (alpha[y * W + x - 1] === 0 || alpha[y * W + x + 1] === 0 || alpha[(y - 1) * W + x] === 0 || alpha[(y + 1) * W + x] === 0)) { const [r, g, b] = get(x, y); alpha[y * W + x] = Math.max(0, Math.min(255, Math.round(255 - (r + g + b) / 3))); }
// crop to the opaque bounding box, keep square
let x0 = W, y0 = H, x1 = 0, y1 = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha[y * W + x] > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
const side = Math.max(x1 - x0, y1 - y0) + 1, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
const sx = Math.round(cx - side / 2), sy = Math.round(cy - side / 2);
// box downscale
const out = Buffer.alloc((OUT * 4 + 1) * OUT);
const scale = side / OUT;
for (let oy = 0; oy < OUT; oy++) { out[oy * (OUT * 4 + 1)] = 0; for (let ox = 0; ox < OUT; ox++) {
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let yy = Math.floor(oy * scale); yy < Math.floor((oy + 1) * scale); yy++) for (let xx = Math.floor(ox * scale); xx < Math.floor((ox + 1) * scale); xx++) {
    const X = sx + xx, Y = sy + yy; n++; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    const al = alpha[Y * W + X] / 255; const [pr, pg, pb] = get(X, Y); r += pr * al; g += pg * al; b += pb * al; a += al;
  }
  const o = oy * (OUT * 4 + 1) + 1 + ox * 4;
  if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
  out[o + 3] = Math.round((a / n) * 255);
} }
const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(output, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${output}: ${OUT}×${OUT}, tile ${side}px from (${sx},${sy}) of ${W}×${H}`);
