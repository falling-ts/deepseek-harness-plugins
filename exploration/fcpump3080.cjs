#!/usr/bin/env node
// Pump ONE existing session (default cc257952) with N sequential LONG real-model
// turns on port 3080, so the corner/projectedTokens occupancy climbs well past
// the 80000 threshold and triggers turn-end (idle) compactions en route. Each
// round sends a verbose substantive prompt and waits for the session to settle
// (running=false) before the next round, giving idle transitions room to fire.
const port = process.argv[2] || '3080'
const sid = process.argv[3] || 'cc257952-8724-4795-a083-d64c3887e891'
const rounds = parseInt(process.argv[4] || '6', 10)
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function rpc(method, payload) {
  const res = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `pm-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, payload }) })
  const json = await res.json()
  if (!json.result || !json.result.ok) throw new Error(`wire error ${method}: ${JSON.stringify(json.result && json.result.error)}`)
  return json.result.value
}
// A long, genuinely substantive instruction that forces the model to produce a
// sizable multi-section answer (real content, not filler).
function bigPrompt(i) {
  return `Round ${i}: Write a thorough, detailed technical essay (aim for ~800 words) on the following topic, organized into clearly headed sections with concrete examples and tradeoff analysis: "Designing a distributed caching layer: cache invalidation strategies (TTL vs version-based vs event-driven), consistency semantics across replicas, hot-key skew mitigation, and the tradeoffs of caching at multiple tiers (edge vs origin vs in-process). Discuss failure modes, observability signals, and operational runbooks." Do not summarize — write the full body.`
}
;(async () => {
  for (let i = 1; i <= rounds; i++) {
    const r = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: bigPrompt(i) }] })
    console.log(`ROUND_${i}_accepted=${r && r.accepted}`)
    // Wait for this turn to fully settle (running=false) so each round gets a
    // clean idle boundary where the turn-end compaction can fire.
    for (let w = 0; w < 90; w++) {
      await sleep(2000)
      const items = (await rpc('session.list', {})).items || []
      const me = items.find(x => x.sessionId === sid)
      if (me && me.running === false) break
    }
    // Give the idle compaction a beat to land after the turn settles.
    await sleep(4000)
  }
  // Report final corner reading for the session from session.list projections.
  const items = (await rpc('session.list', {})).items || []
  const me = items.find(x => x.sessionId === sid)
  if (me && me.projections && me.projections.values && me.projections.values.contextPressure) {
    const cp = me.projections.values.contextPressure
    console.log('FINAL_CORNER=' + cp.projectedTokens)
  } else {
    console.log('FINAL_CORNER=n/a (projections absent)')
  }
  console.log('PUMP_DONE')
})().catch(e => { console.error('PUMP_FAILED: ' + e.message); process.exit(1) })
