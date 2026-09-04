// fc-loop-smoke-3180.cjs — wire smoke against 3180 using the CURRENT gateway
// contract (slash endpoints under /api, args-wrapped payloads).
const BASE = 'http://127.0.0.1:3180/api'
let rpcSeq = 0
const rpcId = () => 'smoke-' + Date.now() + '-' + (rpcSeq++)

async function call(method, args) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method, payload: { args } }),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function main() {
  const list = await call('session/list', {})
  console.log('session/list status:', list.status, 'ok:', !!(list.json && list.json.result && list.json.result.ok))

  const created = await call('session/create', { request: {} })
  const r = created.json && created.json.result
  const sid = r && r.ok ? r.value.sessionId : undefined
  console.log('session/create ->', sid, created.status)
  if (!sid) { console.log('ERROR create:', JSON.stringify(created.json).slice(0, 300)); return }

  const prompted = await call('session/prompt', {
    request: {
      requestId: 'smoke-req-' + Date.now(),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: 'Reply with the single word: pong.' }],
    },
  })
  console.log('session/prompt status:', prompted.status, 'accepted:', prompted.json && prompted.json.result && prompted.json.result.value && prompted.json.result.value.accepted)

  await new Promise((r) => setTimeout(r, 5000))
  const list2 = await call('session/list', {})
  const items = list2.json && list2.json.result && list2.json.result.value && list2.json.result.value.items
  console.log('session/list after prompt: items =', Array.isArray(items) ? items.length : JSON.stringify(list2.json).slice(0, 300))
  console.log('SMOKE DONE — session ' + sid)
}

main().catch((e) => { console.error('SMOKE FAILED', e); process.exitCode = 1 })