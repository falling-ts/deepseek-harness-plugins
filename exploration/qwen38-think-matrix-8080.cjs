/**
 * qwen38-think-matrix-8080.cjs — 对照矩阵:llama.cpp(:8080,Qwen3.8-27B)对
 * 顶层 wire 字段 `reasoning_effort` 的实际响应。
 *
 *   A  不发任何 reasoning_effort 字段(基线:模型默认行为)
 *   B  reasoning_effort: "none"(本插件 summarizer 当前加盖的字段的同款 wire)
 *   C  reasoning_effort: "high"(对照:确认高档位确实引发思考,排除 A/B 的差异
 *      是由请求差异而非该字段造成)
 *
 * 观察指标:choices[0].message.reasoning_content 是否存在 / 长度 / 开头片段,
 * 以及 completion_tokens。Node 直连 fetch,JSON 走 JSON.stringify,UTF-8 干净。
 *
 * 用法:node exploration\qwen38-think-matrix-8080.cjs
 */
'use strict'

const BASE = 'http://127.0.0.1:8080/v1/chat/completions'
const QUESTION = '请一步一步地推理,再给出结论:9.11 和 9.9 哪个更大?最后用「答案:X」结尾。'

async function probe(label, extra) {
  const body = Object.assign(
    { model: 'qwen3.8-27b', messages: [{ role: 'user', content: QUESTION }], max_tokens: 512, temperature: 0.2 },
    extra,
  )
  const t0 = Date.now()
  const res = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status}: ${await res.text()}`)
    return
  }
  const j = await res.json()
  const m = (j.choices && j.choices[0] && j.choices[0].message) || {}
  const rc = typeof m.reasoning_content === 'string' ? m.reasoning_content : ''
  const ct = typeof m.content === 'string' ? m.content : ''
  const ms = Date.now() - t0
  console.log(`===== ${label} (耗时 ${(ms / 1000).toFixed(1)}s) =====`)
  console.log(`  reasoning_content 存在: ${rc.length > 0 ? `是 (${rc.length} 字符)` : '否(空字符串或字段缺失)'}`)
  if (rc) console.log(`  reasoning_content 开头 200 字: ${rc.slice(0, 200).replace(/\n/g, ' ⏎ ')}`)
  console.log(`  content 存在: ${ct.length > 0 ? `是 (${ct.length} 字符)` : '否'}`)
  if (ct) console.log(`  content 末尾 160 字: ${ct.slice(-160).replace(/\n/g, ' ⏎ ')}`)
  const u = (j.usage || {})
  console.log(`  completion_tokens: ${u.completion_tokens}  prompt_tokens: ${u.prompt_tokens}`)
  console.log('')
}

;(async () => {
  await probe('A 基线(不带 reasoning_effort)', {})
  await probe('B reasoning_effort="none"', { reasoning_effort: 'none' })
  await probe('C reasoning_effort="high"  (对照)', { reasoning_effort: 'high' })
})().catch((e) => {
  console.error('PROBE FAILED:', e.message)
  process.exit(1)
})
