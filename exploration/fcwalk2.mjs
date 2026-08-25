'use strict'
// Robust frame walking: collect every occurrence of the zstd magic bytes
// (28 B5 2F FD), slice between consecutive positions, decode each slice with
// the native decoder, concatenate, and audit the resulting JSONL.
import fs from 'node:fs'
import zlib from 'node:zlib'

const p = process.argv[2]
if (!p) {
  console.error('usage: fcwalk2.mjs <session.jsonl.zstd>')
  process.exit(2)
}
const buf = fs.readFileSync(p)

const magic = [0x28, 0xb5, 0x2f, 0xfd]
function findMagicOffsets() {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
      offsets.push(i)
    }
  }
  return offsets
}
const offs = findMagicOffsets()
console.log('candidate frame starts:', offs.length)
if (offs.length === 0) {
  console.error('no magic found')
  process.exit(1)
}

const parts = []
let decodedTotal = 0
const used = new Array(offs.length).fill(false)
const sortedParts = [] // track by (startOffset, buffer)
for (let k = 0; k < offs.length; k++) {
  const start = offs[k]
  const end = k + 1 < offs.length ? offs[k + 1] : buf.length
  const slice = buf.subarray(start, end)
  let dec
  try {
    dec = zlib.zstdDecompressSync(slice)
  } catch {
    console.log('slice [' + start + ',' + end + ') length ' + slice.length + ' → decode FAILED (skipping)')
    continue
  }
  used[k] = true
  sortedParts.push({ start, dec })
}
sortedParts.sort((a, b) => a.start - b.start)
parts.push(...sortedParts.map((x) => x.dec))
decodedTotal = parts.reduce((sum, b) => sum + b.length, 0)
const joined = Buffer.concat(parts)
const text = joined.toString('utf8')
const lines = text.split(/\r?\n/).filter(Boolean)
console.log('decoded total:', decodedTotal, 'lines:', lines.length)
let maxSeq = -1
let minSeqSeen = Infinity
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
  if (typeof e.seq === 'number') {
    maxSeq = Math.max(maxSeq, e.seq)
    minSeqSeen = Math.min(minSeqSeen, e.seq)
  }
  if (typeof e.type === 'string' && e.type.startsWith('fc-compact')) {
    fc.push({ lineNo: i + 1, seq: e.seq, type: e.type, ignorable: e.ignorable })
  }
})
console.log('minSeq:', minSeqSeen === Infinity ? 'n/a' : minSeqSeen, 'maxSeq:', maxSeq)
console.log('parseErrors:', parseErrors)
console.log('fc-compact events:', fc.length)
for (const f of fc) {
  console.log(`  line ${f.lineNo}  seq=${f.seq}  ${f.type}  ignorable=${JSON.stringify(f.ignorable)}`)
}
console.log('MISSING ignorable:true:', fc.filter((f) => f.ignorable !== true).length)
