#!/usr/bin/env node
const fs = require('fs')
const f = 'D:/deepseek-harness-plugins/dsh-force-compact/README.cn.md'
const lines = fs.readFileSync(f, 'utf8').split('\n')
// Normalize leading-whitespace on the touched region (lines 27, 28, 29, 37, 38).
for (let i = 26; i <= 37; i++) {
  const trimmed = lines[i].trimStart()
  lines[i] = '  ' + trimmed
}
fs.writeFileSync(f, lines.join('\n'))
console.log('indent-normalized')
