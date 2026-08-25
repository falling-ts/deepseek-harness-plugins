#!/usr/bin/env node
/**
 * fcdrive-compact.cjs — drive one session past the force-compact AUTO threshold.
 *
 * Purpose: verify the `agent/pre-step` threshold gate on a LIVE 3180 instance:
 *   - TURN 1: a small prompt whose total context stays BELOW autoThresholdTokens
 *     (expect a `total ~N tokens < threshold T` line).
 *   - TURN 2: a large prompt that pushes total context ABOVE the threshold
 *     (expect a `total ~N tokens >= threshold T` line + the compaction
 *     transaction, plus our COMPRESS-CALL OUTBOUND PARAMS line showing
 *     reasoningEffort=off on the summarizer call).
 *
 * The plugin's OWN [force-compact] lines land in
 * ~/.dsh/logs/dsh-force-compact.log; we just drive and the operator tails that.
 *
 * Usage: node fcdrive-compact.cjs [PORT]
 *   PORT defaults to 3180.
 */
'use strict'

const portArg = process.argv[2]
const PORT = /^\d+$/.test(portArg || '') ? parseInt(portArg, 10) : 3180
const BASE = 'http://127.0.0.1:' + PORT

let rpcSeq = 0
async function rpc(method, payload) {
  const rpcId = 'fccompact-' + (++rpcSeq) + '-' + Date.now().toString(36)
  const res = await fetch(BASE + '/api/' + method, {
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

async function waitForIdle(sid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (Date.now() > deadline) throw new Error('session ' + sid + ' did not go idle within ' + timeoutMs + 'ms')
    const rows = await rpc('session.list', {})
    const items = Array.isArray(rows) ? rows : (rows && (rows.sessions || rows.items || rows.rows)) || []
    const me = items.find(s => (s.sessionId || s.id) === sid)
    if (me && !me.running) return true
    await sleep(1000)
  }
}

async function main() {
  console.error('[compact] base ' + BASE)
  const created = await rpc('session.create', {})
  const sid = created && (created.sessionId || created.id)
  if (!sid) throw new Error('session.create returned no id: ' + JSON.stringify(created).slice(0, 200))
  console.error('[compact] session ' + sid)

  // ---- TURN 1: small, stays below the 2048 threshold ---------------------
  const p1 = await rpc('session.prompt', {
    sessionId: sid,
    mode: 'queue',
    content: [{ type: 'text', text: '你好，请用一句话回答：1 加 1 等于几？' }],
  })
  console.error('[compact] turn1 queued accepted=' + JSON.stringify(p1 && (p1.accepted !== undefined ? p1.accepted : p1)).slice(0, 120))
  await waitForIdle(sid, 180000)
  console.error('[compact] turn1 idle at ' + new Date().toISOString() + ' — expect "< threshold" line in the [force-compact] log')

  // ---- TURN 2: large, crosses the threshold --------------------------------
  // Build a clearly-large body (~4k words ≈ >2048 tokens) so total context
  // definitely exceeds autoThresholdTokens on the NEXT pre-step.
  const filler = '这是用于填充上下文的中文段落，用来确保本次请求的总上下文 tokens 超过自动压缩阈值。'.repeat(80)
  const p2 = await rpc('session.prompt', {
    sessionId: sid,
    mode: 'queue',
    content: [{ type: 'text', text: filler + '\n\n现在请简短总结以上填充内容（只需一句）。' }],
  })
  console.error('[compact] turn2 queued accepted=' + JSON.stringify(p2 && (p2.accepted !== undefined ? p2.accepted : p2)).slice(0, 120))
  console.error('[compact] turn2 body chars=' + filler.length + ' — expect ">= threshold" + compaction + COMPRESS-CALL OUTBOUND PARAMS line in the [force-compact] log')
  await waitForIdle(sid, 300000)
  console.error('[compact] turn2 idle at ' + new Date().toISOString())
  console.error('[compact] DONE. Tail C:\\Users\\zghyu\\.dsh\\logs\\dsh-force-compact.log for the evidence.')
}

main().catch(err => { console.error('[compact] FAILED:', err && err.message || err); process.exit(1) })
