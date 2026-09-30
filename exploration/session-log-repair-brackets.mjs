// Repair the pre-v0.6.3 bracket-order corruption in any v4 session log:
// an idle-path `compaction/start` (owner turn null) opened BEFORE the summary
// call, so a `turn/start` that arrived during the summary landed inside the
// bracket -> `SessionFormatError: turn/start crosses an open compaction`.
//
// Fix per violating bracket: rotate `compaction/start` forward to immediately
// before its matching `compaction/summary` and name the owner turn recorded by
// `compaction/end`. The bracket then reads start -> summary -> checkpoint -> end
// with no turn/step event inside, which is the shape
// session-format-v3-to-v4/relationships.ts requires.
//
// Every seq reference is remapped through the field inventory of
// session-format-v3-to-v4/src/references.ts, and the output is re-checked
// (dense seqs + byte-exact JSON round trip). Untouched zstd frames are copied
// verbatim; only frames holding edited lines are re-encoded.
//
// Usage:
//   node exploration/session-log-repair-brackets.mjs <in.zstd> <out.zstd>
//   node exploration/session-log-repair-brackets.mjs <in.zstd> <out.zstd> --apply-turn
// The owner turn is always rewritten; the flag is accepted for symmetry and
// future opt-out.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const SRC = process.argv[2]
const OUT = process.argv[3]
if (!SRC || !OUT) throw new Error('usage: node session-log-repair-brackets.mjs <in.zstd> <out.zstd>')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function splitFrames(raw) {
  const frames = []
  let off = 0
  while (off < raw.length) {
    const at = raw.indexOf(MAGIC, off + 1)
    frames.push(raw.subarray(off, at === -1 ? raw.length : at))
    if (at === -1) break
    off = at
  }
  return frames
}

const raw = readFileSync(SRC)
const frames = splitFrames(raw)
const lines = []
const lineFrame = []
let remainder = ''
let splitSeen = false
frames.forEach((frame, frameIndex) => {
  let text = ''
  try { text = zstdDecompressSync(frame).toString('utf8') } catch { text = '' }
  const chunk = remainder + text
  const parts = chunk.split('\n')
  remainder = parts.pop() ?? ''
  if (remainder !== '' && frameIndex !== frames.length - 1) splitSeen = true
  for (const part of parts) if (part !== '') { lines.push(part); lineFrame.push(frameIndex) }
})
if (remainder !== '') throw new Error('trailing text without newline')

const header = JSON.parse(lines[0])
if (header.type !== 'session' || header.version !== 4) throw new Error('not a v4 session log')
const events = lines.slice(1).map((line) => JSON.parse(line))
if (!events.every((e, i) => e.seq === i)) throw new Error('log is not dense before repair')
console.log(`decoded: session=${header.id} frames=${frames.length} events=${events.length} lineSplitAcrossFrames=${splitSeen}`)

// --- detect violating brackets ----------------------------------------------
const byCid = new Map()
for (let i = 0; i < events.length; i += 1) {
  const e = events[i]
  if (e.type !== 'compaction/start' || e.data === null || typeof e.data !== 'object') continue
  const list = byCid.get(e.data.compactionId) ?? []
  list.push(i)
  byCid.set(e.data.compactionId, list)
}

