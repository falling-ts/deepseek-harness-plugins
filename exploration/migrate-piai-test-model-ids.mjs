// pi-ai 0.87.1 renamed its `deepseek` catalog entry: `deepseek-v4-flash` is now
// `deepseek-flash` (`deepseek-v4-flash-vision-exp` is gone entirely). The five
// llm-pi-ai specs below resolve that model through pi-ai's installed catalog, so
// their ids move with it. Everything else in the repo uses the hand-rolled
// `deepseek-official` adapter or a mock session, which the rename does not touch.
// Writes go through Node (UTF-8), never through shell string cmdlets.
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node migrate-piai-test-model-ids.mjs <harness-root>')
  process.exit(2)
}

const files = [
  'packages/llm/llm-pi-ai/tests/adapter.spec.ts',
  'packages/llm/llm-pi-ai/tests/catalog.spec.ts',
  'packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts',
  'packages/llm/llm-pi-ai/tests/egress.spec.ts',
  'packages/llm/llm-pi-ai/tests/loader-composition.spec.ts',
]

// The vision variant is a distinct id that 0.87.1 dropped; never fold it into
// the rename (a test relying on it needs a decision, not a substitution).
const pattern = /deepseek-v4-flash(?!-vision-exp)/g
let total = 0
for (const rel of files) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) throw new Error(`missing: ${rel}`)
  const before = fs.readFileSync(file, 'utf8')
  const hits = (before.match(pattern) ?? []).length
  const vision = (before.match(/deepseek-v4-flash-vision-exp/g) ?? []).length
  const after = before.replace(pattern, 'deepseek-flash')
  if (after !== before) fs.writeFileSync(file, after)
  total += hits
  console.log(`${rel}: ${hits} renamed, ${vision} vision-variant left alone`)
}
console.log(`[migrate] ${total} occurrences renamed to deepseek-flash`)
