// Validate a physical v4 session log with the harness's OWN validator
// (`session-format-catalog`'s restoreCurrent == the installed-current read path,
// i.e. exactly what `session/page` runs when it decides a stored log is corrupt).
// Usage (from the workspace root):
//   node --import ./deepseek-harness/node_modules/tsx/dist/esm/index.mjs \
//        exploration/session-log-validate.mjs <session.v4.jsonl.zstd>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const CATALOG = new URL('../deepseek-harness/packages/session/session-format-catalog/src/generated.ts', import.meta.url).href
const file = process.argv[2]

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
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
for (const frame of frames) { try { text += zstdDecompressSync(frame).toString('utf8') } catch { /* skip undecodable frame */ } }
const lines = text.split('\n').filter(line => line !== '')
const parsedHeader = JSON.parse(lines[0])
const { type, ...header } = parsedHeader
const events = lines.slice(1).map(line => JSON.parse(line))
const artifact = { header, events, inheritedEventCount: parsedHeader.isSeeded ? 0 : 0 }
console.log(`${file}\n  frames=${frames.length} events=${events.length} dense=${events.every((e, i) => e.seq === i)} isSeeded=${header.isSeeded}`)

const { sessionFormatCatalogOptions } = await import(CATALOG)
try {
  sessionFormatCatalogOptions.restoreCurrent(artifact)
  console.log('  RESULT: VALID — the installed current-format reader accepts this log ✅')
} catch (error) {
  console.log(`  RESULT: REJECTED — ${error.constructor.name}: ${error.message}`)
  process.exitCode = 1
}