const rotations = []
for (const [cid, starts] of byCid) {
  if (starts.length !== 1) throw new Error(`compactionId ${cid} has ${starts.length} start events`)
  const start = starts[0]
  const summary = events.findIndex((e, i) => i > start && e.type === 'compaction/summary' && e.data?.compactionId === cid)
  const end = events.findIndex((e, i) => i > start && e.type === 'compaction/end' && e.data?.compactionId === cid)
  if (summary === -1 || end === -1 || end < summary) continue
  const inside = events.slice(start + 1, end)
  if (!inside.some((e) => /^(turn|step)\//.test(e.type))) continue
  // The checkpoint must sit between the summary and the close, so the rotated
  // bracket ends up as start -> summary -> checkpoint -> end.
  const between = events.slice(summary + 1, end)
  if (between.length !== 1 || between[0].type !== 'user/message') {
    throw new Error(`bracket ${cid} has an unexpected tail between summary and end: ${between.map((e) => e.type).join(',')}`)
  }
  const ownerTurn = events[end].data?.turn
  if (ownerTurn === null || ownerTurn === undefined) throw new Error(`bracket ${cid} closes without an owner turn`)
  rotations.push({ cid, start, summary, end, ownerTurn })
}
if (rotations.length === 0) {
  console.log('no violating bracket found; nothing to repair')
  process.exit(0)
}
rotations.sort((a, b) => a.start - b.start)
for (const r of rotations) {
  console.log(`  rotate compaction/start ${r.start} -> ${r.summary} (owner turn ${r.ownerTurn}, cid ${r.cid})`)
}
for (let i = 1; i < rotations.length; i += 1) {
  if (rotations[i].start <= rotations[i - 1].summary) throw new Error('overlapping rotations')
}

// --- permutation + reference remap ------------------------------------------
const mapping = new Map()
for (const r of rotations) {
  // Insert `start` immediately BEFORE the summary: it lands on summary-1 while
  // the events it jumps over (start+1 .. summary-1) each shift down by one.
  // The summary itself and everything after keep their seq.
  const target = r.summary - 1
  if (target < r.start) throw new Error(`bracket ${r.cid} has no room to rotate (start ${r.start}, summary ${r.summary})`)
  mapping.set(r.start, target)
  for (let s = r.start + 1; s <= target; s += 1) mapping.set(s, s - 1)
}
const remap = (value) => (typeof value === 'number' && mapping.has(value) ? mapping.get(value) : value)
const ownerOf = new Map(rotations.map((r) => [r.cid, r.ownerTurn]))

const target = new Array(events.length).fill(undefined)
for (let old = 0; old < events.length; old += 1) target[mapping.has(old) ? mapping.get(old) : old] = old
if (target.some((item) => item === undefined)) throw new Error('permutation is not a bijection')

const changed = []
const modified = new Set()
let referenced = 0
const newEvents = target.map((oldSeq, newSeq) => {
  const source = events[oldSeq]
  const data = source.data
  let nextData = data
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const copy = { ...data }
    let touched = false
    if (source.type === 'compaction/start' && ownerOf.has(copy.compactionId)) {
      copy.turn = ownerOf.get(copy.compactionId)
      touched = true
    }
    if (typeof copy.sourceEventSeq === 'number' && mapping.has(copy.sourceEventSeq)) { copy.sourceEventSeq = remap(copy.sourceEventSeq); touched = true }
    if (copy.shadowedRange !== null && typeof copy.shadowedRange === 'object' && !Array.isArray(copy.shadowedRange)) {
      const range = { ...copy.shadowedRange, start: remap(copy.shadowedRange.start), end: remap(copy.shadowedRange.end) }
      if (range.start !== copy.shadowedRange.start || range.end !== copy.shadowedRange.end) { copy.shadowedRange = range; touched = true }
    }
    for (const key of ['shadowedSeqs', 'messageSeqs']) {
      if (Array.isArray(copy[key])) {
        const next = copy[key].map(remap)
        if (next.some((v, i) => v !== copy[key][i])) { copy[key] = next; touched = true }
      }
    }
    if (Array.isArray(copy.targets)) {
      let any = false
      const next = copy.targets.map((item) => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item) && mapping.has(item.seq)) { any = true; return { ...item, seq: remap(item.seq) } }
        return item
      })
      if (any) { copy.targets = next; touched = true }
    }
    if (touched) nextData = copy
  }
  const out = { ...source, seq: newSeq, data: nextData }
  let refTouched = false
  if (Array.isArray(source.sourceEventSeqs)) {
    const next = source.sourceEventSeqs.map(remap)
    if (next.some((v, i) => v !== source.sourceEventSeqs[i])) { out.sourceEventSeqs = next; referenced += 1; refTouched = true }
  }
  const surface = source.surfaceOp
  if (surface !== undefined && surface !== null && surface !== 'append' && typeof surface === 'object') {
    const next = { ...surface, startSeq: remap(surface.startSeq), endSeq: remap(surface.endSeq) }
    if (next.startSeq !== surface.startSeq || next.endSeq !== surface.endSeq) { out.surfaceOp = next; referenced += 1; refTouched = true }
  }
  if (oldSeq !== newSeq) changed.push(`${source.type} ${oldSeq}->${newSeq}`)
  if (oldSeq !== newSeq || refTouched || nextData !== data) modified.add(newSeq)
  return out
})
console.log(`moved ${changed.length} event(s); reference-bearing events rewritten: ${referenced}`)

// --- rebuild lines ----------------------------------------------------------
const newLines = [lines[0]]
for (let i = 0; i < newEvents.length; i += 1) {
  newLines.push(modified.has(i) ? JSON.stringify(newEvents[i]) : lines[i + 1])
}

// --- encode (preserve untouched frames byte-for-byte) -----------------------
const editedFrames = new Set()
for (let i = 0; i < newLines.length; i += 1) {
  if (newLines[i] !== lines[i]) editedFrames.add(lineFrame[i])
}
let output
if (!splitSeen) {
  const byFrame = new Map()
  for (let i = 0; i < newLines.length; i += 1) {
    const frameIndex = lineFrame[i]
    if (!byFrame.has(frameIndex)) byFrame.set(frameIndex, [])
    byFrame.get(frameIndex).push(newLines[i])
  }
  const chunks = []
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frameLines = byFrame.get(frameIndex)
    chunks.push(frameLines === undefined || !editedFrames.has(frameIndex)
      ? frames[frameIndex]
      : zstdCompressSync(Buffer.from(`${frameLines.join('\n')}\n`, 'utf8')))
  }
  output = Buffer.concat(chunks)
  console.log(`encoded: preserved ${frames.length - editedFrames.size}/${frames.length} frames verbatim, re-encoded ${editedFrames.size}`)
} else {
  const chunks = [zstdCompressSync(Buffer.from(`${newLines[0]}\n`, 'utf8'))]
  for (const line of newLines.slice(1)) chunks.push(zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))
  output = Buffer.concat(chunks)
  console.log(`encoded: one frame per line (${chunks.length} frames)`)
}

// --- self-check -------------------------------------------------------------
const back = []
for (const frame of splitFrames(output)) {
  const text = zstdDecompressSync(frame).toString('utf8')
  for (const part of text.split('\n')) if (part !== '') back.push(part)
}
if (back.length !== newLines.length) throw new Error(`self-check: line count ${back.length} != ${newLines.length}`)
if (back[0] !== newLines[0]) throw new Error('self-check: header differs')
const backEvents = back.slice(1).map((line) => JSON.parse(line))
const mismatched = backEvents.findIndex((event, i) => JSON.stringify(event) !== JSON.stringify(newEvents[i]))
if (mismatched !== -1) throw new Error(`self-check: event ${mismatched} round-trip differs`)
if (!backEvents.every((e, i) => e.seq === i)) throw new Error('self-check: output is not dense')
console.log(`self-check: round-trip identical, dense 0..${backEvents.length - 1} ✓`)

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, output)
console.log(`wrote ${OUT} (${output.length} bytes; original ${raw.length})`)
