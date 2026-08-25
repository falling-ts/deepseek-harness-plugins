'use strict'
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
function dump(d, depth = 0) {
  if (depth > 3) return
  let entries
  try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) {
      console.log(`${'  '.repeat(depth)}${e.name}/ (${countFiles(p)} files below)`)
      dump(p, depth + 1)
    } else {
      console.log(`${'  '.repeat(depth)}${e.name}  ${fs.statSync(p).size}`)
    }
  }
}
function countFiles(d) {
  let n = 0
  try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { e.isDirectory() ? n += countFiles(path.join(d, e.name)) : n++ } } catch { /* ignore */ }
  return n
}
dump(path.join(os.homedir(), '.dsh', 'sessions'), 0)
