// fc-stuck-banner-3180.cjs — prove the "stuck [强制压缩中>>] banner" fix:
//  1) create a fresh session;
//  2) push a FAKE pinned COMPRESSING banner into falling-ts-force-compact.liveUi
//     (simulating the banner a never-committed compaction leaves, or one that
//     PERSISTED across a restart);
//  3) send a prompt -> fires agent/pre-step -> clearStuckCompressingBanner()
//     (isCompactionActive=false for a fresh session) -> publishRequesting()
//     which OVERRIDES the bracket with this step's REAL phase (模型请求中);
//  4) read settings/describe -> liveUi.text must no longer be the bracket.
//
// NOTE (2026-10 phase rework): the override used to publish a random "working
// pair"; it now publishes the requesting phase. The field carries no colour any
// more, and every phase overwrites unconditionally (the old `[`-prefix gate is
// gone), so what this script really proves is that the STALE banner does not
// survive the next model step.
const BASE = 'http://127.0.0.1:3080/api'
const NS = 'falling-ts-force-compact'

async function call(method, args) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'stuck-' + Date.now() + '-' + Math.random().toString(36).slice(2), method, payload: { args } }),
  })
  const json = await res.json().catch(() => null)
  return json
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uuid = () => (globalThis.crypto?.randomUUID?.() || 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2))

async function liveUi() {
  // settings/describe takes NO args and returns { writable, hasDocument, namespaces: [...] };
  // the live values for a namespace sit under namespaces[i].value.
  const r = await call('settings/describe', {})
  const v = r && r.result && r.result.value
  const ns = (v && Array.isArray(v.namespaces) ? v.namespaces : []).find(n => n && n.ns === NS)
  return (ns && ns.value && ns.value.liveUi) || undefined
}

async function main() {
  console.log('0) smoke: session/list')
  const list = await call('session/list', { _request: {} })
  console.log('   ok:', !!(list && list.result && list.result.ok))

  console.log('1) create session ...')
  const created = await call('session/create', { request: {} })
  const sessionId = created && created.result && created.result.value && created.result.value.sessionId
  console.log('   sessionId:', sessionId || '(FAILED)')
  if (!sessionId) { console.error('cannot continue without a session'); process.exitCode = 1; return }

  console.log('2) push a pinned COMPRESSING banner (REAL shape) into liveUi ...')
  // Real payload shape, exactly what publishCompressing() writes.
  const fakeBanner = { phase: 'compressing', text: '[强制压缩中>>>]', textId: 'compressing' }
  const up = await call('settings/update', { ns: NS, patch: { liveUi: fakeBanner }, expectedRevision: undefined })
  console.log('   update ok:', !!(up && up.result && up.result.ok))
  await sleep(500)
  const before = await liveUi()
  console.log('   liveUi BEFORE prompt:', JSON.stringify(before))
  const isStuck = before && typeof before.text === 'string' && before.text.startsWith('[')
  console.log('   banner is bracket-pinned (stuck state):', isStuck)

  console.log('3) send prompt -> fires agent/pre-step -> clearStuckCompressingBanner ...')
  const prompt = await call('session/prompt', {
    request: { requestId: uuid(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply with the single word: ok' }] },
  })
  console.log('   prompt accepted:', !!(prompt && prompt.result && prompt.result.value && prompt.result.value.accepted))

  console.log('4) wait ~9s for the model step to run ...')
  await sleep(9000)
  const after = await liveUi()
  console.log('   liveUi AFTER prompt:', JSON.stringify(after))

  const overridden = after && typeof after.text === 'string' && !after.text.startsWith('[')
  console.log('\n=== RESULT ===')
  console.log('stuck banner was bracket-pinned before:', isStuck)
  console.log('banner replaced by a real agent phase after model request:', overridden)
  if (isStuck && overridden) console.log('PASS — the stale [强制压缩中>>>] banner did not survive the model request (fix works).')
  else if (!isStuck) console.log('NOTE — the fake banner did not stick (schema may reject/strip it); override check inconclusive.')
  else console.log('FAIL — banner still bracket-pinned after the model request.')
  process.exitCode = (isStuck && overridden) ? 0 : 2
}

main().catch((e) => { console.error('FAILED', e); process.exitCode = 1 })
