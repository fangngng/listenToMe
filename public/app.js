/* ListenToMe 前端：录音/上传 -> 转写 -> 点评 -> 报告/历史 */

const $ = id => document.getElementById(id)

const MODES = {
  read: { label: '朗读练习', desc: '对照参考文本朗读，检查错读/漏读/多读、准确度与流利度' },
  speech: { label: '演讲练习', desc: '自由演讲或脱稿发言，分析结构逻辑、口头禅、语速与感染力' },
  general: { label: '泛用点评', desc: '不依赖文本的综合点评：表达清晰度、语言习惯、亮点与短板' },
}
const STATUS_TEXT = {
  upload: '正在上传音频…',
  transcribe: '正在转写语音（约需 10-40 秒）…',
  analyze: 'AI 教练正在聆听与点评…',
}
const MAX_REC_SEC = 600
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const SAMPLE_RATE = 16000

// ---------- 状态 ----------
const DB_NAME = 'listenToMe', STORE = 'records', ACCOUNTS = 'accounts'
const ACTIVE_KEY = 'listentome:activeAccount'

let mode = 'read'
let audioBlob = null
let audioURL = null
let metrics = null
let currentReport = null

// 录音运行时
let recording = false
let mediaStream = null
let audioCtx = null
let workletNode = null
let pcmChunks = []
let recStart = 0
let timerId = null
let levelHistory = []

// =========================================================
// 模式切换
// =========================================================
const modeTabs = document.querySelectorAll('.mode-tab')
function setMode(m) {
  mode = m
  modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === m))
  $('modeDesc').textContent = MODES[m].desc
  $('refWrap').classList.toggle('hidden', m !== 'read')
  $('topicWrap').classList.toggle('hidden', m !== 'speech')
}
modeTabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)))
setMode('read')

$('refText').addEventListener('input', e => {
  const n = e.target.value.replace(/\s/g, '').length
  $('refCount').textContent = `${n} 字`
})

// =========================================================
// 录音
// =========================================================
const recordBtn = $('recordBtn')
recordBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()))

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
  } catch (e) {
    showError('无法访问麦克风：' + e.message + '\n请检查浏览器权限（需 https 或 localhost 环境）')
    return
  }

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
  await audioCtx.audioWorklet.addModule('pcm-worklet.js')
  const src = audioCtx.createMediaStreamSource(mediaStream)
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture')
  workletNode.port.onmessage = e => {
    pcmChunks.push(new Float32Array(e.data))
    const rms = calcRms(e.data)
    levelHistory.push(rms)
    if (levelHistory.length > 300) levelHistory.shift()
    drawWave()
  }
  src.connect(workletNode) // 不连 destination，避免回声

  recording = true
  pcmChunks = []
  levelHistory = []
  recStart = Date.now()
  recordBtn.textContent = '⏹️ 停止录音'
  recordBtn.classList.add('recording')
  $('recTimer').classList.remove('muted')
  hideError()
  timerId = setInterval(updateTimer, 200)
  updateTimer()
}

function updateTimer() {
  const sec = Math.floor((Date.now() - recStart) / 1000)
  $('recTimer').textContent = fmtTime(sec)
  if (sec >= MAX_REC_SEC) stopRecording()
}

async function stopRecording() {
  if (!recording) return
  recording = false
  clearInterval(timerId)

  try { workletNode.port.onmessage = null } catch {}
  mediaStream.getTracks().forEach(t => t.stop())
  try { await audioCtx.close() } catch {}
  recordBtn.textContent = '🎙️ 开始录音'
  recordBtn.classList.remove('recording')

  const pcm = mergeChunks(pcmChunks)
  if (pcm.length < SAMPLE_RATE) { // 少于 1 秒
    showError('录音太短（不足 1 秒），请重新录制')
    resetReady()
    return
  }
  metrics = computeMetrics(pcm, SAMPLE_RATE)
  setAudio(new Blob([encodeWav(pcm)], { type: 'audio/wav' }), 'audio.wav')
}

function calcRms(buf) {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

function mergeChunks(chunks) {
  let total = 0
  chunks.forEach(c => (total += c.length))
  const out = new Float32Array(total)
  let o = 0
  chunks.forEach(c => { out.set(c, o); o += c.length })
  return out
}

/** 静音检测：估计说话时长、停顿次数与最长停顿 */
function computeMetrics(pcm, sr) {
  const win = Math.floor(sr * 0.1) // 100ms 窗口
  const nWin = Math.floor(pcm.length / win)
  if (!nWin) return { durationSec: pcm.length / sr, speechSec: null, pauseCount: null, longestPauseSec: null }

  const rms = new Array(nWin)
  for (let w = 0; w < nWin; w++) {
    let s = 0
    const off = w * win
    for (let i = 0; i < win; i++) s += pcm[off + i] * pcm[off + i]
    rms[w] = Math.sqrt(s / win)
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const p80 = sorted[Math.floor(nWin * 0.8)] || 0.01
  const threshold = Math.max(0.006, p80 * 0.15)

  let pauseCount = 0, pauseTotal = 0, curPause = 0, longest = 0
  for (let w = 0; w < nWin; w++) {
    if (rms[w] < threshold) {
      curPause += 0.1
      longest = Math.max(longest, curPause)
    } else {
      if (curPause >= 0.6) { pauseCount++; pauseTotal += curPause }
      curPause = 0
    }
  }
  if (curPause >= 0.6) { pauseCount++; pauseTotal += curPause }

  const durationSec = pcm.length / sr
  return {
    durationSec: +durationSec.toFixed(1),
    speechSec: +Math.max(0.1, durationSec - pauseTotal).toFixed(1),
    pauseCount,
    longestPauseSec: +longest.toFixed(1),
  }
}

function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  wstr(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); wstr(8, 'WAVE')
  wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  wstr(36, 'data'); v.setUint32(40, samples.length * 2, true)
  let o = 44
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

// 波形显示（录音中画电平，就绪后画静态摘要）
const waveCtx = $('wave').getContext('2d')
function drawWave() {
  const c = waveCtx.canvas
  waveCtx.clearRect(0, 0, c.width, c.height)
  const mid = c.height / 2
  const barW = 4, gap = 2
  const count = Math.floor(c.width / (barW + gap))
  const data = levelHistory.slice(-count)
  waveCtx.fillStyle = '#6366f1'
  for (let i = 0; i < data.length; i++) {
    const h = Math.max(2, Math.min(1, data[i] * 4) * (c.height - 10))
    waveCtx.fillRect(i * (barW + gap), mid - h / 2, barW, h)
  }
}
drawWave()

// =========================================================
// 上传文件
// =========================================================
$('fileInput').addEventListener('change', e => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  if (file.size > MAX_UPLOAD_BYTES) {
    showError(`文件超过 25MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB），请剪辑后再上传`)
    return
  }
  // 读取时长
  const probe = new Audio()
  probe.preload = 'metadata'
  probe.src = URL.createObjectURL(file)
  probe.onloadedmetadata = () => {
    const dur = isFinite(probe.duration) ? probe.duration : 0
    URL.revokeObjectURL(probe.src)
    metrics = { durationSec: +dur.toFixed(1), speechSec: null, pauseCount: null, longestPauseSec: null }
    setAudio(file, file.name)
  }
  probe.onerror = () => {
    URL.revokeObjectURL(probe.src)
    metrics = { durationSec: 0, speechSec: null, pauseCount: null, longestPauseSec: null }
    setAudio(file, file.name)
  }
})

// =========================================================
// 就绪 / 分析
// =========================================================
function setAudio(blob, name) {
  resetAudioURL()
  audioBlob = blob
  audioURL = URL.createObjectURL(blob)
  $('previewAudio').src = audioURL
  $('readyPanel').classList.remove('hidden')
  $('reportCard').classList.add('hidden')
  hideError()
  levelHistory = []
  drawWave()
}

function resetReady() {
  resetAudioURL()
  audioBlob = null
  metrics = null
  $('readyPanel').classList.add('hidden')
  $('previewAudio').removeAttribute('src')  // 停掉可能在播的回放
  levelHistory = []
  drawWave()
}

function resetAudioURL() {
  if (audioURL) { URL.revokeObjectURL(audioURL); audioURL = null }
}

$('reRecordBtn').addEventListener('click', resetReady)

$('analyzeBtn').addEventListener('click', analyze)

async function analyze() {
  if (!audioBlob) return
  if (!activeAccountId) {
    showError('请先在左侧创建账号，评测会保存到当前账号下')
    return
  }
  if (mode === 'read' && !$('refText').value.trim()) {
    showError('朗读模式需要先粘贴参考文本，或切换到演讲/泛用模式')
    return
  }
  const analyzeBtn = $('analyzeBtn')
  analyzeBtn.disabled = true
  $('readyPanel').classList.add('hidden')
  hideError()

  try {
    setStatus('upload')
    const fd = new FormData()
    fd.append('audio', audioBlob, audioBlob.name || 'audio.wav')
    fd.append('duration', metrics?.durationSec || 0)

    const r1 = await fetch('api/transcribe', { method: 'POST', body: fd })
    const transcript = await r1.json()
    if (!r1.ok) throw new Error(transcript.error || '转写失败')

    setStatus('transcribe')
    await sleep(80) // 让状态文案渲染出来
    setStatus('analyze')
    const r2 = await fetch('api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        refText: $('refText').value,
        topic: $('topicInput').value,
        transcript,
        metrics: metrics || {},
      }),
    })
    const data = await r2.json()
    if (!r2.ok) throw new Error(data.error || '分析失败')

    currentReport = data.report
    renderReport(data.report)
    await saveHistory(data.report)
  } catch (e) {
    showError(e.message || String(e))
  } finally {
    clearStatus()
    analyzeBtn.disabled = false
    if (audioBlob) $('readyPanel').classList.remove('hidden')
  }
}

