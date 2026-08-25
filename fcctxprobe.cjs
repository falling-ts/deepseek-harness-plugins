'use strict'
const base = process.env.FC_BASE || 'http://127.0.0.1:3180'
async function rpc(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'probe-' + Date.now(), method, payload })
  const res = await fetch(base + '/api/' + method.replace('/', '.'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const o = await res.json().catch(() => ({ __parse_failed: true, status: res.status }))
  if (o.__parse_failed || !o.result || !o.result.ok) {
    throw new Error('RPC ' + method + ' failed: ' + JSON.stringify(o).slice(0, 500))
  }
  return o.result.value
}
;(async () => {
  const sid = (await rpc('session.create', {})).sessionId
  console.log('SID', sid)
  const res = await fetch(base + '/api/falling-ts.force-compact.debug.echoCtx', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'probe-ectx',
      method: 'falling-ts.force-compact/debug.echoCtx',
      payload: {},
    }),
  })
  console.log('status', res.status)
  const txt = await res.text()
  console.log(txt.slice(0, 8000))
})().catch((err) => {
  console.error('FATAL', err.message)
  process.exit(1)
})
