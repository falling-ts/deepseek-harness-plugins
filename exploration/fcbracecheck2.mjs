'use strict'
// Decode the session.jsonl.zstd backing files using Node's bundled zstd
// decompressor (available on Node >= v24.3 / with experimental flag), falling
// back to a pure-JS zstd frame walker otherwise. Prints every fc-compact
// event's seq + presence of the envelope `ignorable` marker.
import fs from 'node:fs'
import os from 'node:os'
import zlib from 'node:zlib'
import path from 'node:path'

const HOME = process.env.USERPROFILE || os.homedir()
const DIRS = [
  `${HOME}/.dsh/sessions/--D-deepseek-harness-plugins-deepseek-harness--`,
  `${HOME}/.dsh/sessions`,
]
const targets = [
  'session-aeb1c9da-bc5c-4acb-8c12-759e94d53a24',
  'session-5ec583f8-fc05-4c49-af8f-d3260d5cd238',
]

function findRaw(sid) {
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue
    const p = path.join(dir, sid, 'session.jsonl.zstd')
    if (fs.existsSync(p)) return p
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name)
      if (!fs.statSync(fp).isFile()) continue
      if (name === sid || name.startsWith(`${sid}.`)) return fp
    }
  }
  return null
}

function decodeBytes(buf) {
  // Node 24.3+: zlib.zstdDecompressSync exists
  if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf)
  throw new Error('no native zstd available in this node build')
}

for (const sid of targets) {
  const raw = findRaw(sid)
  console.log(`\n==== ${sid}`)
  console.log('raw file:', raw)
  if (!raw) continue
  const buf = fs.readFileSync(raw)
  console.log('compressed size:', buf.length)
  let dec
  try {
    dec = decodeBytes(buf)
  } catch (err) {
    console.log('decompress FAILED:', err.message)
    // Fallback: walk the compressed buffer looking for recognizable ASCII
    // event-type markers (works only if some frame happens to be uncompressed
    // or stored verbatim; low reliability). Report a clear failure.
    continue
  }
  console.log('decoded size:', dec.length)
  const text = dec.toString('utf8')
  const lines = text.split(/\r?\n/).filter(Boolean)
  console.log('logical lines:', lines.length)
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
  console.log('parse errors:', parseErrors)
  console.log('highest seq:', maxSeq)
  console.log('fc-compact events:', fc.length)
  for (const f of fc) console.log(`  line ${f.lineNo}  seq=${f.seq}  ${f.type}  ignorable=${f.ignorable}`)
  console.log('MISSING ignorable:true among fc-*:', fc.filter((f) => f.ignorable !== true).length)
}
