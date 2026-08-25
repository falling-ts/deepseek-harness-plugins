'use strict'
// Print full JSON shape of selected lines in the session 2 log
const fs = require('node:fs')
const zlib = require('node:zlib')
const p = process.argv[2]
const lineTargets = (process.argv[3] || '23,34').split(',').map(Number)
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
const slices = []
for (let k = 0; k < offs.length; k++) {
  const start = offs[k]
  const end = k + 1 < offs.length ? offs[k + 1] : buf.length
  try {
    slices.push({ start, dec: zlib.zstdDecompressSync(buf.subarray(start, end)) })
  } catch {}
}
slices.sort((a, b) => a.start - b.start)
const lines = Buffer.concat(slices.map((s) => s.dec)).toString('utf8').split('\n').filter(Boolean)
for (const n of lineTargets) {
  const l = lines[n - 1]
  console.log(`--- line ${n} ---`)
  try {
    const r = JSON.parse(l)
    const e = r.event || r
    console.log('KEYS:', Object.keys(e).join(','))
    console.log('top-level keys:', Object.keys(r).join(','))
    console.log(JSON.stringify(r, (key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        // cap arrays
        const copy = { ...val }
        for (const kk of Object.keys(copy)) {
          if (Array.isArray(copy[kk])) copy[kk] = copy[kk].length > 4 ? `[len ${copy[kk].length}]` : copy[kk]
        }
        return copy
      }
      if (Array.isArray(val) && val.length > 4) return [val.length]
      return val
    }, 2).slice(0, 2000))
  } catch (err) {
    console.log('UNPARSED line:', l.slice(0, 300))
  }
}
