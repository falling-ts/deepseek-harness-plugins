'use strict'
// Scan the raw JSONL backing files of the two affected sessions and report:
// - every fc-compact/* event's seq, whether it carries `ignorable: true`
// - the total event count and highest seq, so we know what a repair must cover.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')

const HOME = process.env.USERPROFILE || os.homedir()
const DIRS = [
  path.join(HOME, '.dsh/sessions/--D-deepseek-harness-plugins-deepseek-harness--'),
  path.join(HOME, '.dsh/sessions'),
]
const targets = ['session-aeb1c9da-bc5c-4acb-8c12-759e94d53a24', 'session-5ec583f8-fc05-4c49-af8f-d3260d5cd238']

function findRaw(sid) {
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue
    const p = path.join(dir, sid, 'session.jsonl.zstd')
    if (fs.existsSync(p)) return p
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name)
      if (!fs.statSync(fp).isFile()) continue
      if (name === sid || name.startsWith(sid + '.')) return fp
    }
  }
  // search subdirs one level down
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const sub of fs.readdirSync(dir)) {
      const sp = path.join(dir, sub)
      if (!fs.statSync(sp).isDirectory()) continue
      for (const name of fs.readdirSync(sp)) {
        if (name.startsWith(sid)) return path.join(sp, name)
      }
    }
  }
  return null
}

for (const sid of targets) {
  const raw = findRaw(sid)
  console.log('\n====', sid)
  console.log('raw file:', raw)
  if (!raw) continue
  const ext = path.extname(raw)
  let buf
  if (ext === '.jsonl.zstd' || raw.endsWith('.jsonl')) {
    buf = fs.readFileSync(raw)
    let text
    if (ext === '.zstd' || raw.endsWith('.zstd')) {
      // zstd frames need the zstd package; fall back to scanning raw bytes for markers
      console.log('(zstd container — byte scan only)')
    }
    text = buf.toString('utf8')
    const lines = text.split(/\r?\n/).filter(Boolean)
    console.log('lines:', lines.length)
    const fcLines = []
    let maxSeq = -1
    lines.forEach((line, i) => {
      if (!line.trim()) return
      let rec
      try { rec = JSON.parse(line) } catch { return }
      const e = rec.event ?? rec
      if (typeof e.seq === 'number') maxSeq = Math.max(maxSeq, e.seq)
      const t = e.type
      if (t && t.startsWith('fc-compact')) {
        fcLines.push({ idx: i + 1, seq: e.seq, type: t, ignorable: e.ignorable })
      }
    })
    console.log('highest seq:', maxSeq)
    console.log('fc-compact events:')
    for (const f of fcLines) console.log('  line', f.idx, 'seq', f.seq, f.type, 'ignorable=' + f.ignorable)
    console.log('MISSING ignorable:', fcLines.filter(f => f.ignorable !== true).length)
  } else {
    console.log('unsupported extension', ext)
  }
}
