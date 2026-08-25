'use strict'
// Fire one short prompt at a freshly created session so that the agent goes
// idle and our realm-layer probe fires. Poll session.list for the new session.
const BASE = 'http://127.0.0.1:3180'
async function rpc(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'trig-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), method, payload })
  const res = await fetch(BASE + '/api/' + method.replace(/\//g, '.'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const o = await res.json().catch(() => ({ parseFail: true }))
  if (o.parseFail) throw new Error(method + ' HTTP ' + res.status + ' unparseable response')
  if (!o.result || !o.result.ok) throw new Error(method + ' RPC failure: ' + JSON.stringify(o.result && o.result.error))
  return o.result.value
}
async function main() {
  const created = await rpc('session.create', {})
  const sid = created.sessionId
  console.log('created session', sid)
  await rpc('session.prompt', {
    sessionId: sid,
    mode: 'queue',
    content: [{ type: 'text', text: 'Reply with exactly: ready.' }],
  })
  console.log('prompt sent; waiting for idle (<= 60s)…')
  const t0 = Date.now()
  const deadline = t0 + 60_000
  let lastStatus = ''
  while (Date.now() < deadline) {
    const list = await rpc('session.list', {})
    const match = Array.isArray(list) ? list.find((x) => x.sessionId === sid || x.id === sid) : list[sid]
    const st = match && (match.agentStatus || match.status || match.state)
    if (st) {
      if (st !== lastStatus) {
        console.log(`  t=${((Date.now() - t0) / 1000).toFixed(1)}s  agentStatus=${st}`)
        lastStatus = st
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('final session info:')
  const list2 = await rpc('session.list', {})
  const match2 = Array.isArray(list2) ? list2.find((x) => x.sessionId === sid || x.id === sid) : list2[sid]
  console.log(JSON.stringify(match2, null, 2))
  console.log('DONE — check ~/.dsh/logs/ctx-probe for ctx-snapshot-realm-*.json')
}
main().catch((err) => {
  console.error('TRIGGER FAILED:', err.message)
  process.exit(1)
})
