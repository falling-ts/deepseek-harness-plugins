/**
 * fcdrivelocal.mjs — drive ONE real agent turn on a local DSH instance over the
 * wire (slash Typert gateway), so the force-compact idle path has a live
 * `agent/status → idle` transition to evaluate. Pure fetch, no browser.
 *
 * Run:  node exploration/fcdrivelocal.mjs [port] ["prompt text"]
 */
const PORT = Number(process.argv[2] ?? 3180)
const PROMPT = process.argv[3] ?? 'Say exactly: ping (one short line only)'
const EXISTING_SESSION = process.argv[4]
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function dshRpc(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      method,
      payload: { args },
    }),
  })
  const json = await res.json()
  if (!json || !json.result || json.result.ok !== true) {
    throw new Error(`${method} failed: HTTP ${res.status} ${JSON.stringify(json)}`)
  }
  return json.result.value
}

async function main() {
  console.log(`== drive turn on ${BASE} ==`)
  const listeners = await dshRpc('session/list', { _request: {} })
  console.log('existing sessions:', (listeners.items || []).length)

  let sessionId
  if (EXISTING_SESSION) {
    sessionId = EXISTING_SESSION
    console.log('reusing session:', sessionId)
  } else {
    const created = await dshRpc('session/create', { request: {} })
    sessionId = created.sessionId
    console.log('created session:', sessionId)
  }
  await dshRpc('session.prompt', {
    request: {
      requestId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: PROMPT }],
    },
  })

  let idle = false
  for (let i = 0; i < 90 && !idle; i++) {
    await sleep(2000)
    const list = await dshRpc('session.list', { _request: {} })
    const me = (list.items || []).find((it) => it.sessionId === sessionId)
    if (me && !me.running && !me.blank) idle = true
  }
  console.log('turn reached idle:', idle)
  console.log('== done — check ~/.dsh/logs/dsh-force-compact.log tail ==')
}

main().catch((e) => { console.error('DRIVE FAILED:', e); process.exit(1) })