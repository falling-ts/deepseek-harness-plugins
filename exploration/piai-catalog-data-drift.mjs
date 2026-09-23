// Catalog drift between two installed pi-ai versions, read straight from the
// generated data files (dist/providers/data/<provider>.json) rather than from
// getBuiltinProviders(), which only lists providers this process registered.
// Usage: node exploration/piai-catalog-data-drift.mjs <pkgDirA> <pkgDirB>
import fs from 'node:fs'
import path from 'node:path'

const [dirA, dirB] = process.argv.slice(2)
if (!dirA || !dirB) {
  console.error('usage: node exploration/piai-catalog-data-drift.mjs <pkgDirA> <pkgDirB>')
  process.exit(2)
}

/** Every model id in one provider data file, keyed by the API group that lists it. */
function readProvider(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  const byApi = new Map()
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node.id === 'string' && (node.api !== undefined || node.baseUrl !== undefined)) {
      const list = byApi.get(node.api) ?? []
      list.push(node.id)
      byApi.set(node.api, list)
      return
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(json)
  return byApi
}

const dataDir = (dir) => path.join(dir, 'dist', 'providers', 'data')
const files = (dir) => new Set(fs.readdirSync(dataDir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.')))

const fa = files(dirA)
const fb = files(dirB)
const only = (set, other) => [...set].filter((x) => !other.has(x)).sort()
console.log(`provider data files: A=${fa.size} B=${fb.size}`)
console.log(`  only in A: ${only(fa, fb).join(', ') || '(none)'}`)
console.log(`  only in B: ${only(fb, fa).join(', ') || '(none)'}`)

const flat = (byApi) => new Set([...byApi.values()].flat())
let changed = 0
for (const file of [...fa].filter((f) => fb.has(f)).sort()) {
  const a = flat(readProvider(path.join(dataDir(dirA), file)))
  const b = flat(readProvider(path.join(dataDir(dirB), file)))
  const plus = only(b, a)
  const minus = only(a, b)
  if (plus.length === 0 && minus.length === 0) continue
  changed++
  console.log(`\n${file.replace('.json', '')}: ${a.size} -> ${b.size}`)
  if (plus.length) console.log(`  + ${plus.join(', ')}`)
  if (minus.length) console.log(`  - ${minus.join(', ')}`)
}
console.log(`\n${changed} provider files changed their model list`)
