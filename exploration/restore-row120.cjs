#!/usr/bin/env node
const fs = require('fs')
const f = 'D:/deepseek-harness-plugins/dsh-force-compact/README.cn.md'
const lines = fs.readFileSync(f, 'utf8').split('\n')
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('（已移除 `forceEarliestRatio`）') && lines[i].endsWith('|')) {
    lines[i] = '| ~~`forceEarliestRatio`~~ | — | — | *已移除。* 强制标记路径现同样使用上方 `retainLatestTokens`（见上行），不再单独保留一个比例参数。 |'
    console.log('restored line', i + 1)
    break
  }
}
fs.writeFileSync(f, lines.join('\n'))
