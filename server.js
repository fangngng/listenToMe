import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json({ limit: '4mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ---------- 配置 ----------
const ASR_BASE_URL = (process.env.ASR_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
const ASR_API_KEY = process.env.ASR_API_KEY || ''
const ASR_MODEL = process.env.ASR_MODEL || 'FunAudioLLM/SenseVoice-V1.8'
const LLM_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const LLM_API_KEY = process.env.DEEPSEEK_API_KEY || ''
const LLM_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
})

// ---------- 模式定义 ----------
const MODES = {
  read: {
    label: '朗读练习',
    dims: ['准确度', '流利度', '语速节奏', '发音清晰', '感情抑扬'],
    desc: '对照参考文本朗读，检查错读/漏读/多读、准确度与流利度',
  },
  speech: {
    label: '演讲练习',
    dims: ['结构逻辑', '语言表达', '语速停顿', '感染力', '时间掌控'],
    desc: '自由演讲或脱稿发言，分析结构逻辑、口头禅、语速与感染力',
  },
  general: {
    label: '泛用点评',
    dims: ['清晰度', '逻辑性', '语言质量', '自然度', '整体印象'],
    desc: '不依赖文本的综合点评：表达清晰度、语言习惯、亮点与短板',
  },
}

// =========================================================
// 转写
// =========================================================
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '缺少音频文件' })
    if (!ASR_API_KEY) return res.status(500).json({ error: '服务端未配置 ASR_API_KEY，请在 .env 中填写' })

    const durationSec = parseFloat(req.body?.duration) || 0
    const filename = req.file.originalname || 'audio.wav'
    const mime = req.file.mimetype || 'audio/wav'

    let json
    try {
      // 优先要带时间戳的 verbose_json
      json = await callAsr(req.file.buffer, filename, mime, 'verbose_json')
    } catch (e) {
      // 某些服务（如 SenseVoice）不支持 verbose_json，退回普通 json
      json = await callAsr(req.file.buffer, filename, mime, 'json')
    }

    const result = normalizeAsr(json, durationSec)
    if (!result.text) {
      return res.status(422).json({ error: '未能识别出任何内容，请确认音频中有清晰的人声' })
    }
    res.json(result)
  } catch (err) {
    console.error('[transcribe]', err)
    res.status(502).json({ error: '转写失败：' + err.message })
  }
})

