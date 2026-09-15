// 生成 PWA 图标：node scripts/make-icons.mjs（零依赖，纯 Buffer 写 PNG）
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = buf => {
  let c = 0xFFFFFFFF
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
const makePng = (size, draw) => {
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b, a] = draw(x / size, y / size)
    const o = (y * size + x) * 4
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a
  }
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

// 靛蓝底 + 白色声纹波形条（maskable 安全区：内容收在中央 80%）
const BARS = [0.3, 0.55, 0.8, 1, 0.8, 0.55, 0.3]
const draw = (u, v) => {
  const n = BARS.length, bw = 0.075, gap = 0.04
  const total = n * bw + (n - 1) * gap
  const i = Math.floor((u - (0.5 - total / 2)) / (bw + gap))
  if (i >= 0 && i < n) {
    const barL = 0.5 - total / 2 + i * (bw + gap)
    if (u >= barL && u <= barL + bw && Math.abs(v - 0.5) <= (BARS[i] * 0.62) / 2) return [255, 255, 255, 255]
  }
  return [0x63, 0x66, 0xf1, 255]
}

const out = p => path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'public', p)
for (const size of [192, 512]) {
  fs.writeFileSync(out(`icon-${size}.png`), makePng(size, draw))
  console.log(`icon-${size}.png written`)
}