function setStatus(key) {
  $('statusLine').classList.remove('hidden')
  $('statusText').textContent = STATUS_TEXT[key] || '处理中…'
}
function clearStatus() { $('statusLine').classList.add('hidden') }
function showError(msg) {
  $('errorBox').textContent = msg
  $('errorBox').classList.remove('hidden')
}
function hideError() { $('errorBox').classList.add('hidden') }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// =========================================================
// 报告渲染
// =========================================================
const STATUS_LABEL = { correct: '✅ 读对', wrong: '❌ 读错', missed: '⚠️ 漏读', extra: '➕ 多读' }

function renderReport(report) {
  currentReport = report
  $('reportCard').classList.remove('hidden')
  $('reportTitle').textContent = `${report.modeLabel}点评报告`

  const body = $('reportBody')
  const els = []

  // 总览
  const cpm = report.metrics?.speechSec
    ? Math.round((report.sentences.reduce((a, s) => a + s.text.replace(/\s/g, '').length, 0) / report.metrics.speechSec) * 60)
    : null
  const chips = [
    report.metrics?.durationSec ? `⏱ 时长 ${fmtTime(report.metrics.durationSec)}` : null,
    cpm ? `💨 语速 ~${cpm} 字/分` : null,
    report.metrics?.pauseCount != null ? `⏸ 停顿 ${report.metrics.pauseCount} 次` : null,
    report.fillers?.length ? `🗣 口头禅 ${report.fillers.reduce((a, f) => a + f.count, 0)} 次` : null,
  ].filter(Boolean)

  els.push(`
    <div class="overview">
      <div class="score-ring" style="--pct:${report.totalScore}">
        <div class="inner"><span class="num">${report.totalScore}</span><span class="lab">总分 / 100</span></div>
      </div>
      <div class="overview-text">
        <p class="summary">${esc(report.summary)}</p>
        <div class="metric-chips">${chips.map(c => `<span class="chip">${c}</span>`).join('')}</div>
      </div>
    </div>`)

  // 雷达图
  if (report.dimensions?.length) {
    els.push(`<div class="radar-wrap"><canvas id="radarCanvas" width="720" height="640"></canvas></div>`)
  }

  // 优点
  if (report.strengths?.length) {
    els.push(`<div class="section-title">👍 做得好的地方 <span class="badge">点击时间点可跳播</span></div>`)
    els.push(report.strengths.map(s => fbCard(s, 'good')).join(''))
  }

  // 不足
  if (report.weaknesses?.length) {
    els.push(`<div class="section-title">🎯 需要改进的地方</div>`)
    els.push(report.weaknesses.map(w => fbCard(w, 'bad')).join(''))
  }

  // 口头禅
  if (report.fillers?.length) {
    const max = Math.max(...report.fillers.map(f => f.count))
    els.push(`<div class="section-title">🗣 口头禅统计</div>`)
    els.push(report.fillers.map(f => `
      <div class="filler-row">
        <span class="filler-word">${esc(f.word)}</span>
        <div class="filler-bar-wrap"><div class="filler-bar" style="width:${(f.count / max) * 100}%"></div></div>
        <span class="filler-count">×${f.count}</span>
      </div>`).join(''))
  }

  // 逐句
  if (report.sentences?.length) {
    els.push(`<div class="section-title">📝 逐句${report.hasRef ? '对照' : '时间轴'} <span class="badge">${report.hasRef ? '原文 vs 朗读' : '点击句子跳播'}</span></div>`)
    els.push(report.hasRef ? renderSentenceTable(report.sentences) : renderSentenceList(report.sentences))
  }

  // 总建议
  if (report.overallAdvice) {
    els.push(`<div class="advice"><b>下一步建议：</b>${esc(report.overallAdvice)}</div>`)
  }

  body.innerHTML = els.join('')

  // 雷达图
  if (report.dimensions?.length) {
    drawRadar($('radarCanvas'), report.dimensions)
  }

  // 音频播放器 + 跳播（云端同步来的记录无音频，隐藏播放器）
  $('reportAudioWrap').classList.toggle('hidden', !audioURL)
  $('reportAudio').src = audioURL || ''
  document.querySelectorAll('[data-seek]').forEach(btn => {
    btn.addEventListener('click', () => {
      const audio = $('reportAudio')
      if (!audio.src) return
      audio.currentTime = Number(btn.dataset.seek)
      audio.play()
      $('reportAudioWrap').scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  })
  $('reportCard').scrollIntoView({ behavior: 'smooth' })
}

function fbCard(item, cls) {
  const time = item.time != null && isFinite(item.time)
    ? `<button class="time-link" data-seek="${item.time}">▶ ${fmtTime(item.time)}</button>` : ''
  const sug = item.suggestion ? `<div class="fb-sug"><b>建议：</b>${esc(item.suggestion)}</div>` : ''
  const det = item.detail ? `<div class="fb-sug">${esc(item.detail)}</div>` : ''
  const ev = item.evidence ? `<div class="fb-ev">${esc(item.evidence)}</div>` : ''
  return `<div class="fb-card ${cls}">
    <div class="fb-title">${esc(item.title)} ${time}</div>
    ${ev}${det}${sug}
  </div>`
}

function renderSentenceTable(sents) {
  return `<table class="sent-table">
    <thead><tr><th>时间</th><th>原文</th><th>你的朗读</th><th>结果</th></tr></thead>
    <tbody>${sents.map((s, i) => {
      const time = s.start != null
        ? `<button class="time-link" data-seek="${s.start}">${fmtTime(s.start)}</button>` : '—'
      const refCell = s.refText ? esc(s.refText) : `<span class="missed-cell">（无，多读的句子）</span>`
      const hypCell = s.text
        ? esc(s.text)
        : `<span class="missed-cell">（漏读）</span>`
      return `<tr class="sent-row" data-seek="${s.start ?? 0}" data-seekable="${s.start != null}">
        <td>${time}</td><td>${refCell}</td><td>${hypCell}</td>
        <td class="st ${s.status}">${STATUS_LABEL[s.status] || ''}</td>
      </tr>`
    }).join('')}</tbody>
  </table>`
}

function renderSentenceList(sents) {
  return `<table class="sent-table">
    <thead><tr><th>时间</th><th>内容</th></tr></thead>
    <tbody>${sents.map(s => `
      <tr class="sent-row" data-seek="${s.start ?? 0}" data-seekable="${s.start != null}">
        <td><button class="time-link" data-seek="${s.start ?? 0}">▶ ${fmtTime(s.start ?? 0)}</button></td>
        <td>${esc(s.text)}</td>
      </tr>`).join('')}</tbody>
  </table>`
}

// 表格行点击跳播
$('reportBody').addEventListener('click', e => {
  const row = e.target.closest('.sent-row')
  if (!row || row.dataset.seekable !== 'true') return
  const audio = $('reportAudio')
  if (!audio.src) return
  audio.currentTime = Number(row.dataset.seek)
  audio.play()
})

// ---------- 雷达图 ----------
function drawRadar(canvas, dims) {
  const dpr = window.devicePixelRatio || 1
  const W = canvas.width, H = canvas.height // 已按 2x 画布尺寸设计
  canvas.style.width = W / 2 + 'px'
  canvas.style.height = H / 2 + 'px'
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, W, H)

  const n = dims.length
  const cx = W / 2, cy = H / 2 + 10
  const R = Math.min(W, H) / 2 - 90
  const angle = i => -Math.PI / 2 + (i * 2 * Math.PI) / n
  const pt = (i, r) => [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r]

  ctx.lineWidth = 2
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i, (R * ring) / 4)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.strokeStyle = '#e5e7f0'
    ctx.stroke()
  }
  // 轴线 + 标签
  ctx.font = '24px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, R)
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.strokeStyle = '#e5e7f0'; ctx.stroke()
    const [lx, ly] = pt(i, R + 46)
    ctx.fillStyle = '#1f2333'
    ctx.font = 'bold 24px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.fillText(dims[i].name, lx, ly - 14)
    ctx.fillStyle = '#6366f1'
    ctx.font = 'bold 26px Consolas, monospace'
    ctx.fillText(dims[i].score, lx, ly + 16)
  }
  // 分数多边形
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, (R * dims[i].score) / 100)
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fillStyle = 'rgba(99, 102, 241, 0.3)'
  ctx.fill()
  ctx.strokeStyle = '#6366f1'
  ctx.lineWidth = 3
  ctx.stroke()
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, (R * dims[i].score) / 100)
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = '#4f46e5'; ctx.fill()
  }
}

