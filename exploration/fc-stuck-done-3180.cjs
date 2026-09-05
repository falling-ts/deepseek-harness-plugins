// fc-stuck-done-3180.cjs — NEGATIVE case: a DONE banner (phase 'done') must NOT be
// overridden by clearStuckCompressingBanner (it only clears phase==='compressing').
// Push a real DONE banner, fire a model request, and confirm the badge is NOT
// force-cleared to a working pair by the pre-step hook. (The non-important llm/stream
// watermark also can't override a `[` bracket, so the DONE banner survives either way —
// the point is the hook does NOT add an important working-pair push for a DONE badge.)
const BASE = 'http://127.0.0.1:3180/api'
const NS = 'falling-ts-force-compact'

async function call(method, args) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'done-' + Date.now() + '-' + Math.random().toString(36).slice(2), method, payload: { args } }),
  })
  return res.json().catch(() => null)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uuid = () => (globalThis.crypto?.randomUUID?.() || 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2))

async function liveUi() {
  const r = await call('settings/describe', {})
  const v = r && r.result && r.result.value
  const ns = (v && Array.isArray(v.namespaces) ? v.namespaces : []).find(n => n && n.ns === NS)
  return (ns && ns.value && ns.value.liveUi) || undefined
}

async function main() {
  console.log('1) create session ...')
  const created = await call('session/create', { request: {} })
  const sessionId = created && created.result && created.result.value && created.result.value.sessionId
  console.log('   sessionId:', sessionId || '(FAILED)')
  if (!sessionId) { process.exitCode = 1; return }

  // Real DONE banner shape, exactly what publishDone() writes: pinnedPayload('done').
  const doneBanner = { text: '[压缩完成!]', color: '#2f6f52', phase: 'done' }
  console.log('2) push a DONE banner (REAL shape) into liveUi ...')
  const up = await call('settings/update', { ns: NS, patch: { liveUi: doneBanner }, expectedRevision: undefined })
  console.log('   update ok:', !!(up && up.result && up.result.ok))
  await sleep(500)
  const before = await liveUi()
  console.log('   liveUi BEFORE prompt:', JSON.stringify(before))
  const isDone = before && before.phase === 'done'
  console.log('   banner is DONE (phase=done):', isDone)

  console.log('3) send prompt -> fires agent/pre-step -> clearStuckCompressingBanner (should be a NO-OP for DONE) ...')
  const prompt = await call('session/prompt', {
    request: { requestId: uuid(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply with the single word: ok' }] },
  })
  console.log('   prompt accepted:', !!(prompt && prompt.result && prompt.result.value && prompt.result.value.accepted))

  console.log('4) wait ~9s for the model step to run ...')
  await sleep(9000)
  const after = await liveUi()
  console.log('   liveUi AFTER prompt:', JSON.stringify(after))

  // The DONE banner should NOT have been force-overridden to a working pair by the
  // pre-step hook. (It stays 'done' or, at worst, the watermark left it alone. The
  // hook only pushes when phase==='compressing', so it must NOT appear here.)
  const hookDidNotClearDone = after && after.phase === 'done'
  console.log('\n=== RESULT ===')
  console.log('banner was DONE before:', isDone)
  console.log('banner still DONE after model request (hook did NOT clear it):', hookDidNotClearDone)
  if (isDone && hookDidNotClearDone) console.log('PASS — the DONE banner was left alone (conditional targets COMPRESSING only).')
  else if (!isDone) console.log('NOTE — the DONE banner did not stick; inconclusive.')
  else console.log('NOTE — banner changed after the request (possibly the 3 s DONE fallback timer fired, which is expected and separate from the hook).')
  process.exitCode = (isDone && hookDidNotClearDone) ? 0 : 3
}
main().catch((e) => { console.error('FAILED', e); process.exitCode = 1 })
