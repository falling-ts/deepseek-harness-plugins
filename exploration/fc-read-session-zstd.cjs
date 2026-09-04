// Read a session.jsonl.zstd log: scan zstd frames by magic, decompress each
// with node:zlib zstdDecompressSync, and print an event-structure diagnosis.
const fs = require('fs')
const { zstdDecompressSync } = require('node:zlib')

const FILE = process.argv[2] || 'C:/Users/zghyu/.dsh/sessions/--D-deepseek-harness-plugins--/session-b8dc3649-8d92-4ded-94fe-4c37111a3393/session.jsonl.zstd'
const buf = fs.readFileSync(FILE)
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

function frames(data) {
  const out = []
  let i = 0
  while (i < data.length - 4) {
    if (data[i] === 0x28 && data[i + 1] === 0xB5 && data[i + 2] === 0x2F && data[i + 3] === 0xFD) {
      out.push(i)
    }
    i += 1
  }
  return out
}

function decompressAll(data) {
  const spots = frames(data)
  let text = ''
  if (spots.length === 0) return null
  for (let k = 0; k < spots.length; k += 1) {
    const start = spots[k]
    const end = k + 1 < spots.length ? spots[k + 1] : data.length
    try {
      text += zstdDecompressSync(data.subarray(start, end)).toString('utf8')
    } catch (e) {
      text += `<frame-${k}-error:${e.message}>`
    }
  }
  return text
}

const text = decompressAll(buf)
if (text === null) {
  console.log('NO ZSTD FRAMES FOUND — file may be plaintext?')
  console.log('first bytes:', buf.subarray(0, 40).toString('hex'))
  process.exit(0)
}
const lines = text.split('\n').filter((l) => l.trim().length > 0)
console.log('total lines (events):', lines.length)
const seqs = []
const byType = {}
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  seqs.push(e.seq)
  byType[e.type] = (byType[e.type] || 0) + 1
}
console.log('seq range:', Math.min(...seqs), '..', Math.max(...seqs), '(events sorted?', seqs.every((v, i) => i === 0 || seqs[i] > seqs[i - 1]) + ')')
console.log('event type counts:', JSON.stringify(byType))

// Print the shape of the "你好" turn and a few representative events.
console.log('\n=== turn-5 "你好" area (seq ~42900-43050) ===')
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.seq >= 42890 && e.seq <= 43060 && /user\/message|assistant\/message/.test(e.type)) {
    const d = e.data || {}
    const msg = d.message && typeof d.message === 'object' ? d.message : {}
    const content = d.content !== undefined ? d.content : msg.content
    const blocks = Array.isArray(content) ? content.map((b) => b && b.type + (b.text ? ':' + b.text.slice(0, 60) : b.type ? '' : JSON.stringify(b).slice(0, 80))).join(' | ') : String(content).slice(0, 120)
    console.log(`seq=${e.seq} type=${e.type} contentBlocks=${JSON.stringify(content ? (Array.isArray(content) ? content.map((b) => b && b.type) : 'scalar') : null)}`)
    console.log(`     text: ${blocks}`)
  }
}

// Head events around seq 16..40 (projectRegion's region start)
console.log('\n=== head events seq 12..40 ===')
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.seq >= 12 && e.seq <= 40) {
    console.log(`seq=${e.seq} type=${e.type} dataKeys=${Object.keys(e.data || {}).join(',')}`)
  }
}

// summary: what does the surface around 239K tokens look like? print assistant blocks count
console.log('\n=== assistant/message total blocks/tokens hint ===')
let assistantText = 0
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.type === 'assistant/message') {
    const mc = e.data && e.data.message && e.data.message.content
    if (Array.isArray(mc)) for (const b of mc) if (b && typeof b.text === 'string') assistantText += b.text.length
  }
}
console.log('total assistant text chars (est):', assistantText)