$('closeReportBtn').addEventListener('click', () => $('reportCard').classList.add('hidden'))

// =========================================================
// 账号（本地多账号，评测按账号隔离）
// =========================================================
let accounts = []
let cloudAccounts = []  // 服务端账号列表 [{id, name, count, updatedAt}]
let activeAccountId = (() => {
  const v = localStorage.getItem(ACTIVE_KEY)
  return v == null ? null : v === 'default' ? 'default' : Number(v) || null
})()

/** 拉取云端账号列表（失败静默，云端不可用不影响本地使用） */
async function loadCloudAccounts() {
  try {
    const r = await fetch('api/accounts')
    if (r.ok) cloudAccounts = (await r.json()).accounts || []
  } catch {
    cloudAccounts = []
  }
}

const isLinked = id => cloudAccounts.some(a => String(a.id) === String(id))

async function loadAccounts() {
  accounts = (await idbOp(ACCOUNTS, s => s.getAll())).sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/** 旧版本记录（无 accountId）迁移到「默认账号」 */
async function migrateRecords() {
  const all = await idbOp(STORE, s => s.getAll())
  const orphans = all.filter(r => !r.accountId)
  if (!orphans.length) return
  if (!accounts.some(a => a.id === 'default')) {
    await idbOp(ACCOUNTS, s => s.add({ id: 'default', name: '默认账号', createdAt: new Date().toISOString() }))
  }
  for (const r of orphans) {
    await idbOp(STORE, s => s.put({ ...r, accountId: 'default' }))
  }
  await loadAccounts()
}

async function createAccount(name) {
  const acc = { id: Date.now(), name, createdAt: new Date().toISOString() }
  await idbOp(ACCOUNTS, s => s.add(acc))
  await loadAccounts()
  await setActiveAccount(acc.id)
}

async function setActiveAccount(id) {
  activeAccountId = id
  localStorage.setItem(ACTIVE_KEY, String(id))
  currentReport = null
  $('reportCard').classList.add('hidden')
  resetReady()  // 清掉上个账号留下的录音/回放
  await renderAccounts()
  await renderHistory()
}

async function renameAccount(id, name) {
  const acc = accounts.find(a => a.id === id)
  if (!acc || !name || name === acc.name) return
  await idbOp(ACCOUNTS, s => s.put({ ...acc, name }))
  await loadAccounts()
  await renderAccounts()
  // 已关联云端则同步改名
  if (isLinked(id)) uploadAccount(id).catch(e => console.warn('云端改名推送失败', e))
}

async function deleteAccount(id) {
  // dataset 传来的是字符串；IDB 键类型敏感，先换回存储时的真实 id
  const acc = accounts.find(a => String(a.id) === String(id))
  if (!acc) return
  id = acc.id
  const all = await idbOp(STORE, s => s.getAll())
  for (const r of all.filter(r => r.accountId === id)) {
    await idbOp(STORE, s => s.delete(r.id))
  }
  await idbOp(ACCOUNTS, s => s.delete(id))
  await loadAccounts()
  if (String(activeAccountId) === String(id)) {
    localStorage.removeItem(ACTIVE_KEY)
    activeAccountId = null
    currentReport = null
    $('reportCard').classList.add('hidden')
    if (accounts.length) await setActiveAccount(accounts[0].id)
    else { await renderAccounts(); await renderHistory() }
  } else {
    await renderAccounts()
    await renderHistory()
  }
}

async function renderAccounts() {
  const list = $('accountList')
  if (!accounts.length) {
    list.innerHTML = '<p class="muted small">还没有账号，点击下方按钮创建</p>'
    await renderLeaderboard()
    return
  }
  // 每个账号的评测数
  const counts = await recordCounts()
  list.innerHTML = accounts.map(a => {
    const linked = isLinked(a.id)
    return `
    <div class="account-item ${String(a.id) === String(activeAccountId) ? 'active' : ''}" data-id="${a.id}">
      <div class="acc-main">
        <div class="acc-name">${esc(a.name)}${linked ? ' <span class="cloud-badge" title="已同步云端">☁️</span>' : ''}</div>
        <div class="acc-meta">${counts.get(String(a.id)) || 0} 次评测</div>
      </div>
      <button class="icon-btn" data-cloud="${a.id}" title="${linked ? '从云端更新本机记录' : '上传到云端'}">${linked ? '⬇️' : '⬆️'}</button>
      <button class="icon-btn" data-rename="${a.id}" title="重命名">✏️</button>
      <button class="icon-btn danger" data-del-acc="${a.id}" title="删除账号及其全部评测">✕</button>
    </div>`
  }).join('')
  await renderLeaderboard()
}

function startRename(id) {
  const acc = accounts.find(a => String(a.id) === String(id))
  const item = document.querySelector(`.account-item[data-id="${id}"]`)
  const nameEl = item?.querySelector('.acc-name')
  if (!acc || !nameEl) return
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'rename-input'
  input.maxLength = 20
  input.value = acc.name
  nameEl.replaceWith(input)
  input.focus()
  input.select()
  const done = async () => {
    const v = input.value.trim()
    if (v && v !== acc.name) await renameAccount(acc.id, v)
    else await renderAccounts()
  }
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') input.blur()
    if (ev.key === 'Escape') { input.value = acc.name; input.blur() }
  })
  input.addEventListener('blur', done, { once: true })
}

