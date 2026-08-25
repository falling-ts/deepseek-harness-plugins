#!/usr/bin/env node
// Drive N sequential real model turns on a freshly created session at a given
// port, accumulating genuine provider usage samples so the contextPressure
// projection gains a real `projectedTokens`. Prints the session id.
const port = process.argv[2] || '3080'
const rounds = parseInt(process.argv[3] || '6', 10)
const base = `http://127.0.0.1:${port}`
async function rpc(method, payload) {
  const res = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `st-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, payload }) })
  const json = await res.json()
  if (!json.result || !json.result.ok) throw new Error(`wire error ${method}: ${JSON.stringify(json.result && json.result.error)}`)
  return json.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const created = await rpc('session.create', {})
  const sid = created.sessionId
  console.log('STRESS_SID=' + sid)
  for (let i = 1; i <= rounds; i++) {
    const text = `Round ${i}: explain the tradeoffs between eager and lazy evaluation in functional pipelines, give two concrete examples, keep it concise.`
    const r = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text }] })
    console.log(`ROUND_${i}_accepted=${r && r.accepted}`)
    // Wait for this turn to settle before queueing the next. Poll running flag.
    for (let w = 0; w < 60; w++) {
      await sleep(2000)
      const items = (await rpc('session.list', {})).items || []
      const me = items.find(x => x.sessionId === sid)
      if (me && me.running === false) break
    }
  }
  console.log('STRESS_DONE')
})().catch(e => { console.error('STRESS_FAILED: ' + e.message); process.exit(1) })
