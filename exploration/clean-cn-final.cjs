#!/usr/bin/env node
const fs = require('fs')
const f = 'D:/deepseek-harness-plugins/dsh-force-compact/README.cn.md'
let c = fs.readFileSync(f, 'utf8')
const lines = c.split('\n')
// Repair the mangled line 27-29 triple: collapse onto cleaner phrasing.
for (let i = 0; i < lines.length; i++) {
  const t = lines[i]
  if (t.trimStart().startsWith('`compactRegion`（经') || t.trimStart().startsWith(' `compactRegion`（经')) {
    lines[i] = '   `compactRegion`（经 `ctx.get(\'compaction\')` 实时读取）**保留最新的'
  }
  if (t.includes('的 token 窗口之外的**头段**')) {
    lines[i] = '   `retainLatestTokens` 个 token 逐字不变**，并将其余**头段**一次性浓缩为一个摘要节点，'
  }
  if (t.trim() === '上下文重试）。') {
    lines[i] = '   让循环以更小的上下文重试。'
  }
  if (t.includes('并返回 `{ kind: \'reject\' }` **不再请求模型**。') && i > 0 && lines[i - 1].includes('compactRegion`')) {
    // Drop the duplicate closing line introduced by the prior splice.
    lines[i] = ''
  }
}
c = lines.filter((l, idx, arr) => !(arr[idx] === '' && arr[idx + 1] === '' && idx > 0)).join('\n')
// Dedupe consecutive blank lines.
c = c.replace(/\n{3,}/g, '\n\n')
fs.writeFileSync(f, c)
console.log('cleaned', c.length)
