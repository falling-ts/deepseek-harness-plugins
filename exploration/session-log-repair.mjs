// Repair session-ed8e0108: move the mis-ordered compaction bracket inside turn 22.
//
// Violation: seq 4360 `compaction/start` (turn:null) with seq 4362 `turn/start` inside it.
// Fix: rotate `compaction/start` from 4360 to 4365, so the block becomes
//   spliced, turn/start, spliced, step/start, user/message, start(22), summary, checkpoint, end
// which satisfies session-format-v3-to-v4 relationships: no turn/* inside an open
// bracket, and both bracket ends carry owner turn 22.
//
// References are remapped through exactly the field inventory of
// session-format-v3-to-v4/src/references.ts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const SRC = process.argv[2]
const OUT = process.argv[3]
if (!SRC || !OUT) throw new Error('usage: node fc-repair.mjs <in.v4.jsonl.zstd> <out.v4.jsonl.zstd>')
const SESSION_ID = 'session-ed8e0108-b7a2-4146-9ddb-857fd28caefb'
const CID = 'fc-904d9bfe-33a2-4d5b-bcd9-5327c20ed0c1'
const START_OLD = 4360
const MOVE_TO = 4365
const OWNER_TURN = 22

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

// --- decode, keeping which frame produced which line -------------------------
const raw = readFileSync(SRC)
const frames = splitFrames(raw)
const lines = []          // complete lines, in order
const lineFrame = []      // frame index of each complete line
let remainder = ''        // text of a frame that did not end on a newline
let remainderFrame = -1
let splitSeen = false
frames.forEach((frame, frameIndex) => {
  let text = ''
  try { text = zstdDecompressSync(frame).toString('utf8') } catch { text = '' }
  const chunk = remainder + text
  const parts = chunk.split('\n')
  remainder = parts.pop() ?? ''
  remainderFrame = frameIndex
  if (remainder !== '' && frameIndex !== frames.length - 1) splitSeen = true
  for (const part of parts) if (part !== '') { lines.push(part); lineFrame.push(frameIndex) }
})
if (remainder !== '') throw new Error('trailing text without newline')

const header = JSON.parse(lines[0])
const events = lines.slice(1).map(line => JSON.parse(line))
console.log(`decoded: frames=${frames.length} lines=${lines.length} events=${events.length} lineSplitAcrossFrames=${splitSeen}`)

// --- preflight ---------------------------------------------------------------
const fail = (msg) => { throw new Error(`preflight: ${msg}`) }
if (header.type !== 'session' || header.version !== 4 || header.id !== SESSION_ID) fail('unexpected header')
if (!events.every((e, i) => e.seq === i)) fail('log is not dense before repair')
const at = (n) => events[n]
if (at(4359).type !== 'turn/end' || at(4359).data.turn !== 21) fail('4359 is not turn/end 21')
if (at(4360).type !== 'compaction/start' || at(4360).data.compactionId !== CID || at(4360).data.turn !== null) fail('4360 is not the empty-owner bracket open')
if (at(4362).type !== 'turn/start' || at(4362).data.turn !== 22) fail('4362 is not turn/start 22')
if (at(4365).type !== 'user/message') fail('4365 is not the user message')
if (at(4366).type !== 'compaction/summary' || at(4366).data.compactionId !== CID) fail('4366 is not the matching summary')
if (at(4367).type !== 'user/message' || at(4367).data.id === undefined) fail('4367 is not the checkpoint')
if (at(4368).type !== 'compaction/end' || at(4368).data.turn !== 22) fail('4368 is not compaction/end 22')
if (at(4367).sourceEventSeqs[0] !== 4360 || at(4367).sourceEventSeqs[1] !== 4366) fail('checkpoint sourceEventSeqs prefix is not [start, summary]')
if (!(at(4367).surfaceOp.op === 'replace' && at(4367).surfaceOp.startSeq === 4208 && at(4367).surfaceOp.endSeq === 4272)) fail('checkpoint surfaceOp is not 4208..4272')

// --- permutation + reference remap ------------------------------------------
const moved = new Set()
for (let s = START_OLD; s <= MOVE_TO; s += 1) moved.add(s)
const mapping = new Map()
for (const s of moved) mapping.set(s, s === START_OLD ? MOVE_TO : s - 1)
const remap = (value) => (typeof value === 'number' && mapping.has(value) ? mapping.get(value) : value)

const target = new Array(events.length).fill(undefined)
for (let old = 0; old < events.length; old += 1) target[mapping.has(old) ? mapping.get(old) : old] = old
if (target.some(item => item === undefined)) throw new Error('permutation is not a bijection')

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
    if (source.type === 'compaction/start' && copy.compactionId === CID) {
      // The transaction committed while turn 22 was open (`compaction/end` already
      // records turn 22); the relocated bracket must name that same owner.
      copy.turn = OWNER_TURN
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
      const next = copy.targets.map(item => {
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
console.log(`moved: ${changed.join(', ')}`)
console.log(`reference-bearing events rewritten: ${referenced}`)

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

// --- self-check: decode the output and compare against the intent -----------
const back = []
for (const frame of splitFrames(output)) {
  const text = zstdDecompressSync(frame).toString('utf8')
  for (const part of text.split('\n')) if (part !== '') back.push(part)
}
if (back.length !== newLines.length) throw new Error(`self-check: line count ${back.length} != ${newLines.length}`)
const backEvents = back.slice(1).map(line => JSON.parse(line))
if (JSON.stringify(back.slice(0, 1)) !== JSON.stringify(newLines.slice(0, 1))) throw new Error('self-check: header differs')
const mismatched = backEvents.findIndex((event, i) => JSON.stringify(event) !== JSON.stringify(newEvents[i]))
if (mismatched !== -1) {
  const expected = JSON.stringify(newEvents[mismatched])
  const actual = JSON.stringify(backEvents[mismatched])
  let at = 0
  while (at < expected.length && expected[at] === actual[at]) at += 1
  const lineIndex = mismatched + 1
  console.error(`DEBUG mismatch at event ${mismatched} (line ${lineIndex}, frame ${lineFrame[target[mismatched - 1] + 1]}, edited=${editedFrames.has(lineFrame[target[mismatched - 1] + 1])}, intendedOldSeq=${target[mismatched]})`)
  console.error(`  expected: …${expected.slice(Math.max(0, at - 60), at + 80)}`)
  console.error(`  actual  : …${actual.slice(Math.max(0, at - 60), at + 80)}`)
  throw new Error(`self-check: event ${mismatched} round-trip differs`)
}
if (!backEvents.every((e, i) => e.seq === i)) throw new Error('self-check: output is not dense')
console.log('self-check: round-trip identical, dense 0..%d ✓', backEvents.length - 1)
console.log(`events at 4360..4368: ${backEvents.slice(4360, 4369).map(e => `${e.seq}:${e.type.replace('compaction/', 'c/')}${e.data?.turn !== undefined ? `(t${e.data.turn})` : ''}`).join(' ')}`)

mkdirSync(process.argv[4] ?? '.', { recursive: true })
writeFileSync(OUT, output)
console.log(`wrote ${OUT} (${output.length} bytes; original ${raw.length})`)
