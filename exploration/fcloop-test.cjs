#!/usr/bin/env node
// 单元级验证: 压缩结果为空白时不陷入死循环,且上下文增长后自动恢复尝试。
// 模拟 forceCompactIfNeeded 的冷却门禁: 重复空白→停止; 增长超容差→恢复。
// 用法: node fcloop-test.cjs
const assert = require('assert')

// ---- 复刻 guard.js 的冷却逻辑(与被测代码同构) -------------------------
const compactCooldown = new Map()
const COOLDOWN_GROWTH_TOLERANCE = 500
const MAX_COOLDOWN_ENTRIES = 32

function markCompactCooldown(id, tokens, note) {
  while (compactCooldown.size >= MAX_COOLDOWN_ENTRIES) {
    const k = compactCooldown.keys().next().value
    if (k === undefined) break
    compactCooldown.delete(k)
  }
  compactCooldown.delete(id)
  compactCooldown.set(id, { tokens, note })
}
function consultCompactCooldown(id, tokens) {
  const e = compactCooldown.get(id)
  if (e === undefined) return undefined
  if (tokens > e.tokens + COOLDOWN_GROWTH_TOLERANCE) { compactCooldown.delete(id); return undefined }
  return e.note
}
function clearCompactCooldown(id) { compactCooldown.delete(id) }

// ---- 场景 1: 反复空白 → 第二次起停止重试 --------------------------------
// 第一次: total=200000 超过阈值,无冷却 → 应尝试压缩; 返回空白 → 记录冷却@200000。
// 第二次: total=200000 仍在阈值上,但有冷却(未增长) → 应跳过,不再压。
// 第三次: total=200000 同上 → 依旧跳过。
const THRESHOLD = 131000
let attempts = 0
async function forceGate(total) {
  if (total < THRESHOLD) return { attempted: false, reason: 'below-gate' }
  const note = consultCompactCooldown('sess-A', total)
  if (note !== undefined) return { attempted: false, reason: 'cooled-down', note }
  attempts++
  const committed = false // 模拟空白摘要
  if (!committed) markCompactCooldown('sess-A', total, 'blank')
  return { attempted: true, committed }
}
;(async () => {
  const r1 = await forceGate(200000)
  const r2 = await forceGate(200000)
  const r3 = await forceGate(200000)
  console.log('attempt1 (fresh):', r1)
  console.log('attempt2 (should skip):', r2)
  console.log('attempt3 (should skip):', r3)
  assert.strictEqual(r1.attempted, true, 'first blank should attempt once')
  assert.strictEqual(r2.attempted, false, 'second step must NOT re-attempt (loop broken)')
  assert.strictEqual(r3.attempted, false, 'third step must NOT re-attempt')
  assert.strictEqual(attempts, 1, 'exactly ONE attempt despite repeated steps')

  // ---- 场景 2: 上下文增长超容差 → 恢复尝试 -----------------------------
  const rGrow = await forceGate(200000 + 600) // +600 > tolerance 500 → 冷却过期
  console.log('growth past tolerance (should attempt again):', rGrow)
  assert.strictEqual(rGrow.attempted, true, 'growth past mark re-arms compaction')

  // ---- 场景 3: 增长未超容差 → 仍暂停 -----------------------------------
  markCompactCooldown('sess-B', 200000, 'blank')
  const rSmallGrow = await (async () => {
    const n = consultCompactCooldown('sess-B', 200000 + 300) // +300 < 500
    return { attempted: n === undefined }
  })()
  console.log('small growth < tolerance (should still skip):', rSmallGrow)
  assert.strictEqual(rSmallGrow.attempted, false, '+300 (< 500 tol) stays paused')

  // ---- 场景 4: 成功提交清除冷却 → 下次直接尝试 --------------------------
  markCompactCooldown('sess-C', 200000, 'blank')
  clearCompactCooldown('sess-C') // 模拟某次提交成功
  const rClear = consultCompactCooldown('sess-C', 200000)
  assert.strictEqual(rClear, undefined, 'commit clears cooldown')

  // ---- 场景 5: 容量上限驱逐最老条目 -------------------------------------
  for (let i = 0; i < MAX_COOLDOWN_ENTRIES + 5; i++) markCompactCooldown('k' + i, 200000, '')
  assert.ok(compactCooldown.size <= MAX_COOLDOWN_ENTRIES, 'bounded by cap')
  assert.ok(!compactCooldown.has('k0'), 'oldest evicted')
  assert.ok(compactCooldown.has('k' + (MAX_COOLDOWN_ENTRIES + 4)), 'newest kept')

  console.log('\n✅ ALL LOOP-GUARD TESTS PASSED')
  console.log('- 反复空白只压 1 次,后续步骤全部跳过(无死循环)')
  console.log('- 上下文增长超 500 tok 容差后自动恢复')
  console.log('- 小幅波动(< 容差)不误触')
  console.log('- 提交成功即清冷却;容量上限驱逐最老条目')
})().catch(e => { console.error('❌ FAIL:', e.message); process.exit(1) })
