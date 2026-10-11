// fc-stuck-done-3180.cjs — the DONE banner's lifecycle after the 2026-10 phase rework.
//
// WHAT CHANGED: `publishUiStatus` used to refuse to overwrite a `[`-bracketed
// text, and `publishDone` armed a 3 s fallback timer to repaint a random working
// pair. Both are gone. Every phase now overwrites unconditionally, and the DONE
// banner is superseded by the NEXT REAL AGENT PHASE — normally the requesting /
// responding phases of the model call that follows the compaction.
//
// So this script asserts the NEW behavior: after a model request, a pushed DONE
// banner must have been replaced by a real phase (never left on `done`).
// clearStuckCompressingBanner itself still only targets phase 'compressing' —
// that is asserted separately by fc-stuck-banner-3180.cjs.
const BASE = 'http://127.0.0.1:3080/api'
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

  // Real DONE banner shape, exactly what publishDone() writes.
  const doneBanner = { phase: 'done', text: '[压缩完成!]', textId: 'done' }
  console.log('2) push a DONE banner (REAL shape) into liveUi ...')
  const up = await call('settings/update', { ns: NS, patch: { liveUi: doneBanner }, expectedRevision: undefined })
  console.log('   update ok:', !!(up && up.result && up.result.ok))
  await sleep(500)
  const before = await liveUi()
  console.log('   liveUi BEFORE prompt:', JSON.stringify(before))
  const isDone = before && before.phase === 'done'
  console.log('   banner is DONE (phase=done):', isDone)

  console.log('3) send prompt -> fires agent/pre-step, then the model request publishes its own phase ...')
  const prompt = await call('session/prompt', {
    request: { requestId: uuid(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply with the single word: ok' }] },
  })
  console.log('   prompt accepted:', !!(prompt && prompt.result && prompt.result.value && prompt.result.value.accepted))

  console.log('4) wait ~9s for the model step to run ...')
  await sleep(9000)
  const after = await liveUi()
  console.log('   liveUi AFTER prompt:', JSON.stringify(after))

  // The DONE banner must have been superseded by a REAL agent phase: either a
  // model-action phase or the conversation-end clear. `done` lingering here would
  // mean the natural-cadence overwrite is broken.
  const PHASES = ['requesting', 'responding', 'tooling', 'compressing', 'end']
  const superseded = after && PHASES.includes(after.phase)
  console.log('\n=== RESULT ===')
  console.log('banner was DONE before:', isDone)
  console.log('DONE banner superseded by a real phase after the request:', superseded, `(now phase=${after && after.phase})`)
  if (isDone && superseded) console.log('PASS — the DONE banner gave way to the next real agent phase (natural cadence works).')
  else if (!isDone) console.log('NOTE — the DONE banner did not stick; inconclusive.')
  else console.log('FAIL — the DONE banner is still displayed after a model request; the next phase did not overwrite it.')
  process.exitCode = (isDone && superseded) ? 0 : 3
}
main().catch((e) => { console.error('FAILED', e); process.exitCode = 1 })
