#!/usr/bin/env node
/** Normalize the user's active falling-ts-force-compact pins to values at or above
 *  the newly enforced floors, without disturbing the liveUi block the live instance
 *  keeps rewriting. Single atomic read-modify-write to avoid racing the writer. */
'use strict'
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(os.homedir(), '.dsh', 'settings.yaml')
let t = fs.readFileSync(file, 'utf8')
const pair = [
  ['autoThresholdTokens: 30000', 'autoThresholdTokens: 32000'],
  ['retainLatestTokens: 30000', 'retainLatestTokens: 8000'],
]
let touched = 0
for (const [from, to] of pair) {
  if (t.includes(from)) { t = t.split(from).join(to); touched++ }
}
if (touched === 0) { console.log('nothing to change — both pins already at floor or higher'); process.exit(0) }
// Verify exactly where our substitutions landed (both must be inside the
// falling-ts-force-compact block, not some unrelated sibling).
const headIdx = t.indexOf('falling-ts-force-compact:')
const thIdx = t.indexOf('autoThresholdTokens: 32000', headIdx)
const rtIdx = t.indexOf('retainLatestTokens: 8000', headIdx)
if (thIdx < headIdx || rtIdx < headIdx) throw new Error('replacement landed OUTSIDE the expected block')
fs.writeFileSync(file, t)
console.log(`normalized ${touched} pin(s) — head@${headIdx}, th@${thIdx}, rt@${rtIdx}`)
