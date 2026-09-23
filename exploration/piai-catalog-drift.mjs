// Full catalog drift between two installed pi-ai versions: providers, and the
// model ids each provider ships. Usage: node exploration/piai-catalog-drift.mjs <providers/all.js A> <providers/all.js B>
import { pathToFileURL } from 'node:url'

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error('usage: node exploration/piai-catalog-drift.mjs <A providers/all.js> <B providers/all.js>')
  process.exit(2)
}
const A = await import(pathToFileURL(a).href)
const B = await import(pathToFileURL(b).href)

const ids = (api) => {
  const models = api.getBuiltinProviders()
  return new Map(models.map((p) => [p.id, new Set(api.getBuiltinModels(p.id).map((m) => m.id))]))
}
const ma = ids(A)
const mb = ids(B)

const only = (set, other) => [...set].filter((x) => !other.has(x)).sort()
const added = only(new Set(mb.keys()), new Set(ma.keys()))
const removed = only(new Set(ma.keys()), new Set(mb.keys()))
console.log(`providers: A=${ma.size} B=${mb.size}`)
console.log(`  added:   ${added.join(', ') || '(none)'}`)
console.log(`  removed: ${removed.join(', ') || '(none)'}`)

let touched = 0
for (const provider of [...ma.keys()].filter((p) => mb.has(p)).sort()) {
  const aIds = ma.get(provider)
  const bIds = mb.get(provider)
  const plus = only(bIds, aIds)
  const minus = only(aIds, bIds)
  if (plus.length === 0 && minus.length === 0) continue
  touched++
  console.log(`\n${provider}: ${aIds.size} -> ${bIds.size}`)
  if (plus.length) console.log(`  + ${plus.join(', ')}`)
  if (minus.length) console.log(`  - ${minus.join(', ')}`)
}
console.log(`\n${touched} providers changed their model list`)
