// A rectangle of a PNG as a new PNG, with zlib only: the screenshots of Chromium (8 bits, RGB or RGBA, not
// interlaced). The part of a screenshot shown to the model that looks at it afterwards (see.mjs).
//   node crop.mjs in.png out.png x y width height
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export function crop(png, x, y, width, height) {
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const size = png.readUInt32BE(at);
    chunks.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + size) });
    at += size + 12;
  }
  const head = chunks.find(c => c.type === 'IHDR').data;
  const W = head.readUInt32BE(0), H = head.readUInt32BE(4), bpp = { 2: 3, 6: 4 }[head[9]];
  if (head[8] !== 8 || !bpp || head[12]) throw new Error('not an 8-bit RGB or RGBA png');
  x = Math.max(0, Math.min(Math.round(x), W - 1)), y = Math.max(0, Math.min(Math.round(y), H - 1));
  width = Math.min(Math.round(width), W - x), height = Math.min(Math.round(height), H - y);
  const raw = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  const stride = W * bpp, out = Buffer.alloc(height * (width * bpp + 1));
  let before = Buffer.alloc(stride);
  for (let row = 0; row < y + height; row++) {
    const filter = raw[row * (stride + 1)], line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = before[i], c = i >= bpp ? before[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[i] += [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
    }
    // each output row keeps filter 0 (its first byte, already zero)
    if (row >= y) line.copy(out, (row - y) * (width * bpp + 1) + 1, x * bpp, (x + width) * bpp);
    before = line;
  }
  const newHead = Buffer.from(head);
  newHead.writeUInt32BE(width, 0), newHead.writeUInt32BE(height, 4);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), frame = Buffer.alloc(8);
    frame.writeUInt32BE(data.length, 0), frame.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([frame.subarray(0, 4), body, frame.subarray(4)]);
  };
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', newHead), chunk('IDAT', deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
}

if (process.argv[1] === import.meta.filename) {
  const [from, to, ...rect] = process.argv.slice(2);
  writeFileSync(to, crop(readFileSync(from), ...rect.map(Number)));
}
