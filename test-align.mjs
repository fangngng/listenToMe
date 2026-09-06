// 逐字拼音对齐自测：node test-align.mjs
import { alignChars, alignSentences } from './server.js'
import assert from 'node:assert'

// 1. 声调错：上 shàng(4) -> 商 shāng(1)：声母韵母同、声调不同
let cs = alignChars('我在上海学习', '我在商海学习')
assert.equal(cs.filter(c => c.status === 'wrong').length, 1)
assert.equal(cs[2].wrongPart, '声调')

// 2. 声母错：脑 nǎo -> 老 lǎo
cs = alignChars('电脑很卡', '电老很卡')
assert.equal(cs[1].wrongPart, '声母')

// 3. 韵母错：想 xiǎng -> 写 xiě（声调同为 3，只差韵母）
cs = alignChars('我想吃饭', '我写吃饭')
assert.equal(cs[1].wrongPart, '韵母')

// 4. 同音字替代不算错（大概率是 ASR 用字差异）
cs = alignChars('他在做任务', '他在作任务')
assert.ok(cs.every(c => c.status === 'ok'))

// 5. 漏读：参考 6 字只读到 5 字
cs = alignChars('我在上海学习', '我在上海学')
assert.equal(cs.filter(c => c.status === 'missed').length, 1)

// 6. 句级集成：单字错音让句子判 wrong，chars 挂在句上
const { sentences } = alignSentences('我在上海学习。',
  [{ start: 0, end: 5, text: '我在商海学习。' }])
assert.equal(sentences[0].status, 'wrong')
assert.equal(sentences[0].chars.length, 6)

console.log('ALIGN_OK')
process.exit(0)
