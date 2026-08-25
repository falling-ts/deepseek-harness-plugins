#!/usr/bin/env node
/** Final-pass fixes to dsh-force-compact/README.cn.md. */
const fs = require('fs')
const f = 'D:/deepseek-harness-plugins/dsh-force-compact/README.cn.md'
let c = fs.readFileSync(f, 'utf8')
// Work line-by-line so CRLF / BOM quirks don't defeat multi-line anchors.
const lines = c.split('\n')
// 1) Line 25–29 block: rephrase the pre-step description.
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('从最头') || lines[i].includes('从头压缩最早')) {
    // Collapse the stale two-line phrasing around autoEarliestRatio mentions.
    if (lines[i].trimStart().startsWith('`compactRegion`（经')) {
      lines[i] = '   `compactRegion`（经 `ctx.get(\'compaction\')` 实时读取）**保留最新的'
    } else if (lines[i].trimStart().startsWith('`retainLatestTokens` 的 token 窗口')) {
      lines[i] = '   `retainLatestTokens` 个 token 逐字不变**，将其余**头段**一次性浓缩为一个摘要'
    } else if (lines[i].includes('上下文重试')) {
      // Leave as-is (still valid).
    }
  }
}
// 2) Busy-force-flag sentence that got mangled: replace line 37–38 wholesale.
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('读到强制标记时')) {
    // Reconstruct the intended three-line passage.
    lines[i] = '   读到强制标记时，该步骤**跳过 token 阈值门禁**，按 `retainLatestTokens`'
    // Insert continuation lines just after.
    const nextLines = [
      '   语义选区（保留最新 N 个 token、头段一次性压缩）并经 `compactRegion`'
      + '（current-turn owner，可在 mid-turn 执行）执行，并返回 `{ kind: \'reject\' }`'
    ]
    // Check if the existing following line already contains the desired text; if so
    // just trim this line down and leave the follower intact.
    if (i + 1 < lines.length && lines[i + 1].includes('强制标记由 `agent/pre-step`')) {
      // Overwrite that line with our corrected wording.
      lines[i + 1] = nextLines[0]
    }
    break
  }
}
c = lines.join('\n')
// 3) Flowchart line.
c = c.replace(/compactRegion\(earliest autoEarliestRatio, signal\)/, 'compactRegion(head-before-retainLatestTokens, signal)')
// 4) Table rows.
c = c.replace(
  '| `autoEarliestRatio` | `number` | `0.3` | **自动压缩最早对话比例**——`agent/pre-step` 阈值门禁触发时，按 `tokenMeter` 测量的会话总 tokens 的该比例，从头累计 tokens 至预算（`totalTokens * ratio`）后截断（末端对齐 `user/message` 边界），压缩该区间。 |',
  '| `retainLatestTokens` | positive int | `20000` | **保留最新的绝对 token 数**——`agent/pre-step` 阈值门禁或 `/force-compact` 强制标记触发时，从会话**最新条目**起按官方 `tokenMeter` 的逐节点计数**反向**累加，直到运行和 ≥ 该值**停止**；截点之前的**所有条目一次性**发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变。'
)
c = c.replace(
  '| `forceEarliestRatio` | `number` | `0.5` | **强制压缩最早对话比例**——`/force-compact` 命令在 Agent **繁忙**时排队强制标记，由 `agent/pre-step` 钩子（`compactRegion`）在下一个模型步骤按会话总 tokens 的该比例从头截断压缩（命令本身在空闲时经 `compactNow` 用引擎自身区间选择压缩，不使用该比例）。 |',
  '| ~~`forceEarliestRatio`~~ | — | — | *已移除。* 强制标记路径现同样使用 `retainLatestTokens`（见上行）。 |'
)
// 5) YAML example block.
c = c.replace(/\s*autoEarliestRatio: 0\.3\s*\n\s*forceEarliestRatio: 0\.5/g, '\n  retainLatestTokens: 30000')
// 6) Defaults-list clause.
c = c.replace(/`autoEarliestRatio: 0\.3`、/, '`retainLatestTokens: 30000`、')
c = c.replace(/`forceEarliestRatio: 0\.5`、/, '')
// 7) Honored-by clause.
c = c.replace(/`autoEarliestRatio`、`forceEarliestRatio`）由 `agent\/pre-step`/, '`retainLatestTokens` 驱动 `agent\/pre-step`')
fs.writeFileSync(f, c)
console.log('written', c.length)