async function submitNewAccount() {
  const input = $('newAccountName')
  const name = input.value.trim()
  input.value = ''
  $('newAccountForm').classList.add('hidden')
  if (name) await createAccount(name)
}

$('newAccountBtn').addEventListener('click', () => {
  $('newAccountForm').classList.remove('hidden')
  $('newAccountName').value = ''
  $('newAccountName').focus()
})
$('newAccountName').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitNewAccount()
  if (e.key === 'Escape') { $('newAccountName').value = ''; $('newAccountForm').classList.add('hidden') }
})
$('newAccountName').addEventListener('blur', () => {
  if ($('newAccountName').value.trim()) submitNewAccount()
  else $('newAccountForm').classList.add('hidden')
})

$('accountList').addEventListener('click', async e => {
  const cloudBtn = e.target.closest('[data-cloud]')
  if (cloudBtn) {
    e.stopPropagation()
    const id = cloudBtn.dataset.cloud
    try {
      if (isLinked(id)) await pullAccount(id)
      else await uploadAccount(id)
    } catch (err) {
      showError(err.message)
    }
    return
  }
  const del = e.target.closest('[data-del-acc]')
  if (del) {
    e.stopPropagation()
    const id = del.dataset.delAcc
    const acc = accounts.find(a => String(a.id) === String(id))
    if (confirm(`删除账号「${acc?.name || ''}」及其全部评测记录？\n此操作不可恢复。`)) {
      await deleteAccount(id)
    }
    return
  }
  const ren = e.target.closest('[data-rename]')
  if (ren) {
    e.stopPropagation()
    startRename(ren.dataset.rename)
    return
  }
  const item = e.target.closest('.account-item')
  if (item && String(item.dataset.id) !== String(activeAccountId)) {
    await setActiveAccount(item.dataset.id === 'default' ? 'default' : Number(item.dataset.id))
  }
})

// =========================================================
// 云端同步（上传/拉取/合并；音频不参与同步）
// =========================================================

/** 上传本地账号及其全部记录到云端（默认按记录 id 与云端合并；replace=true 时以本地列表整体替换云端记录） */
async function uploadAccount(id, replace = false) {
  const acc = accounts.find(a => String(a.id) === String(id))
  if (!acc) throw new Error('账号不存在')
  const recs = (await idbOp(STORE, s => s.getAll()))
    .filter(r => String(r.accountId) === String(id))
    .sort((a, b) => a.id - b.id)
  const payload = {
    account: { id: acc.id, name: acc.name, createdAt: acc.createdAt, updatedAt: Date.now() },
    records: recs.map(({ audio, ...rest }) => rest),  // 音频不上传
    ...(replace ? { replace: true } : {}),
  }
  const r = await fetch('api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) throw new Error((await r.json()).error || '上传失败')
  await loadCloudAccounts()
  await renderAccounts()
}

/** 拉取云端账号：本地无则创建（沿用云端 id，完成关联），有则合并记录（保留本机音频） */
async function pullAccount(id) {
  const r = await fetch('api/accounts/' + id)
  if (!r.ok) throw new Error((await r.json()).error || '拉取失败')
  const { account, records } = await r.json()

  let acc = accounts.find(a => String(a.id) === String(account.id))
  if (!acc) {
    acc = { id: account.id, name: account.name, createdAt: account.createdAt }
    await idbOp(ACCOUNTS, s => s.add(acc))
    await loadAccounts()
  }

  const local = (await idbOp(STORE, s => s.getAll()))
    .filter(r => String(r.accountId) === String(account.id))
  const byId = new Map(local.map(r => [r.id, r]))
  for (const cr of records) {
    // 同 id 保留本机音频，其余以云端为准
    byId.set(cr.id, { ...cr, accountId: account.id, audio: byId.get(cr.id)?.audio })
  }
  for (const rec of byId.values()) {
    await idbOp(STORE, s => s.put(rec))
  }
  await renderAccounts()
  await renderHistory()
}

async function renderSyncDialog() {
  const list = $('syncList')
  if (!cloudAccounts.length) {
    list.innerHTML = '<p class="muted small">云端还没有账号。先在本机点账号旁的「⬆️」上传到云端。</p>'
    return
  }
  list.innerHTML = cloudAccounts.map(a => `
    <div class="sync-item">
      <div class="acc-main">
        <div class="acc-name">${esc(a.name)}${isLinked(a.id) ? ' <span class="cloud-badge">☁️</span>' : ''}</div>
        <div class="acc-meta">${a.count} 次评测 · 更新于 ${new Date(a.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      <button class="btn ghost small-btn" data-import="${a.id}">导入/更新</button>
      <button class="icon-btn danger" data-del-cloud="${a.id}" title="删除云端账号（不影响本机）">✕</button>
    </div>`).join('')
}

$('syncFromCloudBtn').addEventListener('click', async () => {
  await loadCloudAccounts()
  await renderSyncDialog()
  $('syncDialog').classList.remove('hidden')
})
$('syncCloseBtn').addEventListener('click', () => $('syncDialog').classList.add('hidden'))
$('syncDialog').addEventListener('click', e => {
  if (e.target === $('syncDialog')) $('syncDialog').classList.add('hidden')
})
$('syncList').addEventListener('click', async e => {
  const delC = e.target.closest('[data-del-cloud]')
  if (delC) {
    e.stopPropagation()
    const id = delC.dataset.delCloud
    const a = cloudAccounts.find(x => String(x.id) === String(id))
    if (confirm(`删除云端账号「${a?.name || ''}」？\n本机数据不受影响。`)) {
      await fetch('api/accounts/' + id, { method: 'DELETE' })
      await loadCloudAccounts()
      await renderSyncDialog()
      await renderAccounts()
    }
    return
  }
  const imp = e.target.closest('[data-import]')
  if (!imp) return
  try {
    await pullAccount(imp.dataset.import)
    await loadCloudAccounts()
    await renderSyncDialog()
  } catch (err) {
    showError('同步失败：' + err.message)
  }
})

// =========================================================
// 合并账号 / 转移记录
// =========================================================

/** 各账号评测数（key 为 String(accountId)） */
async function recordCounts() {
  const counts = new Map()
  for (const r of await idbOp(STORE, s => s.getAll())) {
    if (r.accountId) counts.set(String(r.accountId), (counts.get(String(r.accountId)) || 0) + 1)
  }
  return counts
}

function openMergeDialog() {
  if (accounts.length < 2) { showError('至少需要两个账号才能合并'); return }
  $('mergeTarget').innerHTML = accounts.map(a => `<option value="${esc(String(a.id))}">${esc(a.name)}</option>`).join('')
  renderMergeList()
  $('mergeDialog').classList.remove('hidden')
}

async function renderMergeList() {
  const target = $('mergeTarget').value
  const counts = await recordCounts()
  const rows = accounts.filter(a => String(a.id) !== String(target))
  $('mergeList').innerHTML = rows.length
    ? rows.map(a => `
      <label class="sync-item merge-item">
        <input type="checkbox" data-merge-src="${esc(String(a.id))}">
        <div class="acc-main">
          <div class="acc-name">${esc(a.name)}${isLinked(a.id) ? ' <span class="cloud-badge">☁️</span>' : ''}</div>
          <div class="acc-meta">${counts.get(String(a.id)) || 0} 次评测</div>
        </div>
      </label>`).join('')
    : '<p class="muted small">没有其他账号可合并</p>'
}

async function confirmMerge() {
  const target = accounts.find(a => String(a.id) === String($('mergeTarget').value))
  const sourceIds = [...document.querySelectorAll('[data-merge-src]:checked')].map(el => el.dataset.mergeSrc)
  if (!target || !sourceIds.length) { showError('请先勾选要合并的账号'); return }
  if (!confirm(`把 ${sourceIds.length} 个账号的全部评测记录合并到「${target.name}」，并删除这些源账号？\n此操作不可恢复。`)) return
  // 记录改归属（记录 id 不变，云端按 id 合并不受影响）
  for (const r of await idbOp(STORE, s => s.getAll())) {
    if (sourceIds.some(id => String(r.accountId) === String(id))) {
      await idbOp(STORE, s => s.put({ ...r, accountId: target.id }))
    }
  }
  // 删除源账号（云端有的话一并删除）；dataset 是字符串，换回真实 id 再删
  for (const sid of sourceIds) {
    const src = accounts.find(a => String(a.id) === String(sid))
    if (!src) continue
    if (isLinked(src.id)) fetch('api/accounts/' + src.id, { method: 'DELETE' }).catch(e => console.warn('云端删除失败', e))
    await idbOp(ACCOUNTS, s => s.delete(src.id))
  }
  $('mergeDialog').classList.add('hidden')
  await loadAccounts()
  if (sourceIds.some(id => String(id) === String(activeAccountId))) await setActiveAccount(target.id)
  else { await renderAccounts(); await renderHistory() }
  if (isLinked(target.id)) uploadAccount(target.id).catch(e => console.warn('云端推送失败', e))
}

let moveRecordId = null

async function openMoveDialog(recordId) {
  moveRecordId = Number(recordId)
  const others = accounts.filter(a => String(a.id) !== String(activeAccountId))
  $('moveList').innerHTML = others.length
    ? others.map(a => `
      <div class="sync-item">
        <div class="acc-main"><div class="acc-name">${esc(a.name)}</div><div class="acc-meta">${isLinked(a.id) ? '☁️ 已同步云端' : '仅本机'}</div></div>
        <button class="btn ghost small-btn" data-move-to="${esc(String(a.id))}">移入</button>
      </div>`).join('')
    : '<p class="muted small">没有其他账号可转移</p>'
  $('moveDialog').classList.remove('hidden')
}

async function moveRecordTo(targetId) {
  const rec = await idbOp(STORE, s => s.get(moveRecordId))
  const target = accounts.find(a => String(a.id) === String(targetId))
  if (!rec || !target) return
  const fromId = rec.accountId
  await idbOp(STORE, s => s.put({ ...rec, accountId: target.id }))
  $('moveDialog').classList.add('hidden')
  moveRecordId = null
  // 云端：源账号以本地列表整体替换（移除该条），目标账号合并加入
  if (isLinked(fromId)) uploadAccount(fromId, true).catch(e => console.warn('云端推送失败', e))
  if (isLinked(target.id)) uploadAccount(target.id).catch(e => console.warn('云端推送失败', e))
  await renderHistory()
  await renderAccounts()
}

$('mergeAccBtn').addEventListener('click', openMergeDialog)
$('mergeTarget').addEventListener('change', renderMergeList)
$('mergeConfirmBtn').addEventListener('click', confirmMerge)
$('mergeCloseBtn').addEventListener('click', () => $('mergeDialog').classList.add('hidden'))
$('mergeDialog').addEventListener('click', e => {
  if (e.target === $('mergeDialog')) $('mergeDialog').classList.add('hidden')
})
$('moveCloseBtn').addEventListener('click', () => $('moveDialog').classList.add('hidden'))
$('moveDialog').addEventListener('click', e => {
  if (e.target === $('moveDialog')) $('moveDialog').classList.add('hidden')
})
$('moveList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-move-to]')
  if (btn) await moveRecordTo(btn.dataset.moveTo)
})

