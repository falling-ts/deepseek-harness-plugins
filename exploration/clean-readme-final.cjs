#!/usr/bin/env node
const fs = require('fs')
const f = 'D:/deepseek-harness-plugins/dsh-force-compact/README.md'
let c = fs.readFileSync(f, 'utf8')
// Fix the double-backtick artifact produced by the earlier splice.
c = c.replace('retainLatestTokens: 30000``,', 'retainLatestTokens: 30000`,')
// Reword the busy-force-flag sentence that still cites the retired knob:
const proseOld = 'the earliest `forceEarliestRatio` (via `compactRegion`, the current-turn owner'
const proseNew = 'a `retainLatestTokens` window (via `compactRegion`, the current-turn owner'
if (c.includes(proseOld)) c = c.replace(proseOld, proseNew)
else {
  // CRLF-aware fallback: operate line-wise.
  const lines = c.split('\r\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(proseOld)) { lines[i] = lines[i].replace(proseOld, proseNew) }
  }
  c = lines.join('\r\n')
}
fs.writeFileSync(f, c)
console.log('length', c.length)
