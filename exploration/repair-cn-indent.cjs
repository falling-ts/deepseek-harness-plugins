#!/usr/bin/env node
const fs = require('fs')
const f = 'D:/deepseek-harness-plugins/dsh-force-compact/README.cn.md'
const lines = fs.readFileSync(f, 'utf8').split('\n')
// Lines whose original indent should be zero (top-level bullets / headings / paragraphs).
const topLevelMarkers = [
  /^- /,                  // top-level list item
  /^\*\*[`#]/,            // bold-start heading fragment
  /^#\s/,                 // markdown heading
]
for (let i = 29; i <= 38; i++) {
  const line = lines[i]
  if (/^- /.test(line) || /^#{1,6}\s/.test(line) || /^_+\*\*/.test(line) || /^```\w*$/.test(line)) {
    lines[i] = line.replace(/^  (?=-|\d+[.):]\s|#|_|```)/, '$1'.length === 0 ? line.replace(/^  /, '') : line)
    // Simpler: strip exactly two leading spaces when the line starts with a top-level marker after stripping.
  }
  const stripped = line.startsWith('  ') ? line.slice(2) : line
  if (/^- /.test(stripped) || /^#{1,6}\s/.test(stripped)) {
    lines[i] = stripped
  }
}
// Also repair line 120: strip the trailing junk after the first '）。 |'.
for (let i = 118; i < 125; i++) {
  const l = lines[i]
  if (l.includes('（已移除 `forceEarliestRatio`）') && l.includes('不使用该比例）')) {
    const cutIdx = l.indexOf(' |')
    // Keep the leading cell structure but truncate before the duplicated tail.
    const prefix = l.slice(0, cutIdx)
    lines[i] = prefix + ' |'
  }
}
fs.writeFileSync(f, lines.join('\n'))
console.log('fixed')
