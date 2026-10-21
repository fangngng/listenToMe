// 讯飞 ISE 发音检查集成测试（真实接口）：先启动服务 npm start，再 node test-pronounce.mjs
// 用正弦波音频验证协议全链路（签名/帧/结果解析）；静音类音频预期 rejected 或低分，均为协议成功
const WAV_SEC = 2
const rate = 16000
const n = rate * WAV_SEC
const pcm = Buffer.alloc(n * 2)
for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), i * 2)
const header = Buffer.alloc(44)
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
const wav = Buffer.concat([header, pcm])

for (const [lang, ref] of [['zh', '今天天气怎么样。'], ['en', '[unused]'], ['en', 'The sun rises in the east.']]) {
  if (ref === '[unused]') continue
  const fd = new FormData()
  fd.append('audio', new Blob([wav], { type: 'audio/wav' }), 't.wav')
  fd.append('refText', ref)
  fd.append('lang', lang)
  const r = await fetch('http://localhost:3000/api/pronounce', { method: 'POST', body: fd })
  const d = await r.json()
  console.log(lang, '->', r.status, JSON.stringify(d).slice(0, 400))
}
