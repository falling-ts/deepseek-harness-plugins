'use strict'
// Decode every frame in the target session file, extract the sequence of
// (parsedLineIndex -> {seq}), print runs where seq jumps by != 1, and show
// context around each anomaly.
const fs = require('node:fs')
const zlib = require('node:zlib')

const p = process.argv[2]
const buf = fs.readFileSync(p)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
function magicOffsets(b) {
  const out = []
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] === MAGIC[0] && b[i + 1] === MAGIC[1] && b[i + 2] === MAGIC[2] && b[i + 3] === MAGIC[3]) out.push(i)
  }
  return out
}
const offs = magicOffsets(buf)
console.log('frames:', offs.length)
const slices = []
for (let k = 0; k < offs.length; k++) {
  const start = offs[k]
  const end = k + 1 < offs.length ? offs[k + 1] : buf.length
  let dec
  try {
    dec = zlib.zstdDecompressSync(buf.subarray(start, end))
  } catch {
    continue
  }
  slices.push({ start, end, dec })
}
slices.sort((a, b) => a.start - b.start)
const joined = Buffer.concat(slices.map((s) => s.dec))
const lines = joined.toString('utf8').split('\n').filter(Boolean)
console.log('lines:', lines.length)
const recs = lines.map((l) => {
  let r
  try { r = JSON.parse(l) } catch { r = undefined }
  return r
})
const seqByLine = new Map()
recs.forEach((r, i) => {
  const e = r && r.event ? r.event : r
  if (e && typeof e.seq === 'number' && Number.isSafeInteger(e.seq) && e.seq >= 0) seqByLine.set(i + 1, e.seq)
})
const uniq = new Map()
for (const [line, seq] of seqByLine.entries()) {
  if (!Number.isSafeInteger(seq) || seq < 0) continue
  if (!uniq.has(seq)) uniq.set(seq, line)
}
// Collect per-file-line records; preserve file order for reporting
const seqPerLine = new Map()
recs.forEach((r, i) => {
  const e = r && r.event ? r.event : r
  if (e && typeof e.seq === 'number' && Number.isSafeInteger(e.seq) && e.seq >= 0) seqPerLine.set(i + 1, e.seq)
})
// Keep ALL (line, seq) pairs — chunk types carry multiple seq values within
// one line, and the stream is strictly monotonically increasing in seq
const orderedPairs = [...seqPerLine.entries()].map(([line, seq]) => ({ line, seq }))
let prev = -1
const gaps = []
for (const { line, seq } of orderedPairs) {
  if (seq > prev + 1) {
    const prevRec = recs[line - 2]
    const prevE = prevRec && (prevRec.event || prevRec)
    const curE = (recs[line - 1] || {}).event || (recs[line - 1] || {})
    gaps.push({ line, prevSeq: prev, curSeq: seq, missing: seq - prev - 1, prevType: prevE && prevE.type, curType: curE && curE.type })
  }
  prev = Math.max(prev, seq)
}
console.log('entries:', orderedPairs.length, '| gaps:', gaps.length)
for (const g of gaps.slice(0, 30)) {
  console.log(`line ${g.line}: ${g.prevSeq}(${g.prevType}) -> MISSING ${g.missing} -> ${g.curSeq}(${g.curType})`)
}
if (orderedPairs.length > 0) {
  const firstPair = orderedPairs[0]
  const lastPair = orderedPairs[orderedPairs.length - 1]
  const allSeqs = orderedPairs.map((p) => p.seq)
  console.log('minSeq:', Math.min(...allSeqs), 'maxSeq:', Math.max(...allSeqs))
}
// Report whether any entry has seq LOWER than a previous entry's seq
// (indicates duplicate/non-monotone writes)
let violations = 0
let runningMax = -1
for (const p of orderedPairs) {
  if (p.seq < runningMax) violations++
  runningMax = Math.max(runningMax, p.seq)
}
console.log('out-of-order entries:', violations)