// =========================================================
// 趣味排行榜（账号平均分 + 最近趋势动作）
// =========================================================

// 自绘动画 SVG：领跑兔（跳+耳朵摇+眨眼）、垫底龟（爬+划腿+探头）
const ANIMAL_SVGS = {
  rabbit: `
<svg class="lb-svg lb-svg-rabbit" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="兔子">
  <g class="rb-body">
    <g class="rb-ear rb-ear-l">
      <ellipse cx="24" cy="15" rx="5" ry="12" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>
      <ellipse cx="24" cy="17" rx="2.2" ry="8" fill="#fbcfe8"/>
    </g>
    <g class="rb-ear rb-ear-r">
      <ellipse cx="40" cy="15" rx="5" ry="12" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>
      <ellipse cx="40" cy="17" rx="2.2" ry="8" fill="#fbcfe8"/>
    </g>
    <circle cx="32" cy="40" r="16" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>
    <ellipse class="rb-eye" cx="26" cy="37.5" rx="2.2" ry="2.8" fill="#374151"/>
    <ellipse class="rb-eye" cx="38" cy="37.5" rx="2.2" ry="2.8" fill="#374151"/>
    <circle cx="26.9" cy="36.5" r="0.7" fill="#fff"/>
    <circle cx="38.9" cy="36.5" r="0.7" fill="#fff"/>
    <ellipse cx="32" cy="43" rx="1.9" ry="1.4" fill="#f9a8d4"/>
    <path d="M32 44.3 q-2.5 2.5 -4 0.5 M32 44.3 q2.5 2.5 4 0.5" stroke="#9ca3af" fill="none" stroke-width="1.4" stroke-linecap="round"/>
    <circle cx="20" cy="43" r="2.6" fill="#fbcfe8" opacity="0.75"/>
    <circle cx="44" cy="43" r="2.6" fill="#fbcfe8" opacity="0.75"/>
  </g>
</svg>`,
  turtle: `
<svg class="lb-svg lb-svg-turtle" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="乌龟">
  <g class="tt-body">
    <path d="M46 46 l6 2 l-6 3 z" fill="#6ee7b7" stroke="#34d399" stroke-width="1"/>
    <g class="tt-leg tt-leg-l"><ellipse cx="21" cy="51" rx="4" ry="3.2" fill="#a7f3d0" stroke="#34d399" stroke-width="1.2"/></g>
    <g class="tt-leg tt-leg-r"><ellipse cx="41" cy="51" rx="4" ry="3.2" fill="#a7f3d0" stroke="#34d399" stroke-width="1.2"/></g>
    <path d="M17 47 Q31 20 45 47 Z" fill="#34d399" stroke="#059669" stroke-width="1.5"/>
    <path d="M31 27 L24 44 M31 27 L38 44 M25 34 L37 34" stroke="#059669" stroke-width="1" opacity="0.5" fill="none"/>
    <rect x="15" y="45.5" width="32" height="4.5" rx="2.2" fill="#10b981" stroke="#059669" stroke-width="1.2"/>
    <g class="tt-head">
      <circle cx="13" cy="40" r="5.5" fill="#a7f3d0" stroke="#34d399" stroke-width="1.2"/>
      <circle cx="11" cy="38.5" r="1.1" fill="#065f46"/>
      <path d="M9.5 42.5 q1.5 1.6 3.2 0.6" stroke="#059669" stroke-width="1" fill="none" stroke-linecap="round"/>
    </g>
  </g>
</svg>`,
}
// ---------- 趋势场景：角色（兔/龟/小人）开车、骑车、站立、倒退、幼苗 ----------
const BODY_COLORS = { rabbit: '#cbd5e1', turtle: '#34d399', person: '#f59e0b' }

