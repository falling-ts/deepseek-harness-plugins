// Validate EVERY session log under a DSH home with the harness's own
// installed-current reader (session-format-catalog `restoreCurrent` — exactly
// what `session/page` runs when it decides a stored log is corrupt).
//
// Use it after any bulk operation that touches session files (a home snapshot,
// a restore, a migration) so a truncated tail frame or a pre-existing format
// violation cannot hide in the long tail of sessions.
//
// Usage (from the workspace root):
//   node --import ./deepseek-harness/node_modules/tsx/dist/esm/index.mjs \
//        exploration/session-log-validate-all.mjs <dsh-home>
//   # e.g. ... exploration/session-log-validate-all.mjs ~/.dsh-web
//
// Exit code 0 when every log is accepted, 1 otherwise (rejected logs are listed
// with the reader's own error).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const CATALOG = new URL(
  '../deepseek-harness/packages/session/session-format-catalog/src/generated.ts',
  import.meta.url,
).href
const home = process.argv[2]
if (!home) throw new Error('usage: node session-log-validate-all.mjs <dsh-home>')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const sessionsRoot = join(home, 'sessions')
const files = []
for (const ws of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  for (const s of readdirSync(join(sessionsRoot, ws.name), { withFileTypes: true })) {
    if (!s.isDirectory()) continue
    const log = join(sessionsRoot, ws.name, s.name, 'session.v4.jsonl.zstd')
    try { statSync(log); files.push(log) } catch { /* session without a log yet */ }
  }
}

const { sessionFormatCatalogOptions } = await import(CATALOG)
let valid = 0
const rejected = []
for (const file of files) {
  const raw = readFileSync(file)
  const frames = []
  let off = 0
  while (off < raw.length) {
    const at = raw.indexOf(MAGIC, off + 1)
    frames.push(raw.subarray(off, at === -1 ? raw.length : at))
    if (at === -1) break
    off = at
  }
  let text = ''
  let skipped = 0
  for (const frame of frames) {
    try { text += zstdDecompressSync(frame).toString('utf8') } catch { skipped += 1 }
  }
  const lines = text.split('\n').filter((line) => line !== '')
  try {
    const parsedHeader = JSON.parse(lines[0])
    const events = lines.slice(1).map((line) => JSON.parse(line))
    const { type, ...header } = parsedHeader
    void type
    sessionFormatCatalogOptions.restoreCurrent({ header, events, inheritedEventCount: 0 })
    valid += 1
  } catch (error) {
    rejected.push({ file, frames: frames.length, skipped, why: `${error.constructor.name}: ${error.message}` })
  }
}

console.log(`home = ${home}`)
console.log(`logs = ${files.length}   VALID = ${valid}   REJECTED = ${rejected.length}`)
for (const r of rejected) {
  console.log(`\n  REJECTED ${r.file}`)
  console.log(`    frames=${r.frames} skippedFrames=${r.skipped}`)
  console.log(`    ${r.why}`)
}
process.exitCode = rejected.length === 0 ? 0 : 1
