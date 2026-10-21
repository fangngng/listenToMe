// 下载 Fluent Emoji 3D PNG 到 public/emoji/：node scripts/fetch-emoji.mjs
// 来源 microsoft/fluentui-emoji（MIT），经 raw.githubusercontent.com（jsDelivr 被墙）
// 3D 风格官方只提供 PNG；每个 URL 重试 3 次（raw 偶发超时）
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.join(process.cwd(), 'public', 'emoji')
fs.mkdirSync(OUT, { recursive: true })

// [文件名 slug, 候选目录名（fluentui-emoji assets 下的文件夹）]
const ICONS = [
  ['cloud', 'Cloud'],
  ['crossed-swords', 'Crossed swords'],
  ['speaking-head', 'Speaking head'],
  ['trophy', 'Trophy'],
  ['headphone', 'Headphone'],
  ['up-arrow', 'Up arrow'],
  ['down-arrow', 'Down arrow'],
  ['right-arrow', 'Right arrow'],
  ['shuffle-tracks', 'Shuffle tracks button'],
  ['books', 'Books'],
  ['thumbs-up', 'Thumbs up/Default'],
  ['direct-hit', 'Bullseye'],
  ['studio-microphone', 'Studio microphone'],
  ['brain', 'Brain'],
  ['handshake', 'Handshake'],
  ['triangular-flag', 'Triangular flag'],
  ['grinning-face-with-sweat', 'Grinning face with sweat'],
  ['nine-oclock', 'Nine oclock'],
  ['fire', 'Fire'],
  ['outbox-tray', 'Outbox tray'],
  ['memo', 'Memo'],
  ['scroll', 'Scroll'],
  ['chart-increasing', 'Chart increasing'],
  ['file-folder', 'File folder'],
  ['dashing-away', 'Dashing away'],
  ['bust-in-silhouette', 'Bust in silhouette'],
  ['crown', 'Crown'],
  ['rabbit-face', 'Rabbit face'],
  ['turtle', 'Turtle'],
  ['party-popper', 'Party popper'],
  ['globe-with-meridians', 'Globe with meridians'],
  ['plus', 'Plus'],
  ['cross-mark', 'Cross mark'],
  ['sparkles', 'Sparkles'],
  ['pencil', 'Pencil'],
  ['check-mark-button', 'Check mark button'],
  ['warning', 'Warning'],
  ['scale', 'Scale', 'Balance scale'],
  ['stop-button', 'Stop button'],
  ['stopwatch', 'Stopwatch'],
  ['pause-button', 'Pause button'],
]

// 个别图标官方文件名不符合 <dir>_3d.png 规律
const FILE_OVERRIDES = { 'thumbs-up': 'thumbs_up_3d_default.png' }

const base = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/'
const fileName = (slug, dir) => FILE_OVERRIDES[slug] || dir.toLowerCase().replace(/ /g, '_') + '_3d.png'

let ok = 0
const failed = []
for (const [slug, ...dirs] of ICONS) {
  const file = path.join(OUT, `${slug}.png`)
  if (fs.existsSync(file) && fs.statSync(file).size > 500) { ok++; continue }
  let done = false
  for (const dir of dirs) {
    const url = base + encodeURIComponent(dir) + '/3D/' + encodeURIComponent(fileName(slug, dir))
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), 20000)
        const r = await fetch(url, { signal: ctl.signal })
        clearTimeout(t)
        if (!r.ok) break  // 404：换目录候选，重试无意义
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length < 500 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) continue
        fs.writeFileSync(file, buf)
        done = true
      } catch {
        await new Promise(r2 => setTimeout(r2, 800 * (attempt + 1)))
      }
    }
    if (done) break
  }
  if (done) ok++
  else failed.push(slug)
}
console.log(`emoji: ${ok}/${ICONS.length} 就绪` + (failed.length ? `，失败：${failed.join(',')}` : ''))
process.exit(failed.length ? 1 : 0)