/** 角色头部（以 (x,y) 为中心的组） */
function charHead(char, x, y, s = 1) {
  const heads = {
    rabbit: `<ellipse cx="-4" cy="-8.5" rx="2.3" ry="5" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.1"/><ellipse cx="4" cy="-8.5" rx="2.3" ry="5" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.1"/><circle r="7" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.4"/><circle cx="-2.6" cy="-1" r="1" fill="#374151"/><circle cx="2.6" cy="-1" r="1" fill="#374151"/><ellipse cy="2.2" rx="1.2" ry="0.9" fill="#f9a8d4"/>`,
    turtle: `<circle r="7" fill="#a7f3d0" stroke="#34d399" stroke-width="1.4"/><circle cx="-2.6" cy="-1.2" r="1" fill="#065f46"/><circle cx="2.6" cy="-1.2" r="1" fill="#065f46"/><path d="M-2 2.3 q2 1.6 4 0" stroke="#059669" stroke-width="1.1" fill="none" stroke-linecap="round"/>`,
    person: `<circle r="7" fill="#fde68a" stroke="#f59e0b" stroke-width="1.4"/><circle cx="-2.6" cy="-1.2" r="1" fill="#374151"/><circle cx="2.6" cy="-1.2" r="1" fill="#374151"/><path d="M-2 2.3 q2 1.6 4 0" stroke="#b45309" stroke-width="1.1" fill="none" stroke-linecap="round"/>`,
  }
  return `<g transform="translate(${x} ${y}) scale(${s})">${heads[char] || heads.person}</g>`
}

/** 角色躯干/四肢（胶囊形线段） */
const limb = (x1, y1, x2, y2, char, w = 4.5) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${BODY_COLORS[char]}" stroke-width="${w}" stroke-linecap="round"/>`

/** 速度线（车尾气流感） */
const speedLines = () => `<g class="sc-lines" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round" fill="none"><line x1="3" y1="28" x2="12" y2="28"/><line x1="1" y1="36" x2="10" y2="36"/><line x1="4" y1="44" x2="11" y2="44"/></g>`

/** 车轮（带辐条，旋转动画用） */
const wheel = (x, y, r = 6.5) => `<g class="wheel"><circle cx="${x}" cy="${y}" r="${r}" fill="#334155"/><circle cx="${x}" cy="${y}" r="${Math.max(2, r - 4)}" fill="#94a3b8"/><path d="M${x - r + 1} ${y} H${x + r - 1} M${x} ${y - r + 1} V${y + r - 1}" stroke="#64748b" stroke-width="1.4"/></g>`

function carScene(char) {
  return `<svg class="lb-svg lb-svg-car" viewBox="0 0 64 64" role="img" aria-label="开车上升">
  ${speedLines()}
  <g class="sc-body">
    <rect x="12" y="35" width="44" height="12" rx="5" fill="#6366f1"/>
    <path d="M23 35 L27 23 H43 L47 35 Z" fill="#6366f1"/>
    <path d="M26 33 L29 25 H41 L44 33 Z" fill="#dbeafe"/>
    ${charHead(char, 35, 16, 0.95)}
    ${wheel(22, 48)}${wheel(46, 48)}
  </g>
</svg>`
}

function bikeScene(char) {
  return `<svg class="lb-svg lb-svg-bike" viewBox="0 0 64 64" role="img" aria-label="骑车上升">
  <g class="sc-body">
    <path d="M14 44 L26 27 M26 27 L45 26 M32 43 L26 27 M32 43 L45 26 M45 26 L50 44" stroke="#475569" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <path d="M22.5 27 H29.5" stroke="#334155" stroke-width="4" stroke-linecap="round"/>
    <path d="M41 24 H48" stroke="#334155" stroke-width="4" stroke-linecap="round"/>
    ${limb(26, 23, 33, 33, char)}
    ${limb(27, 25, 44, 25, char, 3.5)}
    ${limb(33, 33, 32, 43, char, 4)}
    ${charHead(char, 26, 17, 0.95)}
    ${wheel(14, 44, 8)}${wheel(50, 44, 8)}
  </g>
</svg>`
}

function standScene(char) {
  return `<svg class="lb-svg lb-svg-stand" viewBox="0 0 64 64" role="img" aria-label="原地站立">
  <ellipse cx="32" cy="58" rx="13" ry="2.5" fill="#e5e7f0"/>
  <g class="sc-body">
    ${limb(32, 25, 32, 44, char, 5)}
    ${limb(32, 30, 25, 38, char, 3.5)}
    ${limb(32, 30, 39, 38, char, 3.5)}
    ${limb(32, 44, 27, 57, char, 4.5)}
    ${limb(32, 44, 37, 57, char, 4.5)}
    ${charHead(char, 32, 17, 1)}
  </g>
</svg>`
}

/** 倒退：面朝右但向左挪，双腿交替摆（快速倒退时显示速度线） */
function walkScene(char) {
  return `<svg class="lb-svg lb-svg-back" viewBox="0 0 64 64" role="img" aria-label="倒退">
  ${speedLines()}
  <ellipse cx="32" cy="58" rx="13" ry="2.5" fill="#e5e7f0"/>
  <g class="sc-move">
    ${limb(32, 25, 32, 44, char, 5)}
    ${limb(32, 30, 25, 37, char, 3.5)}
    ${limb(32, 30, 39, 37, char, 3.5)}
    <g class="leg leg-a">${limb(32, 44, 27, 57, char, 4.5)}</g>
    <g class="leg leg-b">${limb(32, 44, 37, 57, char, 4.5)}</g>
    ${charHead(char, 32, 17, 1)}
  </g>
</svg>`
}

function seedScene() {
  return `<svg class="lb-svg lb-svg-seed" viewBox="0 0 64 64" role="img" aria-label="待观察">
  <ellipse cx="32" cy="56" rx="14" ry="3" fill="#e5e7f0"/>
  <g class="sprout">
    <path d="M32 56 V40" stroke="#16a34a" stroke-width="3" stroke-linecap="round" fill="none"/>
    <path d="M32 44 Q21 42 19 33 Q30 33 32 44 Z" fill="#4ade80" stroke="#16a34a" stroke-width="1.2"/>
    <path d="M32 40 Q43 38 45 29 Q34 29 32 40 Z" fill="#4ade80" stroke="#16a34a" stroke-width="1.2"/>
  </g>
</svg>`
}

const TREND_SCENES = { car: carScene, bike: bikeScene, stand: standScene, back: walkScene, seed: seedScene }

const TRENDS = [
  { min: 8, key: 'car', label: '全速上升', cls: 'lb-car' },
  { min: 3, key: 'bike', label: '稳步上升', cls: 'lb-bike' },
  { min: -3, key: 'stand', label: '原地站立', cls: 'lb-stand' },
  { min: -8, key: 'back', label: '缓慢倒退', cls: 'lb-back' },
  { min: -Infinity, key: 'back', label: '快速倒退', cls: 'lb-back-fast' },
]

