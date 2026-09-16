/**
 * comfy-pwsh-output-probe.mjs — why can't the user see pwsh command OUTPUT in the
 * Comfy sessions? Reads the raw session logs on disk and answers:
 *   1. are `tool/result` events present for every `tool/call`?
 *   2. does each tool/result actually CARRY the command output text, and how long?
 *   3. what does the stored payload look like (field path to the text)?
 *
 * Run: node exploration/comfy-pwsh-output-probe.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(homedir(), '.dsh', 'sessions', '--D-Comfy--')

function decompressAll(buf) {
  const spots = []
  for (let i = 0; i < buf.length - 4; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) spots.push(i)
  }
  if (spots.length === 0) return null
  let text = ''
  for (let k = 0; k < spots.length; k += 1) {
    const start = spots[k]
    const end = k + 1 < spots.length ? spots[k + 1] : buf.length
    try { text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8') } catch { /* partial frame */ }
  }
  return text
}

function readEvents(file) {
  const text = decompressAll(readFileSync(file))
  if (text === null) return []
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { out.push(JSON.parse(line)) } catch { /* torn line */ }
  }
  return out
}

/** Pull the tool output text out of a tool/result event, guessing the known shapes. */
function resultText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block && typeof block === 'object' && 'content' in block) {
      const c = block.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('')
    }
  }
  return null
}

const dirs = existsSync(ROOT) ? readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []
console.log(`Comfy 会话目录: ${ROOT}`)
console.log(`会话数: ${dirs.length}\n`)

for (const name of dirs) {
  const dir = join(ROOT, name)
  const files = readdirSync(dir).filter((f) => /^session.*\.jsonl(\.zstd)?$/u.test(f))
  for (const f of files) {
    const events = readEvents(join(dir, f))
    if (events.length === 0) continue
    const byType = {}
    for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1
    const calls = events.filter((e) => e.type === 'tool/call')
    const results = events.filter((e) => e.type === 'tool/result')
    const pwshCalls = calls.filter((e) => JSON.stringify(e.data ?? {}).includes('pwsh'))

    console.log(`\n===== ${name}  (${f}, ${events.length} events) =====`)
    console.log('  type 分布 top:', Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join('  '))
    console.log(`  tool/call=${calls.length}  tool/result=${results.length}  含"pwsh"的 call=${pwshCalls.length}`)

    const lens = []
    let withText = 0
    let sample = null
    for (const r of results) {
      const t = resultText(r)
      if (t === null) continue
      withText += 1
      lens.push(t.length)
      if (sample === null && t.length > 0) sample = { seq: r.seq, len: t.length, head: t.slice(0, 220).replace(/\s+/gu, ' ') }
    }
    console.log(`  result 里能取到文本的: ${withText}/${results.length}`)
    if (lens.length > 0) {
      lens.sort((a, b) => a - b)
      console.log(`  文本长度: min=${lens[0]} median=${lens[Math.floor(lens.length / 2)]} max=${lens[lens.length - 1]}`)
    }
    if (sample !== null) console.log(`  样例 (seq=${sample.seq}, len=${sample.len}): ${sample.head}`)
    const empty = results.filter((r) => { const t = resultText(r); return t === null || t.length === 0 })
    console.log(`  空/取不到文本的 result: ${empty.length}`)
    if (empty.length > 0) console.log('  第一个空 result 的 data 结构:', JSON.stringify(empty[0].data).slice(0, 400))
  }
}
