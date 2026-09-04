// fc-settings-3180.cjs — read the falling-ts-force-compact namespace on 3180
// to confirm the effective threshold/retention values.
const BASE = 'http://127.0.0.1:3180/api'
async function call(method, args) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 's-' + Date.now(), method, payload: { args } }),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function main() {
  const r = await call('settings/describe', {})
  const ok = r.json && r.json.result && r.json.result.ok
  console.log('status:', r.status, 'ok:', ok)
  if (!ok) { console.log(JSON.stringify(r.json).slice(0, 300)); return }
  const views = r.json.result.value.namespaces || []
  const fc = views.find((v) => v.ns === 'falling-ts-force-compact')
  console.log('plugins namespaces:', views.map((v) => v.ns).join(', '))
  console.log('force-compact VALUE:', JSON.stringify(fc.value))
  console.log('force-compact user :', JSON.stringify(fc.user))
  console.log('force-compact base :', JSON.stringify(fc.base))
  console.log('applies:', JSON.stringify(fc.applies))
}

main().catch((e) => { console.error('FAIL', e); process.exitCode = 1 })