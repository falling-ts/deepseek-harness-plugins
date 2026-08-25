#!/usr/bin/env node
/** Rewrite the dsh-force-compact AGENTS.md to reflect the new retainLatestTokens knob. */
const fs = require('fs')
const f = 'D:/deepseek-harness-plugins/dsh-force-compact/AGENTS.md'
let c = fs.readFileSync(f, 'utf8')
const OLD_ROW_AUTO = '| `autoEarliestRatio` | number (0.01\u20131) | `0.3` | 自动路径从头部选取的对话比例 |'
const OLD_ROW_FORCE = '| `forceEarliestRatio` | number (0.01\u20131) | `0.5` | `/force-compact` 命令从头部选取的比例 |'
const NEW_ROW = '| `retainLatestTokens` | positive int | `20000` | 自动/强制压缩时**保留最新的绝对 token 数**：从会话**最新条目**起，按官方 `tokenMeter` 的逐节点计数**反向**累加，直到 \u2265 该值**停止**；该截点之前的**所有条目一次性**发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变。替代旧的 `autoEarliestRatio` / `forceEarliestRatio` 比例参数。 |'
if (!c.includes(OLD_ROW_AUTO)) throw new Error('anchor AUTO row not found')
if (!c.includes(OLD_ROW_FORCE)) throw new Error('anchor FORCE row not found')
c = c.replace(OLD_ROW_AUTO + '\n' + OLD_ROW_FORCE, NEW_ROW)
// Hook prose updates: replace the three descriptive passages that cite the ratios.
c = c.replace(
  '当其**\u2265 `autoThresholdTokens`** 时，返回 `{ kind: \'reject\' }` **不发起模型请求**，并从头压缩最早 `autoEarliestRatio` 的对话（`compactRegion`）；低于阈值时调用 `next()` 让请求继续。',
  '当其**\u2265 `autoThresholdTokens`** 时，返回 `{ kind: \'reject\' }` **不发起模型请求**，并按 `retainLatestTokens` 语义选区：**从会话最新条目起按官方 `tokenMeter` 逐节点反向累加 token，直到 \u2265 `retainLatestTokens` 停止**；截点之前的**所有条目一次性**通过 `compactRegion` 发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变；低于阈值时调用 `next()` 让请求继续。'
)
c = c.replace(
  '读到强制标记则**跳过 token 阈值门禁**、压缩最早 `forceEarliestRatio`（`compactRegion`），并返回 `{ kind: \'reject\' }` **不再请求模型**',
  '读到强制标记则**跳过 token 阈值门禁**、按 `retainLatestTokens` 语义选区（同上，保留最新 N tokens、头段一次性压缩）并经 `compactRegion` 执行，并返回 `{ kind: \'reject\' }` **不再请求模型**'
)
c = c.replace(
  '- `autoEarliestRatio`（`number` 0.01..1，默认 `0.3`）——**自动压缩最早对话比例**：`agent/pre-step` 阈值门禁触发时，按 `tokenMeter` 测量的会话总 tokens 的该比例，从头累计 tokens 至预算后截断（末端对齐 `user/message` 边界），压缩该区间。\n  - `forceEarliestRatio`（`number` 0.01..1，默认 `0.5`）——**强制压缩最早对话比例**：`/force-compact` 命令在 Agent **繁忙**时排队强制标记，由 `agent/pre-step` 钩子（`compactRegion`）在下一个模型步骤按总 tokens 的该比例从头截断压缩（命令本身在空闲时经 `compactNow` 用引擎自身区间选择压缩，不使用该比例）。',
  '- `retainLatestTokens`（positive int，默认 `20000`）——**保留最新的绝对 token 数**：`agent/pre-step` 阈值门禁或 `/force-compact` 强制标记触发时，从会话**最新条目**起按官方 `tokenMeter` 逐节点**反向**累加 token，直到运行和 \u2265 该值**停止**；截点之前的**所有条目一次性**通过 `compactRegion` 发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变。**该参数同时服务于自动路径与 `/force-compact` 命令路径**（后者在空闲时仍经 `compactNow` 用引擎自身区间选择，不经此参数）。'
)
c = c.replace(
  '每次请求的门禁：`agent/request` 关闭思考（`reasoningEffort: \'off\'`）+ `agent/pre-step` 阈值门禁（`autoEarliestRatio` 从头压缩）',
  '每次请求的门禁：`agent/request` 关闭思考（`reasoningEffort: \'off\'`）+ `agent/pre-step` 阈值门禁（按 `retainLatestTokens` 保留最新 tokens、头段一次性压缩）'
)
fs.writeFileSync(f, c)
console.log('rewrote AGENTS.md, length', c.length)
