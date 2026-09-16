// fc-shadow-price-parity-probe.mjs — 差分实证：影子价账单口径 vs 官方折叠器
//
// 背景（2026-09-17，harness 0.1.6-alpha.1 上游窗口）：
// token-meter 的 surface 折叠器用「影子价格索赔」结算一次压缩：
//
//   packages/llm/token-meter/src/surface-fold.ts  planSurfaceTokens(nodes, event)
//     const node  = analyzeNode(event.seq, deriveEventMessage(event))
//     const tokens = node.heuristicTokens                       // 追加用启发价
//     const removed = nodes.slice(startIdx, endIdx + 1)
//       .reduce((total, c) => total + c.heuristicTokens, 0)      // 被替换区间同样用启发价
//     return { tokens, deltaTokens: tokens - removed }
//
// 而 analyzeNode 的价格是 `estimateMessage(message)` = 非 system 一律
// `estimateContent(content) + ROLE_OVERHEAD`。
//
// 于是 `compaction/summary` 的 `shadowedTokenCount` 必须等于
// `Σ node.heuristicTokens`（官方 `prepareCompaction` 正是这么算的；
// 路由价 `node.tokens` 走的是另一个字段 `shadowedRouteTokenCount`）。
// 本插件的移植此前有两处偏差：
//   1) `priceRegionFromMeasurement` 累加的是路由价 `node.tokens`；
//   2) 退化路径 `priceSurfaceNode` 只给 tool/result 加 ROLE_OVERHEAD，
//      user/assistant 漏加 4 tokens/条。
// 偏差会让 `delta = 启发价(检查点) − 索赔` 偏正（计数器少扣），
// 正是历史上"压缩后计数不降反升"那一族症状。
//
// 本探针用 Node 22 的原生类型擦除直接加载官方模块，与插件实现逐例对拍。
// 运行：node exploration/fc-shadow-price-parity-probe.mjs

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OFFICIAL_FOLD = new URL('../deepseek-harness/packages/llm/token-meter/src/surface-fold.ts', import.meta.url)
const OFFICIAL_ESTIMATE = new URL('../deepseek-harness/packages/llm/token-meter/src/estimate.ts', import.meta.url)
const PLUGIN = new URL('../dsh-force-compact/src/engine/builtin.js', import.meta.url)

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}${detail === undefined ? '' : `   ${detail}`}`)
  } else {
    failed += 1
    failures.push(`${name}: ${detail}`)
    console.log(`  FAIL  ${name}   ${detail}`)
  }
}

if (!existsSync(fileURLToPath(OFFICIAL_FOLD)) || !existsSync(fileURLToPath(OFFICIAL_ESTIMATE))) {
  console.log('SKIP: 官方模块不存在（harness 子模块未检出或未构建？）')
  process.exit(0)
}

const official = await import(OFFICIAL_FOLD.href)
const officialEstimate = await import(OFFICIAL_ESTIMATE.href)
const mine = await import(PLUGIN.href)

const { planSurfaceTokens } = official
const { estimateMessage } = officialEstimate
const { estimateMessageTokens, priceSurfaceNode, priceRegionFromMeasurement, nodeHeuristicPrice } = mine

const IMG = { type: 'image', attachment: { attachmentId: 'att-1', mimeType: 'image/png' } }

// ------------------------------------------------------------------ 合成 surface

const EVENTS = [
  { type: 'system/message', seq: 0, surfaceOp: 'append', data: { message: { role: 'system', content: [{ type: 'text', text: 'You are a helpful agent.' }] } } },
  { type: 'user/message', seq: 1, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'hello there' }] } },
  { type: 'assistant/message', seq: 2, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi, working on it' }, { type: 'tool-call', name: 'read_file', arguments: '{"path":"a.ts"}' }] } } },
  { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { message: { role: 'tool', toolCallId: 'tc-1', content: [{ type: 'text', text: 'file contents here' }] } } },
  { type: 'assistant/message', seq: 4, surfaceOp: 'append', data: { message: { role: 'assistant', content: [] } } },
  { type: 'user/message', seq: 5, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'look at this' }, IMG] } },
  { type: 'user/message', seq: 6, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'drop that one' }, { ...IMG, offloaded: true }] } },
]

/** Fold the OFFICIAL planner over the events and return per-seq heuristic prices. */
function officialNodePrices(events) {
  let nodes = []
  const bySeq = new Map()
  for (const event of events) {
    const plan = planSurfaceTokens(nodes, event)
    bySeq.set(event.seq, plan.node.heuristicTokens)
    nodes = [...nodes, { seq: plan.node.seq, heuristicTokens: plan.node.heuristicTokens }]
  }
  return { bySeq, sum: (from, to) => [...bySeq.entries()].filter(([seq]) => seq >= from && seq <= to).reduce((t, [, v]) => t + v, 0) }
}

const officialPrices = officialNodePrices(EVENTS)

/** A session shell whose surface nodes and log match the synthetic events. */
function makeSession(seqs, { projected = undefined } = {}) {
  return {
    surface: {
      nodes: seqs,
      ...(projected === undefined
        ? {}
        : { deriveEventMessage: (event) => (event.seq in projected ? projected[event.seq] : null) }),
    },
    snapshotEvents: () => EVENTS,
  }
}

console.log('=== A. estimateMessageTokens vs 官方 estimateMessage ===\n')

const MESSAGES = [
  ['user 文本', { role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
  ['assistant 双块', { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool-call', name: 'x', arguments: '{}' }] }],
  ['tool 结果', { role: 'tool', toolCallId: 'tc-1', content: [{ type: 'text', text: 'result body' }] }],
  ['system 单文本', { role: 'system', content: [{ type: 'text', text: 'You are a helpful agent.' }] }],
  ['system 空内容', { role: 'system', content: [] }],
  ['含图像（无标记）', { role: 'user', content: [IMG] }],
  ['含图像（已离线）', { role: 'user', content: [{ ...IMG, offloaded: true }] }],
  ['工具结果内嵌图像', { role: 'user', content: [{ type: 'tool-result', content: [IMG] }] }],
]

for (const [name, message] of MESSAGES) {
  const want = estimateMessage(message)
  const got = estimateMessageTokens(message)
  check(`estimateMessage 一致 — ${name}`, want === got, `官方=${want} 插件=${got}`)
}

console.log('\n=== B. priceSurfaceNode vs 官方折叠器逐节点价 ===\n')

for (const event of EVENTS) {
  const want = officialPrices.bySeq.get(event.seq)
  const got = priceSurfaceNode(null, event)
  check(`逐节点价一致 — seq${event.seq} ${event.type}`, want === got, `官方=${want} 插件=${got}`)
}

check(
  '空内容 assistant（usage 宿主）价 = 0',
  priceSurfaceNode(null, EVENTS[4]) === 0,
  `插件=${priceSurfaceNode(null, EVENTS[4])}`,
)

// 回归要点：ROLE_OVERHEAD 必须对 user/assistant 同样计入（修复前漏加 4/条）。
{
  const userEvent = EVENTS[1]
  const contentOnly = mine.estimateContentBlocks(userEvent.data.content)
  const priced = priceSurfaceNode(null, userEvent)
  check('回归：user 消息计入 ROLE_OVERHEAD', priced === contentOnly + 4, `仅内容=${contentOnly} 实际=${priced}`)
  const assistantEvent = EVENTS[2]
  const assistantContent = mine.estimateContentBlocks(assistantEvent.data.message.content)
  const assistantPriced = priceSurfaceNode(null, assistantEvent)
  check(
    '回归：assistant 消息计入 ROLE_OVERHEAD',
    assistantPriced === assistantContent + 4,
    `仅内容=${assistantContent} 实际=${assistantPriced}`,
  )
}

// 离线标记不得改变节点价（与官方 estimateStructuralBlock 的剥离语义一致）。
// 必须比较「同一内容」加不加标记，否则比的是两条不同的消息。
{
  const base = EVENTS[5]
  const marked = {
    ...base,
    data: { ...base.data, content: base.data.content.map(block => (block.type === 'image' ? { ...block, offloaded: true } : block)) },
  }
  const plain = priceSurfaceNode(null, base)
  const offloaded = priceSurfaceNode(null, marked)
  check('离线标记不改变节点价（同内容对比）', plain === offloaded, `无标记=${plain} 已离线=${offloaded}`)
  check(
    '离线标记下与官方折叠器同价',
    offloaded === (() => {
      const prices = officialNodePrices([marked])
      return prices.bySeq.get(marked.seq)
    })(),
    '官方同值',
  )
}

console.log('\n=== C. 投影感知：priceSurfaceNode 走 surface.deriveEventMessage ===\n')

{
  const projectedMessage = { role: 'user', content: [{ type: 'text', text: 'projected body' }] }
  const session = makeSession([1], { projected: { 1: projectedMessage } })
  const got = priceSurfaceNode(session, EVENTS[1])
  check('采用投影消息计价', got === estimateMessage(projectedMessage), `插件=${got} 官方=${estimateMessage(projectedMessage)}`)
  check('投影消息与原始内容不同价（证明未回退原始）', got !== priceSurfaceNode(null, EVENTS[1]), `投影=${got} 原始=${priceSurfaceNode(null, EVENTS[1])}`)
}

{
  // 缝返回 null（投影判定"该事件不产出消息"）→ 必须计 0，而非回退原始内容。
  const session = makeSession([1], { projected: { 1: null } })
  check('缝返回 null 时计 0', priceSurfaceNode(session, EVENTS[1]) === 0, `实际=${priceSurfaceNode(session, EVENTS[1])}`)
}

{
  // 缝抛错 → 回退原始内容，绝不外抛。
  const session = { surface: { nodes: [1], deriveEventMessage: () => { throw new Error('boom') } }, snapshotEvents: () => EVENTS }
  let threw = false
  let got
  try {
    got = priceSurfaceNode(session, EVENTS[1])
  } catch {
    threw = true
  }
  check('缝抛错时不外抛', threw === false, threw ? '抛出了异常' : '正常返回')
  check('缝抛错时回退原始内容价', got === priceSurfaceNode(null, EVENTS[1]), `实际=${got}`)
}

console.log('\n=== D. nodeHeuristicPrice：优先启发价，回退路由价 ===\n')

check('优先 heuristicTokens', nodeHeuristicPrice({ seq: 1, heuristicTokens: 30, tokens: 999 }) === 30, '取 30 而非 999')
check('缺 heuristicTokens 时回退 tokens', nodeHeuristicPrice({ seq: 1, tokens: 42 }) === 42, '取 42')
check('非有限值视为不可用', nodeHeuristicPrice({ seq: 1, heuristicTokens: NaN, tokens: 5 }) === 5, '跳过 NaN')
check('全非数值 → undefined', nodeHeuristicPrice({ seq: 1, tokens: 'x' }) === undefined, 'undefined')
check('null → undefined', nodeHeuristicPrice(null) === undefined, 'undefined')

console.log('\n=== E. priceRegionFromMeasurement：整区间账单 vs 官方 ΣheuristicTokens ===\n')

const SEQS = [1, 2, 3, 4, 5, 6]
const REGION = { start: 1, end: 6 }
const OFFICIAL_SUM = officialPrices.sum(1, 6)

{
  // 快照路径：节点带「远大于启发价」的路由价，用来暴露口径错误。
  const nodes = SEQS.map(seq => ({ seq, heuristicTokens: officialPrices.bySeq.get(seq), tokens: officialPrices.bySeq.get(seq) + 500 }))
  const session = makeSession(SEQS)
  const got = priceRegionFromMeasurement(session, REGION, { nodes })
  check('快照路径 = 官方 ΣheuristicTokens', got === OFFICIAL_SUM, `插件=${got} 官方=${OFFICIAL_SUM}`)
  check(
    '回归：未误用路由价（500/节点 × 6）',
    got !== OFFICIAL_SUM + 3000,
    `若用 tokens 会得到 ${OFFICIAL_SUM + 3000}`,
  )
}

{
  // 快照缺字段（旧快照）→ 回退 tokens。
  const nodes = SEQS.map(seq => ({ seq, tokens: officialPrices.bySeq.get(seq) }))
  const got = priceRegionFromMeasurement(makeSession(SEQS), REGION, { nodes })
  check('旧快照（无 heuristicTokens）回退 tokens', got === OFFICIAL_SUM, `插件=${got}`)
}

{
  // 快照不完整（缺一个 seq）→ 必须整体放弃快照，改由日志逐节点计价。
  const nodes = SEQS.filter(seq => seq !== 3).map(seq => ({ seq, heuristicTokens: officialPrices.bySeq.get(seq), tokens: 12345 }))
  const got = priceRegionFromMeasurement(makeSession(SEQS), REGION, { nodes })
  check('快照不完整时不采信快照', got === OFFICIAL_SUM, `插件=${got} 官方=${OFFICIAL_SUM}`)
}

{
  // 无快照 → 日志退化路径（与官方同值）。
  const got = priceRegionFromMeasurement(makeSession(SEQS), REGION, undefined)
  check('无快照时日志退化路径 = 官方 ΣheuristicTokens', got === OFFICIAL_SUM, `插件=${got} 官方=${OFFICIAL_SUM}`)
}

{
  // 区间边界：只覆盖部分节点时，账单必须只算覆盖到的。
  const got = priceRegionFromMeasurement(makeSession(SEQS), { start: 3, end: 5 }, undefined)
  const want = officialPrices.sum(3, 5)
  check('子区间账单只算覆盖节点', got === want, `插件=${got} 官方=${want}`)
}

{
  // 非法界（start 不在表面）→ null（调用方据此决定退化或 fail-loud）。
  const got = priceRegionFromMeasurement(makeSession(SEQS), { start: 999, end: 6 }, undefined)
  check('非法界返回 null', got === null, `实际=${String(got)}`)
}

console.log(`\n${'='.repeat(64)}`)
if (failed === 0) {
  console.log(`ALL CHECKS PASSED — ${passed} passed, 0 failed`)
} else {
  console.log(`${passed} passed, ${failed} FAILED`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
