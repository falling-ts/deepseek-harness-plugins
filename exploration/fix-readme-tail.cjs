#!/usr/bin/env node
const fs = require('fs')
const f = 'D:/deepseek-harness-plugins/dsh-force-compact/README.md'
let c = fs.readFileSync(f, 'utf8')
// Line-by-line targeted replacements:
const lines = c.split('\n')
let changed = 0
for (let i = 0; i < lines.length; i++) {
  if (/autoEarliestRatio:/.test(lines[i]) && !lines[i].includes('Removed')) {
    lines[i] = lines[i].replace(/autoEarliestRatio: [\.\d]+/, 'retainLatestTokens: 30000')
    // If this line also carries the next default on the SAME visual line, clean it too.
    lines[i] = lines[i].replace(/, `forceEarliestRatio: [\.\d]+/, '')
    changed++
    continue
  }
  if (/forceEarliestRatio: [\.\d]+/.test(lines[i])) {
    lines.splice(i, 1)
    changed++
    continue
  }
}
c = lines.join('\n')
// Final sweep: retire any stray `forceEarliestRatio` mention in a defaults list.
c = c.replace(/`autoEarliestRatio: [\.\d]+`, /g, '`retainLatestTokens: 30000`, ')
c = c.replace(/`forceEarliestRatio: [\.\d]+`,/g, '')
// And the "honored by the agent/pre-step" bullet referencing both removed knobs:
const tailOld = /\(`autoEarliestRatio`, `forceEarliestRatio`\) are honored by the `agent\/pre-step`/
if (tailOld.test(c)) {
  c = c.replace(tailOld, '`retainLatestTokens` drives the region chosen by the `agent/pre-step`')
}
fs.writeFileSync(f, c)
console.log('changed', changed, 'lines; final length', c.length)
