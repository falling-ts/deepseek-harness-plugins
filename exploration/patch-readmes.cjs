#!/usr/bin/env node
/** Patch dsh-force-compact/README.{cn,}.md for the new retainLatestTokens knob. */
const fs = require('fs')

function patch(file, replacements) {
  let c = fs.readFileSync(file, 'utf8')
  for (const [needle, replacement] of replacements) {
    if (!c.includes(needle)) {
      console.warn(`${file}: anchor not found: ${needle.slice(0, 60)}...`)
      continue
    }
    c = c.replace(needle, replacement)
  }
  fs.writeFileSync(file, c)
  console.log(`${file}: written, length ${c.length}`)
}

// ── Chinese README ─────────────────────────────────────────────
patch('D:/deepseek-harness-plugins/dsh-force-compact/README.cn.md', [
  [
    '`autoEarliestRatio` 的对话（将该区间浓缩为一个摘要节点，让循环以更小的',
    '`retainLatestTokens` 的 token 窗口之外的**头段**（将头段一次性浓缩为一个摘要节点，让循环以更小的',
  ],
  [
    '`forceEarliestRatio`（`compactRegion`，current-turn owner，可在 mid-turn 执行），',
    '强制标记由 `agent/pre-step` 钩子在下一模型步读取并按 `retainLatestTokens` 语义选区执行 `compactRegion`（current-turn owner，可在 mid-turn 执行），',
  ],
  [
    '| `autoEarliestRatio` | `number` | `0.3` | **自动压缩最早对话比例**——`agent/pre-step` 阈值门禁触发时，按 `tokenMeter` 测量的会话总 tokens 的该比例，从头累计 tokens 至预算（`totalTokens * ratio`）后截断（末端对齐 `user/message` 边界），压缩该区间。 |',
    '| `retainLatestTokens` | positive int | `20000` | **保留最新的绝对 token 数**——`agent/pre-step` 阈值门禁或 `/force-compact` 强制标记触发时，从会话**最新条目**起，按官方 `tokenMeter` 的逐节点计数**反向**累加 token，直到 ≥ 该值**停止**；该截点之前的**所有条目一次性**发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变。',
  ],
  [
    '| `forceEarliestRatio` | `number` | `0.5` | **强制压缩最早对话比例**——`/force-compact` 命令在 Agent **繁忙**时排队强制标记，由 `agent/pre-step` 钩子（`compactReg',
    '| （已移除 `forceEarliestRatio`） | — | — | 原「强制压缩最早对话比例」已由上方 `retainLatestTokens` 一并替代：强制标记触发的压缩同样按「保留最新 N tokens」语义选区。',
  ],
])

// ── English README ─────────────────────────────────────────────
patch('D:/deepseek-harness-plugins/dsh-force-compact/README.md', [
  [
    '(the oldest `autoEarliestRatio` of the conversation).',
    '(everything BEFORE that cutoff — see `retainLatestTokens` below).',
  ],
  [
    '* - `forceEarliestRatio` (number 0.01..1, default `0.5`): the fraction of the',
    '* - `retainLatestTokens` (positive int, default `20000`): the absolute token count RETAINED at the latest end of the session surface when any compaction fires. Starting from the LATEST surface node, per-node tokens (via the official `tokenMeter` prices) ACCUMULATE BACKWARD until the running sum REACHES OR EXCEEDS this budget; everything before that cutoff is sent to the summarizer AS ONE BATCH (its entries become shadowed/skipped in derived history), and the retained tail stays verbatim. Replaces the former `autoEarliestRatio` / `forceEarliestRatio` percentage knobs.',
  ],
  [
    'autoEarliestRatio: number,\n   forceEarliestRatio: number,',
    'retainLatestTokens: number, // absolute token count retained at the latest end',
  ],
  [
    'autoEarliestRatio: 0.3,\n   forceEarliestRatio: 0.5,',
    'retainLatestTokens: 20000,',
  ],
  [
    '// normal for a large `autoEarliestRatio` such as 0.7 on a long tool-heavy\n    // conversation — the region is CLAMPED DOWN',
    '// typical when retaining relatively little on a long tool-heavy\n    // conversation — the region is CLAMPED DOWN',
  ],
])

console.log('README patches complete.')
