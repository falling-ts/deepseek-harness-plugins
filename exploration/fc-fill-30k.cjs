#!/usr/bin/env node
/**
 * Fill a fresh 3180 session toward ~30K context tokens via wire API, to test
 * whether the dsh-force-compact AUTO threshold (autoThresholdTokens=30000)
 * fires a forced compaction.
 *
 * Strategy: one LONG queued prompt instructing the model to write ~15 rounds
 * of distinct technical prose into a scratch file via the write/edit tools.
 * Each assistant tool-call argument blob is surface content and accumulates
 * real tokens. We poll session.history between prompts, estimating total
 * tokens as (surface-text chars)/4 (same caliber as the plugin's fallback),
 * and keep sending follow-ups until >= 30K or max rounds, printing progress
 * so the observer can watch the pre-step gate log lines appear.
 *
 * Usage: node fc-fill-30k.cjs [PORT] [MAX_ROUNDS]
 */
'use strict'

const PORT = parseInt(process.argv[2] || '3180', 10)
const MAX_ROUNDS = parseInt(process.argv[3] || '8', 10)
const BASE = 'http://127.0.0.1:' + PORT
const TARGET = 30000
const SCRATCH = 'fill30k.txt'

let rpcSeq = 0
async function rpc(method, payload) {
  const rpcId = 'fill-' + (++rpcSeq) + '-' + Date.now().toString(36)
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

/** Estimate session tokens the same crude way the plugin does (chars/4). */
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

function roundPrompt(n) {
  // Distinct, dense technical content each round so repetition never collapses
  // the prompt cache; each instruction asks for a fresh numbered chapter.
  return [
    `Append exactly Chapter ${n} to "${SCRATCH}" (create it if missing; NEVER rewrite or delete earlier chapters).`,
    `Chapter title: "System Design Memo ${n}". Content requirements:`,
    `1. A paragraph (~150 words) describing distributed component MEMO-${n}-A: its responsibility, inputs, outputs, and failure modes.`,
    `2. A paragraph (~150 words) about component MEMO-${n}-B interacting with ${n - 1 > 0 ? 'MEMO-${n - 1}-A/B' : 'nothing'} — include latency budgets and retry policy.`,
    `3. A numbered list of 8 concrete design decisions tagged DD-${n}-01 .. DD-${n}-08, each one line.`,
    `4. Do NOT output the chapter text in your reply. Use the write/edit TOOL to append to the file. Your final reply must be the single sentence: "Chapter ${n} appended."`,
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
  console.error('[fill] port ' + PORT + ', target >= ' + TARGET + ' tokens, max ' + MAX_ROUNDS + ' fill rounds')
  const created = await rpc('session.create', {})
  const sid = created.sessionId || created.id
  console.error('[fill] created session ' + sid)
  await sleep(1500)

  let est = await estimateTotal(sid)
  console.error(`[fill] baseline ~${est.tokens} tokens (${est.events} events)`)

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    console.error(`[fill] ---- round ${round} (context ~${est.tokens} tokens) ----`)
    const text = roundPrompt(round)
    const accepted = await rpc('session.prompt', {
      sessionId: sid,
      mode: 'steer',
      content: [{ type: 'text', text }],
    })
    console.error('[fill] queued; accepted=' + JSON.stringify(accepted).slice(0, 150))
    await waitForIdle(sid, 15 * 60 * 1000)
    est = await estimateTotal(sid)
    console.error(`[fill] after round ${round}: ~${est.tokens} tokens, ${est.surfaceMsgs} surface msgs, ${est.events} events`)
    if (est.tokens >= TARGET) {
      console.error(`[fill] TARGET REACHED (~${est.tokens} >= ${TARGET}) — watching for pre-step threshold gate...`)
      // Send ONE more modest prompt so a model REQUEST actually happens while
      // total >= threshold — that is what trips agent/pre-step.
      const bump = await rpc('session.prompt', {
        sessionId: sid,
        mode: 'queue',
        content: [{ type: 'text', text: `Reply with the single word: done-round-${round}.` }],
      })
      console.error('[fill] final bump queued; accepted=' + JSON.stringify(bump).slice(0, 150))
      await waitForIdle(sid, 15 * 60 * 1000)
      est = await estimateTotal(sid)
      console.error(`[fill] final estimate ~${est.tokens} tokens`)
      break
    }
  }

  // Final snapshot: look for compaction events in the log.
  const h = await rpc('session.history', { sessionId: sid })
  const events = (h && (h.events || h.items)) || (Array.isArray(h) ? h : [])
  const comps = events.filter(ev => {
    const t = ev.type || (ev.event && ev.event.type)
    return t && String(t).startsWith('compaction/')
  })
  console.log(JSON.stringify({
    sessionId: sid,
    finalEstimate: est,
    compactionEvents: comps.map(ev => ({
      seq: ev.seq ?? ev.event.seq,
      type: ev.type || ev.event.type,
      data: ev.data ?? ev.event.data,
    })),
  }, null, 2))
  console.error(`[fill] DONE — session ${sid}; inspect ~/.dsh/logs/dsh-force-compact.log for "context ~N tokens >= threshold"` )
}

main().catch(err => { console.error('[fill] FAILED:', err && err.stack || err); process.exit(1) })
