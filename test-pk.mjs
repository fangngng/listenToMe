// 云端 PK 集成测试：node test-pk.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ltm-pk-'))
const PORT = 13334
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), NO_LISTEN: '', DATA_DIR: path.join(tmpData, 'accounts'), ASR_API_KEY: 'x', DEEPSEEK_API_KEY: 'x' },
  stdio: 'pipe',
})
srv.stderr.on('data', d => process.stderr.write('[srv] ' + d))
const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 75; i++) {
  try { await fetch(`${base}/api/accounts?group=`); break } catch { await new Promise(r => setTimeout(r, 200)) }
  if (i === 74) { console.error('服务启动超时'); srv.kill(); process.exit(1) }
}

const results = []
const check = (name, cond) => { results.push([name, cond]); if (!cond) console.error('FAIL:', name) }
const json = (method, url, body, secret) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Account-Secret': secret } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }))

const mkRecord = (id, score) => ({
  id, date: new Date().toISOString(), mode: 'read', modeLabel: '朗读练习',
  durationSec: 60, totalScore: score, summary: '测试记录 ' + score,
  report: { totalScore: score, summary: 'x', dimensions: [{ name: '准确度', score }, { name: '流利度', score: score - 5 }], strengths: [], weaknesses: [], overallAdvice: '' },
})

const secA = 'a'.repeat(32)
const secB = 'b'.repeat(32)
const accA = '1757000000101'
const accB = '1757000000102'

// 两个账号入云（同组 pk-test），各带一条记录
let r = await json('POST', '/api/accounts', { account: { id: accA, name: '甲' }, group: 'pk-test', records: [mkRecord(1001, 88)] }, secA)
check('创建账号甲', r.status === 200 && r.data.ok)
r = await json('POST', '/api/accounts', { account: { id: accB, name: '乙' }, group: 'pk-test', records: [mkRecord(2001, 92)] }, secB)
check('创建账号乙', r.status === 200 && r.data.ok)

// 未同步账号发起 -> 404
r = await json('POST', '/api/pk', { accountId: '1757000000199', recordId: 1 }, 'c'.repeat(32))
check('无云端账号发起被拒', r.status === 404)

// 甲发起（记录不存在 -> 404；存在 -> ok）
r = await json('POST', '/api/pk', { accountId: accA, recordId: 9999 }, secA)
check('记录不存在被拒', r.status === 404)
r = await json('POST', '/api/pk', { accountId: accA, recordId: 1001 }, secA)
check('甲发起 PK', r.status === 200 && r.data.pk?.status === 'open')
const pkId = r.data.pk.id
check('快照含分数与维度', r.data.pk.challenger.totalScore === 88 && r.data.pk.challenger.dims.length === 2)

// 密钥错误 -> 403
r = await json('POST', '/api/pk', { accountId: accA, recordId: 1001 }, 'z'.repeat(32))
check('错误密钥发起被拒', r.status === 403)

// 组内列表可见；别的组不可见
r = await json('GET', '/api/pks?group=pk-test')
check('同组可见对局', r.status === 200 && r.data.pks.length === 1)
r = await json('GET', '/api/pks?group=other')
check('异组不可见', r.data.pks.length === 0)

// 自己应战自己 -> 400
r = await json('POST', `/api/pk/${pkId}/accept`, { accountId: accA, recordId: 1001 }, secA)
check('不能应战自己', r.status === 400)

// 异组账号应战 -> 403
const secC = 'c'.repeat(32)
const accC = '1757000000103'
await json('POST', '/api/accounts', { account: { id: accC, name: '丙' }, group: 'other-group', records: [mkRecord(3001, 95)] }, secC)
r = await json('POST', `/api/pk/${pkId}/accept`, { accountId: accC, recordId: 3001 }, secC)
check('异组应战被拒', r.status === 403)

// 乙应战（92 > 88 -> 乙胜）
r = await json('POST', `/api/pk/${pkId}/accept`, { accountId: accB, recordId: 2001 }, secB)
check('乙应战成功', r.status === 200 && r.data.pk?.status === 'done')
check('乙胜出', r.data.pk.winner === 'opponent' && r.data.pk.opponent.totalScore === 92)

// 已结束再应战 -> 409
r = await json('POST', `/api/pk/${pkId}/accept`, { accountId: accB, recordId: 2001 }, secB)
check('重复应战被拒', r.status === 409)

// 详情
r = await json('GET', `/api/pk/${pkId}`)
check('对局详情', r.status === 200 && r.data.pk.id === pkId)

// 取消流程：甲再发起一场后取消
r = await json('POST', '/api/pk', { accountId: accA, recordId: 1001 }, secA)
const pk2 = r.data.pk.id
r = await json('POST', `/api/pk/${pk2}/cancel`, { accountId: accB }, secB)
check('非发起人取消被拒', r.status === 403)
r = await json('POST', `/api/pk/${pk2}/cancel`, { accountId: accA }, secA)
check('发起人取消成功', r.status === 200 && r.data.ok)
r = await json('GET', `/api/pk/${pk2}`)
check('取消后不存在', r.status === 404)

// 平局判定
await json('POST', '/api/accounts', { account: { id: accA, name: '甲' }, group: 'pk-test', records: [mkRecord(1001, 88), mkRecord(1002, 92)] }, secA)
r = await json('POST', '/api/pk', { accountId: accA, recordId: 1002 }, secA)
const pk3 = r.data.pk.id
r = await json('POST', `/api/pk/${pk3}/accept`, { accountId: accB, recordId: 2001 }, secB)
check('同分判平局', r.data.pk.winner === 'draw')

srv.kill()
const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
fs.rmSync(tmpData, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
