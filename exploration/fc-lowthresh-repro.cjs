'use strict'
// Low-threshold 3-send reproduction + fix verification.
// Usage: node fc-lowthresh-repro.cjs [port] [threshold]
// Creates a fresh session, sets falling-ts-force-compact.autoThresholdTokens,
// sends 3 short prompts sequentially waiting for idle, and reports timing for
// each. Exits non-zero if any step hangs (> TIMEOUT_MS) or the server wedges.

const PORT = Number(process.argv[2] || 3180)
const THRESHOLD = Number(process.argv[3] || 2500)
const BASE = `http://127.0.0.1:${PORT}`
const STEP_TIMEOUT_MS = 40000
const POLL_TIMEOUT_MS = 45000

async function rpc(method, payload, timeoutMs) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
      signal: ctrl.signal,
    })
    const json = await res.json()
    if (json.result && json.result.ok === false) throw new Error(`rpc ${method}: ${JSON.stringify(json.result.error ?? json.result)}`)
    return json.result.value
  } finally { clearTimeout(t) }
}

async function waitForIdle(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const started = Date.now()
  while (Date.now() < deadline) {
    try {
      const v = await rpc('session.list', {}, STEP_TIMEOUT_MS)
      const arr = v.items || v
      const item = arr.find(x => x.id === sessionId || x.sessionId === sessionId)
      if (item && item.running === false) return Date.now() - started
      if (item === undefined) throw new Error(`session ${sessionId} missing from list (wedged?)`)
    } catch (e) {
      if (/timeout|abort/i.test(String(e))) {
        console.log(`  [poll] session.list timed out after ${STEP_TIMEOUT_MS}ms — SERVER WEDGE DETECTED`)
        return -1
      }
      throw e
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  return -1
}

function msg(text) { return [{ type: 'text', text }] }

async function main() {
  console.log(`port=${PORT} threshold=${THRESHOLD}`)
  // 1. set the low threshold
  try {
    const upd = await rpc('settings.update', { ns: 'falling-ts-force-compact', patch: { autoThresholdTokens: THRESHOLD, autoEarliestRatio: 0.5 } }, 8000)
    console.log(`settings.update ok (echo: ${upd ? Object.keys(upd).join(',') : 'void'})`)
  } catch (e) {
    console.log(`settings.update failed: ${e.message} — continuing with existing threshold`)
  }
  // 2. create session
  const created = await rpc('session.create', {}, 8000)
  const sid = created.sessionId || created.id
  console.log(`created session ${sid}`)

  const prompts = ['HELLO', 'Count 1 to 5.', 'END-OF-TEST']
  let wedged = false
  for (let i = 0; i < prompts.length; i++) {
    const t0 = Date.now()
    let accepted
    try {
      const r = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: msg(prompts[i]) }, 8000)
      accepted = r && r.accepted
      console.log(`MSG${i + 1} "${prompts[i]}" accepted=${accepted} (ack ${Date.now() - t0}ms)`)
    } catch (e) {
      console.log(`MSG${i + 1} send FAILED: ${e.message}`)
      wedged = true
      break
    }
    const ms = await waitForIdle(sid, POLL_TIMEOUT_MS)
    if (ms < 0) {
      console.log(`MSG${i + 1} idle WAIT HUNG — server likely wedged`)
      wedged = true
      break
    }
    console.log(`MSG${i + 1} idle reached in ${ms}ms`)
  }

  // 3. post-hoc health ping
  await new Promise(r => setTimeout(r, 500))
  try {
    const v = await rpc('session.list', {}, 10000)
    const arr = v.items || v
    console.log(`FINAL session.list OK items=${arr.length}`)
  } catch (e) {
    console.log(`FINAL session.list TIMED OUT — ${e.message}`)
    wedged = true
  }

  console.log(wedged ? '\nRESULT: WEDGED' : '\nRESULT: CLEAN (all 3 completed, no hang)')
  process.exit(wedged ? 1 : 0)
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(2) })
