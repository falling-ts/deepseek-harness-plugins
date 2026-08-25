'use strict'
// Dump up to N decoded events from the most recently modified session log in
// ~/.dsh/sessions/, printing seq/type/flags/first ~300 chars of each payload.
// Robust multi-frame decoder: scans raw bytes for the zstd magic
// 28 B5 2F FD, slices between magics, decompresses each slice, sorts by
// source offset, concatenates.
const fs = require('node:fs')
const os = require('node:os')
const zlib = require('node:zlib')
const path = require('node:path')
const cp = require('node:child_process')

function findNewestSessionLog() {
  const dir = path.join(os.homedir(), '.dsh', 'sessions')
  const files = cp.execSync(`dir /b /s "${dir}\\*.zst" 2>nul || true`, { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean)
    .sort((a, b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs } catch { return 0 }
    })
  if (files.length === 0) { console.error('no .zst session logs'); process.exit(2) }
  return files[0]
}

function robustDecode(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frames = []
  let idx = buf.indexOf(MAGIC)
  while (idx >= 0) {
    let next = buf.indexOf(MAGIC, idx + 4)
    const end = next >= 0 ? next : buf.length
    const frame = buf.subarray(idx, end)
    try { frames.push({ off: idx, data: zlib.zstdDecompressSync(frame) }) } catch (err) { /* skip bad slice */ }
    idx = next
  }
  frames.sort((a, b) => a.off - b.off)
  return frames.map(f => f.data).concat(Buffer.alloc(0))
}

function main() {
  const LIMIT = parseInt(process.argv[2] ?? '40', 10)
  const FILE = findNewestSessionLog()
  console.error('=== newest session:', FILE, '===')
  const raw = fs.readFileSync(FILE)
  const decoded = robustDecode(raw)
  let count = 0
  for (const frameBuf of decoded) {
    const lines = frameBuf.toString('utf8').split('\n').filter(l => l.trim())
    for (const line of lines) {
      try {
        const ev = JSON.parse(line)
        const inner = ev.event ?? ev
        const flags = []
        if (inner.ignorable) flags.push('IGNORABLE')
        if (inner.surfaceOp) flags.push(inner.surfaceOp === 'append' ? 'APPEND' : `REPLACE[${inner.surfaceOp.start}..${inner.surfaceOp.end}]`)
        if (Array.isArray(inner.sourceEventSeqs)) flags.push('src=[' + inner.sourceEventSeqs.join(',') + ']')
        const payloadPreview = JSON.stringify(inner.data ?? {}).slice(0, 300)
        console.log(`seq=${String(inner.seq).padStart(5)} t=${inner.time} type=${inner.type}${flags.length ? ' [' + flags.join(' | ') + ']' : ''}\n    ${payloadPreview}${payloadPreview.length >= 300 ? '…' : ''}`)
        count++
        if (count >= LIMIT) return
      } catch (err) { /* skip unparsed lines */ }
    }
  }
}
main()
