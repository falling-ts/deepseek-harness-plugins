'use strict'
// Walk concatenated zstd frames (magic FF ED BD 28 big-endian) in the raw
// session file and decode every frame. Decoded payloads are concatenated;
// we then split into logical JSONL lines and audit fc-compact events.
import fs from 'node:fs'
import zlib from 'node:zlib'

const p = process.argv[2]
if (!p) {
  console.error('usage: fcwalk.mjs <session.jsonl.zstd>')
  process.exit(2)
}
const buf = fs.readFileSync(p)
const BE_MAGIC = 0x28b52ffd

let off = 0
let frameNo = 0
const all = []
while (off + 4 <= buf.length) {
  const magic = buf.readUInt32LE(off)
  if (magic !== BE_MAGIC) {
    if (off > 0) break
    console.log('bad top-level magic:', buf.subarray(0, 8).toString('hex'))
    process.exit(1)
  }
  frameNo++
  let inner = off + 4
  inner += 1 // Window_Descriptor byte
  const hdrDesc = buf[inner]
  inner += 1
  const dictIdFlag = (hdrDesc >> 6) & 0b1
  const dlField = (hdrDesc >> 3) & 0b11
  const fcsFlag = (hdrDesc >> 1) & 0b11
  let extraLen = 0
  if (dictIdFlag) {
    const dlLen = [0, 1, 2, 4][dlField]
    extraLen += dlLen
  }
  // FCS_Field: length depends on window-size + fcsFlag — approximated by
  // locating the next frame magic or EOF and trusting the decoder to tell us
  // where it stopped. We pass the whole tail and rely on zstdDecompressSync
  // accepting only valid prefixes (it will reject trailing garbage).
  let next = -1
  for (let j = inner + extraLen + 4; j + 4 <= buf.length; j += 1) {
    if (buf.readUInt32LE(j) === BE_MAGIC) { next = j; break }
  }
  let sliceEnd = next === -1 ? buf.length : next
  // Shrink sliceEnd until decode succeeds (the FCS_Field may eat more bytes)
  let lo = inner
  let hi = sliceEnd
  let decOk = null
  let tries = 0
  while (lo <= hi) {
    const mid = (lo + hi + 1) >>> 1
    const dec = zlib.zstdDecompressSync(buf.subarray(off, mid))
    decOk = dec
    lo = mid
    tries++
  }
  if (tries === 0) {
    // No valid prefix found — likely this IS the last frame and everything
    // up to EOF is its content.
    decOk = zlib.zstdDecompressSync(buf.subarray(off, sliceEnd))
  }
  all.push(Buffer.from(decOk))
  console.log('frame', frameNo, 'range [' + off + ', ' + sliceEnd + ') ->', decOk.length, 'decoded bytes')
  off = sliceEnd
}
const joined = Buffer.concat(all)
const text = joined.toString('utf8')
const lines = text.split(/\r?\n/).filter(Boolean)
console.log('total decoded bytes:', joined.length, 'lines:', lines.length)
let maxSeq = -1
const fc = []
let parseErrors = 0
lines.forEach((line, i) => {
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    parseErrors++
    return
  }
  const e = rec && rec.event ? rec.event : rec
  if (typeof e.seq === 'number') maxSeq = Math.max(maxSeq, e.seq)
  if (typeof e.type === 'string' && e.type.startsWith('fc-compact')) {
    fc.push({ lineNo: i + 1, seq: e.seq, type: e.type, ignorable: e.ignorable })
  }
})
console.log('parseErrors:', parseErrors, 'maxSeq:', maxSeq)
console.log('fc-compact events:', fc.length)
for (const f of fc) {
  console.log(`  line ${f.lineNo}  seq=${f.seq}  ${f.type}  ignorable=${JSON.stringify(f.ignorable)}`)
}
console.log('MISSING ignorable:true:', fc.filter((f) => f.ignorable !== true).length)
