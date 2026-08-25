#!/usr/bin/env node
/** One-shot fixer for the last two stale default values in dsh-force-compact/README.md
 *  (the `defaults (...)` bullet around line 167). Anchors were verified against the
 *  raw buffer first. */
const fs = require('node:fs')
const path = 'D:/deepseek-harness-plugins/dsh-force-compact/README.md'
let t = fs.readFileSync(path, 'utf8')
const pairs = [
  ['autoThresholdTokens:\n  80000', 'autoThresholdTokens:\n  32000'],
  ['retainLatestTokens: 30000', 'retainLatestTokens: 8000'],
]
for (const [from, to] of pairs) {
  if (!t.includes(from)) throw new Error(`anchor not found: ${JSON.stringify(from)}`)
  t = t.split(from).join(to)
}
fs.writeFileSync(path, t)
console.log('replacements applied')