function trendOf(delta) {
  if (delta == null) return { key: 'seed', label: '待观察', cls: 'lb-seed' }
  return TRENDS.find(t => delta >= t.min)
}

/** 趋势 = 最近 k 次均分 - 之前 k 次均分（k 最多 3） */
function calcTrendDelta(scores) {
  if (scores.length < 2) return null
  const k = Math.min(3, Math.floor(scores.length / 2))
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length
  return avg(scores.slice(-k)) - avg(scores.slice(-2 * k, -k))
}

async function renderLeaderboard() {
  const wrap = $('leaderboard')
  if (!wrap) return
  if (!accounts.length) {
    wrap.innerHTML = '<p class="muted small">创建账号、完成评测后，这里会出现排行榜 🐰🐢</p>'
    return
  }

  const all = await idbOp(STORE, s => s.getAll())
  const byAcc = new Map()
  for (const r of all) {
    const key = String(r.accountId)
    if (!byAcc.has(key)) byAcc.set(key, [])
    byAcc.get(key).push(r)
  }

  const rows = accounts.map(a => {
    const recs = (byAcc.get(String(a.id)) || []).sort((x, y) => x.id - y.id)
    const scores = recs.map(r => r.totalScore || 0)
    const avg = scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null
    return { acc: a, count: scores.length, avg, delta: calcTrendDelta(scores) }
  })
  rows.sort((x, y) => (y.avg ?? -1) - (x.avg ?? -1))

  const withScores = rows.filter(r => r.avg != null)
  const topId = withScores.length ? String(withScores[0].acc.id) : null
  const bottomId = withScores.length >= 2 ? String(withScores[withScores.length - 1].acc.id) : null

  wrap.innerHTML = rows.map((r, i) => {
    const idStr = String(r.acc.id)
    const animal = idStr === topId ? ANIMAL_SVGS.rabbit : idStr === bottomId ? ANIMAL_SVGS.turtle : ''
    // 趋势动画角色跟账号走：榜首兔子、垫底乌龟、其他小人
    const char = idStr === topId ? 'rabbit' : idStr === bottomId ? 'turtle' : 'person'
    const tr = trendOf(r.delta)
    const deltaTxt = r.delta == null ? '' : `${r.delta > 0 ? '+' : ''}${r.delta.toFixed(0)}`
    const meta = r.avg == null
      ? '还没有评测'
      : `均分 ${Math.round(r.avg)} · ${r.count} 次${deltaTxt ? ` · Δ ${deltaTxt}` : ''}`
    return `
    <div class="lb-row ${idStr === topId ? 'lb-top' : ''} ${idStr === bottomId ? 'lb-bottom' : ''}">
      <div class="lb-avatar">${animal || i + 1}</div>
      <div class="lb-main">
        <div class="lb-name">${esc(r.acc.name)}</div>
        <div class="lb-meta">${meta}</div>
        <div class="lb-bar"><div class="lb-bar-fill" style="width:${r.avg ?? 0}%"></div></div>
      </div>
      <div class="lb-trend ${tr.cls}" title="最近趋势：${tr.label}${deltaTxt ? '（Δ ' + deltaTxt + '）' : ''}">
        <div class="lb-anim">${TREND_SCENES[tr.key](char)}</div>
        <span class="lb-trend-label">${tr.label}</span>
      </div>
    </div>`
  }).join('')
}

// =========================================================
// 历史（IndexedDB，按当前账号过滤）
// =========================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(ACCOUNTS)) db.createObjectStore(ACCOUNTS, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
function idbOp(storeName, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const out = fn(tx.objectStore(storeName))
    tx.oncomplete = () => resolve(out?.result ?? out)
    tx.onerror = () => reject(tx.error)
  }))
}

async function saveHistory(report) {
  if (!activeAccountId) return
  try {
    await idbOp(STORE, store => store.add({
      id: Date.now(),
      accountId: activeAccountId,
      date: new Date().toISOString(),
      mode: report.mode,
      modeLabel: report.modeLabel,
      durationSec: report.metrics?.durationSec || 0,
      totalScore: report.totalScore,
      summary: report.summary,
      report,
      audio: audioBlob,
    }))
    await trimHistory()
    await renderAccounts()
    await renderHistory()
    // 当前账号已关联云端：静默推送（失败不打断，下次手动同步兜底）
    if (activeAccountId && isLinked(activeAccountId)) {
      uploadAccount(activeAccountId).catch(e => console.warn('云端推送失败', e))
    }
  } catch (e) {
    console.warn('保存历史失败', e)
  }
}

async function trimHistory() {
  const all = await idbOp(STORE, store => store.getAll())
  const byAcc = new Map()
  for (const r of all) {
    if (!r.accountId) continue
    if (!byAcc.has(r.accountId)) byAcc.set(r.accountId, [])
    byAcc.get(r.accountId).push(r)
  }
  for (const recs of byAcc.values()) {
    if (recs.length > 50) {
      recs.sort((a, b) => a.id - b.id)
      for (const r of recs.slice(0, recs.length - 50)) {
        await idbOp(STORE, store => store.delete(r.id))
      }
    }
  }
}

async function renderHistory() {
  const list = $('historyList')
  try {
    if (!activeAccountId) {
      list.innerHTML = '<p class="muted small">请先选择或创建账号</p>'
      return
    }
    const all = (await idbOp(STORE, store => store.getAll()))
      .filter(r => String(r.accountId) === String(activeAccountId))
      .sort((a, b) => b.id - a.id)
    if (!all.length) {
      list.innerHTML = '<p class="muted small">还没有记录，完成第一次分析后出现在这里</p>'
      return
    }
    list.innerHTML = all.map(r => `
      <div class="history-item" data-id="${r.id}">
        <div class="history-main">
          <div class="history-meta">${r.modeLabel} · ${new Date(r.date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${fmtTime(r.durationSec)}</div>
          <div class="history-summary">${esc(r.summary)}</div>
        </div>
        <span class="history-score">${r.totalScore}</span>
        <button class="history-del" data-move="${r.id}" title="转移到其他账号">⇨</button>
        <button class="history-del" data-del="${r.id}" title="删除">✕</button>
      </div>`).join('')
    if (!$('growthWrap').classList.contains('hidden')) await renderGrowth()
  } catch (e) {
    list.innerHTML = '<p class="muted small">历史记录不可用</p>'
  }
}

$('historyList').addEventListener('click', async e => {
  const mv = e.target.closest('[data-move]')
  if (mv) {
    e.stopPropagation()
    await openMoveDialog(mv.dataset.move)
    return
  }
  const del = e.target.closest('[data-del]')
  if (del) {
    e.stopPropagation()
    await idbOp(STORE, store => store.delete(Number(del.dataset.del)))
    await renderHistory()
    await renderAccounts()
    return
  }
  const item = e.target.closest('.history-item')
  if (!item) return
  const rec = (await idbOp(STORE, store => store.get(Number(item.dataset.id))))
  if (!rec) return
  if (rec.date) rec.report.date = rec.date  // 分享卡显示记录日期
  resetAudioURL()
  audioBlob = rec.audio || null
  audioURL = audioBlob ? URL.createObjectURL(audioBlob) : null
  renderReport(rec.report)
})

// =========================================================
// 成长曲线（当前账号总分走势，自绘 SVG，复用排行榜趋势算法）
// =========================================================
$('growthBtn').addEventListener('click', () => {
  const wrap = $('growthWrap')
  wrap.classList.toggle('hidden')
  if (!wrap.classList.contains('hidden')) renderGrowth()
})

