'use strict'
// Dump the first N events from every *.log and *.zst file under
// %USERPROFILE%\.dsh\sessions\ (both formats probed), grouped per file.
const fs = require('node:fs')
const os = require('node:os')
const zlib = require('node:zlib')
const path = require('node:path')
const cp = require('node:child_process')

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.log$|\.zst$|\.zstd$/.test(ent.name)) out.push(p)
  }
  return out
}
function robustDecode(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frames = []
  let idx = buf.indexOf(MAGIC)
  while (idx >= 0) {
    const next = buf.indexOf(MAGIC, idx + 4)
    const frame = buf.subarray(idx, next >= 0 ? next : buf.length)
    try { frames.push({ off: idx, data: zlib.zstdDecompressSync(frame) }) } catch { /* skip */ }
    idx = next
  }
  frames.sort((a, b) => a.off - b.off)
  return frames.flatMap(f => f.data)
}
const DIR = path.join(os.homedir(), '.dsh', 'sessions')
if (!fs.existsSync(DIR)) { console.error('no sessions dir', DIR); process.exit(2) }
const files = walk(DIR).map(p => ({ p, mtime: fs.statSync(p).mtimeMs })).sort((a, b) => b.mtime - a.mtime)
console.error('=== found', files.length, 'session files; dumping up to', Math.min(files.length, 3), 'most recent ===')
for (const { p } of files.slice(0, 3)) {
  const raw = fs.readFileSync(p)
  if (raw.byteLength < 1000) continue
  console.error(`\n########## ${p} ##########`)
  const decoded = /\.zst$|\.zstd$/.test(p) ? robustDecode(raw) : [raw]
  let n = 0
  for (const buf of decoded) {
    for (const line of buf.toString('utf8').split('\n')) {
      const s = line.trim(); if (!s) continue
      let ev
      try { ev = JSON.parse(s) } catch { continue }
      const inner = ev.event ?? ev
      const flags = []
      if (inner.ignorable) flags.push('IGNORED')
      if (inner.surfaceOp) flags.push(inner.surfaceOp === 'append' ? 'APPEND' : `REPL[${inner.surfaceOp.start}..${inner.surfaceOp.end}]`)
      if (Array.isArray(inner.sourceEventSeqs)) flags.push(`SRC[${inner.sourceEventSeqs.join(',')}]`)
      const preview = JSON.stringify(inner.data ?? {}).slice(0, 220)
      console.log(`  seq=${String(inner.seq).padStart(4)} ${inner.type}${flags.length ? ' [' + flags.join('|') + ']' : ''}\n    ${preview}${preview.length >= 220 ? '…' : ''}`)
      n++
      if (n >= 15) break
    }
    if (n >= 15) break
  }
}
