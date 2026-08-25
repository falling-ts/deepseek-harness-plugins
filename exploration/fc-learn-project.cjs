#!/usr/bin/env node
/**
 * Grow a fresh 3180 session's context by making the driven agent LEARN THE
 * PROJECT — repeatedly, as completely as possible, re-reading the dsh-force-compact
 * plugin and the deepseek-harness package tree — so context reaches ~30K tokens
 * naturally and we observe whether the dsh-force-compact AUTO threshold
 * (autoThresholdTokens=30000) fires forced compaction.
 *
 * Every round RE-STATES the learning requirement (read / glob / grep across the
 * sources, cover real structure and contracts) — context is meant to grow a lot.
 *
 * Between rounds we poll session.history and print a chars/4 token estimate.
 * STOPPING RULE (anti-stall): if a round does not add >= 1500 estimated tokens,
 * the session has plateaued (likely the local model refusing to run tools), so
 * we stop and report instead of burning more rounds.
 *
 * Usage: node fc-learn-project.cjs [PORT] [MAX_ROUNDS]
 */
'use strict'

const PORT = parseInt(process.argv[2] || '3180', 10)
const MAX_ROUNDS = parseInt(process.argv[3] || '10', 10)
const BASE = 'http://127.0.0.1:' + PORT
const TARGET = 30000
const MIN_GAIN = 1500
const WORKSPACE = 'D:\\deepseek-harness-plugins'

let rpcSeq = 0
async function rpc(method, payload) {
  const rpcId = 'learn-' + (++rpcSeq) + '-' + Date.now().toString(36)
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(method + ' → HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 300))
  if (json.result && json.result.ok === false) {
    throw new Error(method + ' → ' + JSON.stringify(json.result).slice(0, 300))
  }
  return json.result ? json.result.value : undefined
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Rough session token estimate: surface-text chars / 4 (plugin fallback caliber). */
async function estimateTotal(sid) {
  const h = await rpc('session.history', { sessionId: sid })
  const events = (h && (h.events || h.items)) || (Array.isArray(h) ? h : [])
  let chars = 0
  let surfaceMsgs = 0
  for (const ev of events) {
    const type = ev.type || (ev.event && ev.event.type)
    const data = ev.data ?? (ev.event && ev.event.data) ?? {}
    let content
    if (type === 'user/message') content = data.content
    else if (type === 'assistant/message') content = (data.message && data.message.content) || undefined
    else if (type === 'tool/result') content = (data.message && data.message.content) || undefined
    if (!Array.isArray(content)) continue
    surfaceMsgs += 1
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
    }
  }
  return { tokens: Math.ceil(chars / 4), surfaceMsgs, events: events.length }
}

/** Round-specific focus areas to keep re-reading COMPLETE rather than shallow. */
const FOCUS = [
  'dsh-force-compact 全量源码：index.js、web/client.js、src/core/{policy,settings,log,ui-signal}.js',
  'dsh-force-compact/src/engine/ 全部文件（backend.js、builtin.js、checkpoint.js、region.js、summarizer.js），逐个完整读',
  'dsh-force-compact/src/hooks/ 全部文件（wire-rewrite.js、idle.js、command.js、guard.js），逐个完整读',
  'dsh-force-compact 文档与配置：AGENTS.md、README.md、README.cn.md、package.json、cordis.patch.yml',
  'deepseek-harness/packages/host/apiproxy（rpc-map.ts 全文）',
  'deepseek-harness/packages/llm（llm/stream 事件缝相关源码）',
  'deepseek-harness/packages/compaction（官方 compaction-basic：summarizer.ts、区间选择）',
  'deepseek-harness/packages/session（事件溯源日志：deriveMessages、KNOWN_SESSION_EVENT_TYPES、重载门禁）',
  '根工作区 AGENTS.md、CLAUDE.md、harness-server.sh、harness-server-dev.sh，以及 docs/ 下与压缩相关的 md',
  '把以上全部再完整重读一遍（不浅读、跳过任何文件都不行），并把本仓库结构、契约、关键不变量整理成一份详尽报告输出在回复里',
]

function roundText(n) {
  const focus = FOCUS[(n - 1) % FOCUS.length]
  return [
    `第 ${n} 轮。你正在学习并理解位于 ${WORKSPACE} 的 deepseek-harness-plugins 工作区（重点子仓：dsh-force-compact 插件与其上游 deepseek-harness monorepo）。`,
    '',
    '**硬性要求（每一轮都必须再次执行，不许偷懒）**：',
    '1. 使用 read / glob / grep 工具**反复、尽量完整地通读代码与文档**——这是你的主要工作方式；不要一次性浅读就结束。',
    '2. 本轮聚焦范围：' + focus,
    '3. 读到内容后必须在回复末尾输出一段不少于 250 字的中文技术总结（覆盖真实的项目结构、模块职责与契约细节，禁止空泛套话）。',
    '4. 若发现上一轮总结遗漏的文件或细节，继续深入读取它们。',
  ].join('\n')
}

async function waitForIdle(sid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await rpc('session.list', {})
    const items = Array.isArray(rows) ? rows : []
    const me = items.find(s => (s.sessionId || s.id) === sid)
    if (me && !me.running) return true
    if (Date.now() > deadline) throw new Error('timed out waiting for idle after ' + timeoutMs + 'ms')
    await sleep(2000)
  }
}

