#!/usr/bin/env node
// List sessions visible on a given harness dev port. Prints each session id
// plus whatever count field is present.
const port = process.argv[2] || '3180'
const base = `http://127.0.0.1:${port}`
async function rpc(method, payload) {
  const res = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `lst-${Date.now()}`, method, payload }) })
  const json = await res.json()
  if (!json.result || !json.result.ok) throw new Error(`wire error ${method}: ${JSON.stringify(json.result && json.result.error)}`)
  return json.result.value
}
;(async () => {
  const v = await rpc('session.list', {})
  const arr = Array.isArray(v) ? v : (v && typeof v === 'object' && Array.isArray(v.sessions) ? v.sessions : [v])
  console.log(`SESSION_COUNT=${arr.length}`)
  for (const s of arr.slice(0, 30)) {
    const id = s.id ?? s.sessionId ?? '?'
    const meta = []
    for (const k of ['eventCount', 'seq', 'events', 'messageCount']) if (s[k] !== undefined) meta.push(`${k}=${Array.isArray(s[k]) ? s[k].length : s[k]}`)
    console.log(`SID=${id} ${meta.join(' ')}`)
  }
})().catch(e => { console.error('LIST_FAILED: ' + e.message); process.exit(1) })
