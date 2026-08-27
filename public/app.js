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

    const r1 = await fetch('/api/transcribe', { method: 'POST', body: fd })
    const transcript = await r1.json()
    if (!r1.ok) throw new Error(transcript.error || '转写失败')

    setStatus('transcribe')
    await sleep(80) // 让状态文案渲染出来
    setStatus('analyze')
    const r2 = await fetch('/api/analyze', {
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

  // 音频播放器 + 跳播
  $('reportAudioWrap').classList.remove('hidden')
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
let activeAccountId = (() => {
  const v = localStorage.getItem(ACTIVE_KEY)
  return v == null ? null : v === 'default' ? 'default' : Number(v) || null
})()

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
  await renderAccounts()
  await renderHistory()
}

async function renameAccount(id, name) {
  const acc = accounts.find(a => a.id === id)
  if (!acc || !name || name === acc.name) return
  await idbOp(ACCOUNTS, s => s.put({ ...acc, name }))
  await loadAccounts()
  await renderAccounts()
}

async function deleteAccount(id) {
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
    return
  }
  // 每个账号的评测数
  const counts = new Map()
  for (const r of await idbOp(STORE, s => s.getAll())) {
    if (r.accountId) counts.set(String(r.accountId), (counts.get(String(r.accountId)) || 0) + 1)
  }
  list.innerHTML = accounts.map(a => `
    <div class="account-item ${String(a.id) === String(activeAccountId) ? 'active' : ''}" data-id="${a.id}">
      <div class="acc-main">
        <div class="acc-name">${esc(a.name)}</div>
        <div class="acc-meta">${counts.get(String(a.id)) || 0} 次评测</div>
      </div>
      <button class="icon-btn" data-rename="${a.id}" title="重命名">✏️</button>
      <button class="icon-btn danger" data-del-acc="${a.id}" title="删除账号及其全部评测">✕</button>
    </div>`).join('')
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
// 历史（IndexedDB，按当前账号过滤）
// =========================================================
const DB_NAME = 'listenToMe', STORE = 'records', ACCOUNTS = 'accounts'
const ACTIVE_KEY = 'listentome:activeAccount'

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
        <button class="history-del" data-del="${r.id}" title="删除">✕</button>
      </div>`).join('')
  } catch (e) {
    list.innerHTML = '<p class="muted small">历史记录不可用</p>'
  }
}

$('historyList').addEventListener('click', async e => {
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
  resetAudioURL()
  audioBlob = rec.audio || null
  audioURL = audioBlob ? URL.createObjectURL(audioBlob) : null
  renderReport(rec.report)
})

// =========================================================
// 启动：迁移旧数据 -> 校验当前账号 -> 渲染
// =========================================================
;(async () => {
  try {
    await loadAccounts()
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
