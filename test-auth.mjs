// 鉴权 + 限流 + 缓存头集成测试：NO_LISTEN=1 node test-auth.mjs
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 隔离数据目录（import server.js 前设置环境变量）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ltm-test-'))
process.env.DATA_DIR = tmpData
process.env.NO_LISTEN = '1'

const { default: app } = await import('./server.js').then(() => ({ default: null })).catch(() => ({ default: null }))

// server.js 没导出 app——用 http 起真实服务测试
const { spawn } = await import('node:child_process')
const PORT = 13333
const srv = spawn('node', ['server.js'], {
  // NO_LISTEN 置空：顶层 import 时避免占端口，但子进程必须真正监听
  env: { ...process.env, PORT: String(PORT), NO_LISTEN: '', DATA_DIR: tmpData, ASR_API_KEY: 'x', DEEPSEEK_API_KEY: 'x' },
  stdio: 'pipe',
})
srv.stderr.on('data', d => process.stderr.write('[srv] ' + d))
// 等服务就绪（最多 15 秒）
const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 75; i++) {
  try { await fetch(`${base}/api/accounts?group=`); break } catch { await new Promise(r => setTimeout(r, 200)) }
  if (i === 74) { console.error('服务启动超时'); srv.kill(); process.exit(1) }
}
const results = []
const check = (name, cond) => { results.push([name, cond]); if (!cond) console.error('FAIL:', name) }

// --- 鉴权 ---
const accId = '1757000000001'  // 合法格式的时间戳 id
const secret = 'a'.repeat(32)

// 1. 无密钥创建 -> 403
let r = await fetch(`${base}/api/accounts`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account: { id: accId, name: '测试' }, records: [] }),
})
check('POST 无密钥创建被拒 403', r.status === 403)

// 2. 带密钥创建 -> ok + 下发密钥
r = await fetch(`${base}/api/accounts`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Secret': secret },
  body: JSON.stringify({ account: { id: accId, name: '测试' }, records: [{ id: 1, report: { totalScore: 80 } }] }),
})
check('POST 带密钥创建成功', r.status === 200)
let j = await r.json()
check('首次创建不下发 secret（客户端自带）', !j.secret || j.secret === secret)

// 3. 无密钥读取 -> 403
r = await fetch(`${base}/api/accounts/${accId}`)
check('GET 无密钥读取被拒 403', r.status === 403)

// 4. 错误密钥读取 -> 403
r = await fetch(`${base}/api/accounts/${accId}`, { headers: { 'X-Account-Secret': 'b'.repeat(32) } })
check('GET 错误密钥被拒 403', r.status === 403)

// 5. 正确密钥读取 -> ok
r = await fetch(`${base}/api/accounts/${accId}`, { headers: { 'X-Account-Secret': secret } })
check('GET 正确密钥可读', r.status === 200)
j = await r.json()
check('GET 返回记录', j.records?.length === 1)

// 6. 无密钥删除 -> 403
r = await fetch(`${base}/api/accounts/${accId}`, { method: 'DELETE' })
check('DELETE 无密钥被拒 403', r.status === 403)

// 7. 密钥删除 -> ok
r = await fetch(`${base}/api/accounts/${accId}`, { method: 'DELETE', headers: { 'X-Account-Secret': secret } })
check('DELETE 带密钥成功', r.status === 200)

// 8. 已删除账号 GET -> 404
r = await fetch(`${base}/api/accounts/${accId}`, { headers: { 'X-Account-Secret': secret } })
check('已删账号 GET 404', r.status === 404)

// --- mimetype 白名单（须在限流循环前测，否则配额已耗尽只会收到 429） ---
const fd2 = new FormData()
fd2.append('audio', new Blob([Buffer.from('MZ' + 'x'.repeat(100))], { type: 'application/x-msdownload' }), 'evil.exe')
r = await fetch(`${base}/api/transcribe`, { method: 'POST', body: fd2 })
check('非音频 mimetype 被拒', r.status === 415)

// --- 限流（transcribe 30/min） ---
let hit429 = false
for (let i = 0; i < 35; i++) {
  const fd = new FormData()
  fd.append('audio', new Blob([Buffer.alloc(100)], { type: 'audio/wav' }), 'a.wav')
  const rr = await fetch(`${base}/api/transcribe`, { method: 'POST', body: fd })
  if (rr.status === 429) { hit429 = true; break }
}
check('transcribe 限流 429', hit429)

// --- 缓存头：JS/CSS 短缓存（会改版），图标长缓存 ---
r = await fetch(`${base}/app.js`)
check('app.js 短缓存', (r.headers.get('cache-control') || '').includes('3600'))
r = await fetch(`${base}/style.css`)
check('style.css 短缓存', (r.headers.get('cache-control') || '').includes('3600'))
r = await fetch(`${base}/icon-512.png`)
check('图标长缓存 immutable', (r.headers.get('cache-control') || '').includes('immutable'))

srv.kill()
const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) { console.error('失败项:', failed.map(([n]) => n)); process.exit(1) }
console.log('ALL AUTH/RATELIMIT TESTS PASSED')
fs.rmSync(tmpData, { recursive: true, force: true })
process.exit(0)