async function callAsr(buffer, filename, mime, format) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mime }), filename)
  form.append('model', ASR_MODEL)
  if (format) form.append('response_format', format)

  const r = await fetch(ASR_BASE_URL + '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ASR_API_KEY}` },
    body: form,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`ASR 服务返回 ${r.status}：${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    // 有些服务直接返回纯文本
    return { text }
  }
}

/** 统一转写结果格式：{ text, segments: [{text, start, end}] } */
function normalizeAsr(json, durationSec) {
  const rawSegs = Array.isArray(json?.segments) ? json.segments : null

  if (rawSegs && rawSegs.length) {
    const segments = rawSegs
      .map(s => ({
        text: String(s.text || '').trim(),
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
      }))
      .filter(s => s.text)
    const text = String(json.text || '').trim() || segments.map(s => s.text).join('')
    return { text, segments }
  }

  // 没有时间戳：按标点分句，按字数比例估算时间
  const text = String(json?.text || '').trim()
  const pieces = splitSentences(text)
  if (!pieces.length || !durationSec) {
    return { text, segments: text ? [{ text, start: 0, end: durationSec }] : [] }
  }
  const totalChars = pieces.reduce((a, p) => a + p.length, 0)
  let t = 0
  const segments = pieces.map(p => {
    const dur = (durationSec * p.length) / totalChars
    const seg = { text: p, start: +t.toFixed(2), end: +(t + dur).toFixed(2) }
    t += dur
    return seg
  })
  return { text, segments }
}

// =========================================================
// 点评分析
// =========================================================
app.post('/api/analyze', async (req, res) => {
  try {
    if (!LLM_API_KEY) return res.status(500).json({ error: '服务端未配置 DEEPSEEK_API_KEY，请在 .env 中填写' })

    const { mode = 'general', refText = '', topic = '' } = req.body
    const transcript = req.body.transcript || {}
    const metrics = req.body.metrics || {}
    const modeCfg = MODES[mode] || MODES.general

    const text = String(transcript.text || '')
    const segments = Array.isArray(transcript.segments) ? transcript.segments : []
    if (!text) return res.status(400).json({ error: '转写文本为空，无法分析' })

    // 口头禅统计（确定性统计，交给 LLM 引用）
    const fillers = countFillers(text)

    // 逐句：朗读模式做原文对照；其他模式直接用转写句
    let sentences
    let alignmentSummary = ''
    if (mode === 'read' && refText.trim()) {
      const aligned = alignSentences(refText, segments)
      sentences = aligned.sentences
      alignmentSummary = buildAlignmentSummary(aligned)
    } else {
      sentences = segments.map(s => ({
        text: s.text, start: s.start, end: s.end,
        refText: null, status: null,
      }))
    }

    const messages = buildPrompt(modeCfg, { text, segments, metrics, fillers, topic, alignmentSummary })
    let report = null
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      let content
      try {
        content = await chatLLM(messages)
      } catch (e) {
        // LLM 调用偶发失败（空响应/网络抖动）重试一次；截断类错误重试无意义
        if (attempt === 0 && !e.message.includes('max_tokens')) { lastErr = e; continue }
        throw e
      }
      try {
        report = JSON.parse(extractJson(content))
        break
      } catch (e) {
        lastErr = e
        messages.push({ role: 'assistant', content })
        messages.push({ role: 'user', content: '上面的输出不是合法 JSON 或不符合结构约定。请严格只输出符合约定的 JSON，不要有任何其他文字。' })
      }
    }
    if (!report) throw new Error('模型输出解析失败，请重试（' + (lastErr?.message || '') + '）')

    const normalized = normalizeReport(report, modeCfg.dims)
    res.json({
      report: {
        ...normalized,
        mode,
        modeLabel: modeCfg.label,
        metrics,
        fillers,
        sentences,
        hasRef: mode === 'read' && !!refText.trim(),
      },
    })
  } catch (err) {
    console.error('[analyze]', err)
    res.status(502).json({ error: '分析失败：' + err.message })
  }
})

async function chatLLM(messages) {
  const r = await fetch(LLM_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
    }),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`DeepSeek 返回 ${r.status}：${text.slice(0, 300)}`)
  const j = JSON.parse(text)
  const choice = j.choices?.[0]
  const content = choice?.message?.content
  if (!content || !content.trim()) {
    console.error('[analyze] 模型空响应：', JSON.stringify({
      model: j.model,
      finish_reason: choice?.finish_reason,
      usage: j.usage,
    }))
    if (choice?.finish_reason === 'length') {
      throw new Error('模型输出超过 max_tokens 被截断；若使用 deepseek-reasoner 请改用 deepseek-chat')
    }
    throw new Error(`模型未返回内容（finish_reason=${choice?.finish_reason ?? 'unknown'}），请重试`)
  }
  return content
}

function extractJson(s) {
  const t = s.trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('输出中没有 JSON')
  return t.slice(start, end + 1)
}

// ---------- Prompt ----------
function buildPrompt(modeCfg, { segments, metrics, fillers, topic, alignmentSummary }) {
  const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
  const transcriptLines = segments
    .map((s, i) => `[${i + 1}] ${fmt(s.start)}~${fmt(s.end)} ${s.text}`)
    .join('\n')

  const metricLines = [
    `- 总时长：${metrics.durationSec ? fmt(metrics.durationSec) : '未知'}`,
  ]
  if (metrics.speechSec) metricLines.push(`- 估计说话时长（去除长停顿）：${fmt(metrics.speechSec)}`)
  if (metrics.pauseCount != null) metricLines.push(`- ≥0.6秒的停顿次数：${metrics.pauseCount} 次，最长停顿 ${metrics.longestPauseSec || 0} 秒`)
  if (metrics.speechSec && segments.length) {
    const chars = segments.reduce((a, s) => a + s.text.replace(/\s/g, '').length, 0)
    const cpm = Math.round((chars / metrics.speechSec) * 60)
    metricLines.push(`- 语速：约 ${cpm} 字/分钟（中文朗读一般 180-260 字/分钟为宜）`)
  }
  const fillerLine = fillers.length
    ? fillers.map(f => `"${f.word}"×${f.count}`).join('、')
    : '未检测到常见口头禅'

  const schema = `{
  "totalScore": 0到100的整数,
  "summary": "一句话总评，不超过60字，点出最突出的特点",
  "dimensions": [{"name": "维度名（必须用给定的5个维度名）", "score": 0到100, "comment": "不超过40字的点评"}] 共5项,
  "strengths": [{"title": "优点标题不超过12字", "evidence": "引用转写原文或数据作为证据", "time": 时间点秒数或null, "detail": "一句话说明"}] 3到5项,
  "weaknesses": [{"title": "不足标题不超过12字", "evidence": "引用转写原文或数据", "suggestion": "具体可操作的改进建议", "time": 时间点秒数或null}] 3到5项,
  "overallAdvice": "下一步练习建议，1到2句话"
}`

  const user = `请点评一段用户的${modeCfg.label}录音。

【评分维度】（按此顺序）：${modeCfg.dims.join('、')}
${topic ? `\n【用户自述主题/提纲】：${topic}` : ''}
【声学指标】
${metricLines.join('\n')}
【口头禅统计】${fillerLine}
${alignmentSummary ? `\n【与参考文本的对照结果】\n${alignmentSummary}` : ''}

【转写全文（带时间戳）】
${transcriptLines}

【输出要求】
- 所有优缺点必须引用上面转写原文中的具体句子或数据作为证据（evidence 字段），禁止编造不存在的内容。
- 证据对应的时间点填到 time 字段（秒数，从转写时间戳取）。
- 语气专业、友善、直指要害；优点也要具体，不要空话。
- 严格只输出如下结构的 JSON（不要 markdown 代码块，不要任何其他文字）：
${schema}`

  return [
    {
      role: 'system',
      content: `你是资深的中文朗读与演讲教练，有十年舞台表达和播音教学经验。你根据语音转写文本、声学指标${alignmentSummary ? '、参考文本对照结果' : ''}给用户专业点评。规则：1) 结论必须有证据；2) 优点具体、不足可改；3) 只输出符合约定结构的 JSON。`,
    },
    { role: 'user', content: user },
  ]
}

function normalizeReport(raw, dims) {
  const num = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)))
  const str = v => String(v ?? '').trim()

  let dimensions = Array.isArray(raw.dimensions) ? raw.dimensions : []
  if (!dimensions.length) dimensions = dims.map(name => ({ name, score: 60, comment: '' }))
  dimensions = dimensions.slice(0, 8).map(d => ({
    name: str(d.name) || '维度',
    score: num(d.score),
    comment: str(d.comment),
  }))

  const pick = (arr, min, max) => {
    const list = Array.isArray(arr) ? arr : []
    return list.slice(0, max).map(x => ({
      title: str(x.title),
      evidence: str(x.evidence),
      suggestion: str(x.suggestion),
      detail: str(x.detail),
      time: Number.isFinite(Number(x.time)) && Number(x.time) >= 0 ? Number(x.time) : null,
    })).filter(x => x.title)
  }

  return {
    totalScore: num(raw.totalScore),
    summary: str(raw.summary),
    dimensions,
    strengths: pick(raw.strengths, 3, 5),
    weaknesses: pick(raw.weaknesses, 3, 5),
    overallAdvice: str(raw.overallAdvice),
  }
}

// =========================================================
// 云端账号（data/accounts/<id>.json，多端同步；只存报告文本，不存音频）
// =========================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data', 'accounts')
fs.mkdirSync(DATA_DIR, { recursive: true })

// 防 path traversal
const validCloudId = id => /^[A-Za-z0-9_-]{1,32}$/.test(String(id))
const accountFile = id => path.join(DATA_DIR, `${id}.json`)

function readCloudAccount(id) {
  try {
    return JSON.parse(fs.readFileSync(accountFile(id), 'utf8'))
  } catch {
    return null
  }
}

function writeCloudAccount(data) {
  // 原子写：先写临时文件再改名，防止写一半损坏
  const file = accountFile(data.id)
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(file + '.tmp', file)
}

/** 记录白名单字段（隔离 audio 等大字段） */
function sanitizeRecord(r) {
  return {
    id: Number(r.id) || 0,
    date: String(r.date || ''),
    mode: String(r.mode || 'general'),
    modeLabel: String(r.modeLabel || ''),
    durationSec: Number(r.durationSec) || 0,
    totalScore: Number(r.totalScore) || 0,
    summary: String(r.summary || ''),
    report: r.report && typeof r.report === 'object' ? r.report : null,
  }
}

app.get('/api/accounts', (req, res) => {
  const list = []
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue
    const a = readCloudAccount(f.slice(0, -5))
    if (a) list.push({ id: a.id, name: a.name, count: a.records.length, updatedAt: a.updatedAt })
  }
  res.json({ accounts: list })
})

app.get('/api/accounts/:id', (req, res) => {
  if (!validCloudId(req.params.id)) return res.status(400).json({ error: '非法账号 id' })
  const a = readCloudAccount(req.params.id)
  if (!a) return res.status(404).json({ error: '云端账号不存在' })
  res.json({ account: { id: a.id, name: a.name, createdAt: a.createdAt }, records: a.records })
})

app.post('/api/accounts', (req, res) => {
  try {
    const account = req.body?.account || {}
    const id = account.id
    if (!validCloudId(id)) return res.status(400).json({ error: '非法账号 id' })
    const incoming = (Array.isArray(req.body?.records) ? req.body.records : [])
      .map(sanitizeRecord)
      .filter(r => r.id && r.report)
    const existing = readCloudAccount(id) || {
      id,
      name: account.name || '未命名',
      createdAt: account.createdAt || new Date().toISOString(),
      records: [],
      updatedAt: 0,
    }
    // 记录按 id 并集合并，同 id 以传入为准；账号名取 updatedAt 较新的一方
    const merged = new Map(existing.records.map(r => [r.id, r]))
    for (const r of incoming) merged.set(r.id, r)
    const records = [...merged.values()].sort((a, b) => a.id - b.id).slice(-200)
    const name = account.name && (account.updatedAt ?? 0) >= (existing.updatedAt ?? 0)
      ? account.name
      : existing.name
    writeCloudAccount({ id, name, createdAt: existing.createdAt, updatedAt: Date.now(), records })
    res.json({ ok: true, count: records.length })
  } catch (err) {
    console.error('[accounts:post]', err)
    res.status(500).json({ error: '保存失败：' + err.message })
  }
})

app.delete('/api/accounts/:id', (req, res) => {
  if (!validCloudId(req.params.id)) return res.status(400).json({ error: '非法账号 id' })
  const file = accountFile(req.params.id)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  res.json({ ok: true })
})

// =========================================================
// 文本工具
// =========================================================
const FILLER_WORDS = [
  '嗯', '呃', '那个', '这个', '然后', '就是说', '怎么说', '对吧', '是不是',
  '其实', '那么', '反正', '等于说', 'basically', 'you know', 'i mean', 'like',
]

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countFillers(text) {
  const t = text.toLowerCase()
  return FILLER_WORDS
    .map(w => {
      const m = t.match(new RegExp(escapeReg(w), 'g'))
      return m ? { word: w, count: m.length } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
}

function normText(s) {
  return String(s).replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

/** 按中英文句末标点分句 */
function splitSentences(text) {
  const parts = String(text)
    .split(/(?<=[。！？!?；;\n])/)
    .map(s => s.trim())
    .filter(Boolean)
  // 过短的碎片并入前句
  const merged = []
  for (const p of parts) {
    if (merged.length && normText(p).length < 4) merged[merged.length - 1] += p
    else merged.push(p)
  }
  return merged
}

/** 编辑距离相似度 0~1 */
function similarity(a, b) {
  const m = a.length, n = b.length
  if (!m && !n) return 1
  if (!m || !n) return 0
  let prev = new Array(n + 1).fill(0).map((_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return 1 - prev[n] / Math.max(m, n)
}

/**
 * 朗读模式：参考文本句 与 转写句 做全局对齐（类 Needleman-Wunsch）。
 * 返回 sentences: [{text, start, end, refText, status}]
 * status: correct | wrong | missed(漏读) | extra(多读)
 */
function alignSentences(refText, hypSegments) {
  const refs = splitSentences(refText).map(s => ({ raw: s, norm: normText(s) })).filter(r => r.norm)
  const hyps = hypSegments.map(s => ({ ...s, norm: normText(s.text) })).filter(h => h.norm)

  const M = refs.length, N = hyps.length
  const GAP = 1, MATCH_COST = 2
  const dp = Array.from({ length: M + 1 }, () => new Array(N + 1).fill(Infinity))
  dp[0][0] = 0
  for (let i = 0; i <= M; i++) {
    for (let j = 0; j <= N; j++) {
      if (i === 0 && j === 0) continue
      let best = Infinity
      if (i > 0) best = Math.min(best, dp[i - 1][j] + GAP)
          if (j > 0) best = Math.min(best, dp[i][j - 1] + GAP)
      if (i > 0 && j > 0) {
        const sim = similarity(refs[i - 1].norm, hyps[j - 1].norm)
        best = Math.min(best, dp[i - 1][j - 1] + (1 - sim) * MATCH_COST)
      }
      dp[i][j] = best
    }
  }

  // 回溯
  const pairs = []
  let i = M, j = N
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const sim = similarity(refs[i - 1].norm, hyps[j - 1].norm)
      if (Math.abs(dp[i][j] - (dp[i - 1][j - 1] + (1 - sim) * MATCH_COST)) < 1e-9) {
        pairs.push({ ref: refs[i - 1], hyp: hyps[j - 1], sim })
        i--; j--
        continue
      }
    }
    if (i > 0 && Math.abs(dp[i][j] - (dp[i - 1][j] + GAP)) < 1e-9) {
      pairs.push({ ref: refs[i - 1], hyp: null })
      i--
      continue
    }
    pairs.push({ ref: null, hyp: hyps[j - 1] })
    j--
  }
  pairs.reverse()

  const sentences = pairs.map(({ ref, hyp, sim }) => {
    if (ref && hyp) {
      return {
        text: hyp.text, start: hyp.start, end: hyp.end,
        refText: ref.raw,
        status: sim >= 0.95 ? 'correct' : 'wrong',
      }
    }
    if (ref) return { text: '', start: null, end: null, refText: ref.raw, status: 'missed' }
    return { text: hyp.text, start: hyp.start, end: hyp.end, refText: null, status: 'extra' }
  })
  return { sentences }
}

function buildAlignmentSummary({ sentences }) {
  const missed = sentences.filter(s => s.status === 'missed')
  const wrong = sentences.filter(s => s.status === 'wrong')
  const extra = sentences.filter(s => s.status === 'extra')
  const correct = sentences.filter(s => s.status === 'correct')
  const total = sentences.filter(s => s.status !== 'extra').length || 1
  const lines = [
    `- 读对：${correct.length}/${total} 句；读错（含明显增删字）：${wrong.length} 句；漏读：${missed.length} 句；多读：${extra.length} 句`,
  ]
  if (wrong.length) {
    lines.push('- 读错的句子（原文 -> 实际朗读）：')
    wrong.slice(0, 10).forEach(s => lines.push(`  · "${s.refText}" -> "${s.text}"`))
  }
  if (missed.length) {
    lines.push('- 漏读的句子：')
    missed.slice(0, 10).forEach(s => lines.push(`  · "${s.refText}"`))
  }
  if (extra.length) {
    lines.push(`- 多读的句子 ${extra.length} 句，例如：`)
    extra.slice(0, 5).forEach(s => lines.push(`  · "${s.text}"`))
  }
  return lines.join('\n')
}

// =========================================================
export { alignSentences, splitSentences, countFillers, similarity, normalizeAsr }

if (!process.env.NO_LISTEN) {
  app.listen(PORT, () => {
    console.log(`ListenToMe 已启动: http://localhost:${PORT}`)
    console.log(`  ASR : ${ASR_API_KEY ? ASR_BASE_URL + ' (' + ASR_MODEL + ')' : '❌ 未配置 ASR_API_KEY'}`)
    console.log(`  LLM : ${LLM_API_KEY ? LLM_BASE_URL + ' (' + LLM_MODEL + ')' : '❌ 未配置 DEEPSEEK_API_KEY'}`)
  })
}