async function renderGrowth() {
  const wrap = $('growthWrap')
  const recs = (await idbOp(STORE, s => s.getAll()))
    .filter(r => String(r.accountId) === String(activeAccountId) && typeof r.totalScore === 'number')
    .sort((a, b) => a.id - b.id)
  if (recs.length < 2) {
    wrap.innerHTML = '<p class="muted small">至少两次评测后出现曲线</p>'
    return
  }
  const pts = recs.map(r => r.totalScore)
  const avg = Math.round(pts.reduce((a, b) => a + b, 0) / pts.length)
  const tr = trendOf(calcTrendDelta(pts))
  const W = 340, H = 150, padL = 26, padR = 10, top = 10, bottom = 128
  const x = i => padL + (i * (W - padL - padR)) / (pts.length - 1)
  const y = s => top + ((100 - s) / 100) * (bottom - top)
  const poly = pts.map((s, i) => `${x(i).toFixed(1)},${y(s).toFixed(1)}`).join(' ')
  const grid = [0, 50, 100].map(g => `
    <line x1="${padL}" y1="${y(g)}" x2="${W - padR}" y2="${y(g)}" stroke="#e5e7f0" stroke-width="1"/>
    <text x="${padL - 4}" y="${y(g) + 3}" font-size="9" fill="#9ca3af" text-anchor="end">${g}</text>`).join('')
  const dots = recs.map((r, i) => `
    <circle cx="${x(i).toFixed(1)}" cy="${y(r.totalScore).toFixed(1)}" r="3.2" fill="#4f46e5">
      <title>${new Date(r.date).toLocaleDateString('zh-CN')} ${esc(r.modeLabel)}：${r.totalScore} 分</title>
    </circle>`).join('')
  const df = d => new Date(d).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  wrap.innerHTML = `
    <div class="muted small" style="margin-bottom:2px">${recs.length} 次评测 · 平均 ${avg} 分 · 趋势：${tr.label}</div>
    <svg viewBox="0 0 ${W} ${H}" class="growth-svg">
      ${grid}
      <line x1="${padL}" y1="${y(avg)}" x2="${W - padR}" y2="${y(avg)}" stroke="#10b981" stroke-width="1" stroke-dasharray="4 3"/>
      <polyline points="${poly}" fill="none" stroke="#6366f1" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      <text x="${padL}" y="${H - 3}" font-size="9" fill="#9ca3af">${df(recs[0].date)}</text>
      <text x="${W - padR}" y="${H - 3}" font-size="9" fill="#9ca3af" text-anchor="end">${df(recs[recs.length - 1].date)}</text>
    </svg>`
}

// =========================================================
// 报告分享（canvas 画分享卡 -> 系统分享 / 下载 PNG）
// =========================================================
$('shareReportBtn').addEventListener('click', () => currentReport && shareReport(currentReport))

function wrapLines(ctx, text, maxW, maxLines = 99) {
  const out = []
  let line = ''
  for (const ch of String(text ?? '')) {
    if (ctx.measureText(line + ch).width > maxW || ch === '\n') {
      out.push(line)
      if (out.length >= maxLines) return [...out.slice(0, maxLines - 1), out[maxLines - 1] + '…']
      line = ch === '\n' ? '' : ch
    } else line += ch
  }
  if (line) out.push(line)
  return out
}

function shareReport(report) {
  const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif'
  const accName = accounts.find(a => String(a.id) === String(activeAccountId))?.name || ''
  const W = 750, X = 48, CW = W - 96
  const dims = report.dimensions || []
  const lines = [
    ...(report.strengths || []).slice(0, 3).map(s => '👍 ' + s.title),
    ...(report.weaknesses || []).slice(0, 3).map(w => '🎯 ' + w.title),
  ]
  // 先量出总评行数再定画布高
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = '22px ' + FONT
  const sumLines = wrapLines(probe, report.summary, CW - 180, 5)
  const H = 350 + dims.length * 52 + lines.length * 36 + 90

  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, '#eef2ff'); bg.addColorStop(1, '#ffffff')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  ctx.textBaseline = 'alphabetic'

  let y = 90
  ctx.fillStyle = '#4f46e5'
  ctx.font = 'bold 40px ' + FONT
  ctx.fillText('🎧 ListenToMe 点评报告', X, y)
  y = 128
  ctx.fillStyle = '#6b7280'
  ctx.font = '22px ' + FONT
  ctx.fillText(`${accName ? accName + ' · ' : ''}${report.modeLabel} · ${new Date(report.date || Date.now()).toLocaleString('zh-CN')}`, X, y)

  // 总分圆环 + 总评
  const scx = X + 75, scy = 235
  const pct = Math.max(0, Math.min(100, report.totalScore || 0))
  ctx.beginPath(); ctx.arc(scx, scy, 62, 0, Math.PI * 2)
  ctx.strokeStyle = '#e5e7f0'; ctx.lineWidth = 12; ctx.stroke()
  ctx.beginPath(); ctx.arc(scx, scy, 62, -Math.PI / 2, -Math.PI / 2 + (pct / 100) * Math.PI * 2)
  ctx.strokeStyle = '#6366f1'; ctx.lineCap = 'round'; ctx.stroke()
  ctx.fillStyle = '#1f2333'; ctx.font = 'bold 52px ' + FONT; ctx.textAlign = 'center'
  ctx.fillText(pct, scx, scy + 12)
  ctx.fillStyle = '#9ca3af'; ctx.font = '20px ' + FONT
  ctx.fillText('/ 100', scx, scy + 44)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#374151'; ctx.font = '22px ' + FONT
  sumLines.forEach((l, i) => ctx.fillText(l, X + 180, 200 + i * 32))

  // 维度条
  y = 352
  for (const d of dims) {
    ctx.fillStyle = '#1f2333'; ctx.font = 'bold 24px ' + FONT
    ctx.fillText(d.name, X, y)
    ctx.textAlign = 'right'
    ctx.fillStyle = '#4f46e5'
    ctx.fillText(d.score, W - X, y)
    ctx.textAlign = 'left'
    ctx.fillStyle = '#e5e7f0'
    ctx.fillRect(X, y + 10, CW, 12)
    ctx.fillStyle = '#6366f1'
    ctx.fillRect(X, y + 10, (CW * Math.max(0, Math.min(100, d.score || 0))) / 100, 12)
    y += 52
  }

  // 亮点 / 改进
  ctx.font = '22px ' + FONT
  for (const l of lines) {
    ctx.fillStyle = '#374151'
    ctx.fillText(l, X, y)
    y += 36
  }

  ctx.fillStyle = '#9ca3af'; ctx.font = '20px ' + FONT
  ctx.fillText('🎧 ListenToMe · AI 朗读演讲教练 · fftdsh.com/ltm', X, H - 36)

  cv.toBlob(async blob => {
    if (!blob) return
    const file = new File([blob], 'listenToMe-report.png', { type: 'image/png' })
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'ListenToMe 点评报告' }) } catch {} // 用户取消分享不算错误
    } else {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = file.name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }
  }, 'image/png')
}

// =========================================================
// 启动：迁移旧数据 -> 校验当前账号 -> 渲染
// =========================================================
;(async () => {
  try {
    await loadAccounts()
    await loadCloudAccounts()
    await migrateRecords()
    // 当前账号不存在（首次使用/被清除）时默认选第一个
    if (accounts.length && !accounts.some(a => String(a.id) === String(activeAccountId))) {
      await setActiveAccount(accounts[0].id)
    } else {
      await renderAccounts()
      await renderHistory()
    }
  } catch (e) {
    console.warn('初始化账号失败', e)
    $('accountList').innerHTML = '<p class="muted small">账号数据不可用</p>'
  }
})()

// =========================================================
// 工具
// =========================================================
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
