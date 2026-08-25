'use strict'
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    e.isDirectory() ? walk(p, out) : /\.(jsonl|zst)$/.test(e.name) && out.push(p)
  }
  return out
}
const ROOT = path.join(os.homedir(), '.dsh', 'sessions')
if (!fs.existsSync(ROOT)) { console.error('NO SESSIONS DIR at', ROOT); process.exit(2) }
const files = walk(ROOT).map(p => ({ p, st: fs.statSync(p) }))
console.error(`found ${files.length} files`)
for (const { p, st } of files) console.error(`  ${new Date(st.mtimeMs).toISOString()}  ${st.size}  ${p}`)