async function main() {
  console.error('[learn] port ' + PORT + ', target >= ' + TARGET + ' tokens, max ' + MAX_ROUNDS + ' rounds')
  const created = await rpc('session.create', {})
  const sid = created.sessionId || created.id
  console.error('[learn] created session ' + sid)
  await sleep(1500)

  let prev = (await estimateTotal(sid)).tokens
  console.error(`[learn] baseline ~${prev} tokens`)

  let stoppedReason = 'finished-max-rounds'
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    console.error(`[learn] ---- round ${round} (context ~${prev} tokens) ----`)
    const accepted = await rpc('session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: roundText(round) }],
    })
    console.error('[learn] queued; accepted=' + JSON.stringify(accepted).slice(0, 150))
    await waitForIdle(sid, 20 * 60 * 1000)
    const cur = (await estimateTotal(sid)).tokens
    const gain = cur - prev
    console.error(`[learn] after round ${round}: ~${cur} tokens (+${gain} this round)`)
    prev = cur
    if (cur >= TARGET) {
      stoppedReason = 'REACHED-TARGET'
      console.error(`[learn] *** TARGET REACHED (~${cur} >= ${TARGET}) — the next model request should trip the pre-step gate ***`)
      break
    }
    if (gain < MIN_GAIN) {
      stoppedReason = `STALLED (round ${round} gained only ${gain} < ${MIN_GAIN})`
      console.error(`[learn] stopping: ${stoppedReason}`)
      break
    }
  }

  // One final probe request (if we haven't tripped yet) so the gate actually
  // evaluates at/above the current total, then snapshot compaction events.
  if (prev >= TARGET) {
    await rpc('session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: 'Reply with the single word: probe.' }],
    }).catch(() => {})
    await waitForIdle(sid, 20 * 60 * 1000).catch(() => {})
  }

  const h = await rpc('session.history', { sessionId: sid })
  const events = (h && (h.events || h.items)) || (Array.isArray(h) ? h : [])
  const comps = events.filter(ev => {
    const t = ev.type || (ev.event && ev.event.type)
    return t && String(t).startsWith('compaction/')
  })
  console.log(JSON.stringify({
    sessionId: sid,
    stoppedReason,
    finalEstimatedTokens: prev,
    compactionEvents: comps.map(ev => ({
      seq: ev.seq ?? ev.event.seq,
      type: ev.type || ev.event.type,
      data: ev.data ?? ev.event.data,
    })),
  }, null, 2))
  console.error('[learn] DONE — check ~/.dsh/logs/dsh-force-compact.log for ">= threshold" lines')
}

main().catch(err => { console.error('[learn] FAILED:', err && err.stack || err); process.exit(1) })
