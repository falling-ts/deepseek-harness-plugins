#!/usr/bin/env node
// fc-stormfix.cjs — validate the STORM FIX on a live instance (default 3180).
// Builds a LONG-enough session that the idle head-anchored region EXCEEDS the
// 128-message replay cap, then waits through several idle transitions and tails
// the plugin debug log to prove:
//   (a) the region is REFUSED by the size cap (no doomed LLM round-trip), and
//   (b) NO livelock: the same span is NOT re-attempted every tick.
// Usage: node fc-stormfix.cjs [port]

const PORT = parseInt(process.argv[2] || '3180', 10)
const BASE = `http://127.0.0.1:${PORT}/api`
const LOG = process.env.USERPROFILE + '\\.dsh\\logs\\dsh-force-compact.log'

async function rpc(method, payload) {
  const r = await fetch(`${BASE}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: Math.random().toString(36).slice(2), method, payload: payload ?? {} }),
  })
  const txt = await r.text(); let json
  try { json = JSON.parse(txt) } catch { throw new Error(`HTTP ${r.status} non-JSON: ${txt.slice(0,200)}`) }
  if (json.result && json.result.ok === false) throw new Error(`${method} -> ${json.result.error||'rejected'}`)
  return json.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log(`== fc-stormfix port=${PORT} ==`)
  const created = await rpc('session.create', {})
  const sid = created && (created.sessionId || created.id)
  console.log(`session ${sid}`)
  // Send several turns so the surface accumulates >128 messages across idle
  // transitions. Each turn adds user + assistant (+ possibly tool) nodes.
  const N = 40
  for (let i = 1; i <= N; i++) {
    const v = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: `Round ${i}: reply with the word READY.` }] })
    if (!v || v.accepted !== true) { console.log(`round ${i} NOT accepted`); break }
    // wait for idle before the next round (bounded)
    let idle = false
    for (let w = 0; w < 40 && !idle; w++) { await sleep(500); idle = (await isIdle(sid)) }
  }
  console.log(`sent ${N} rounds; waiting 20s for idle-driven compactions to settle...`)
  await sleep(20000)

  // Tail the log: show the LAST occurrence of each signature line.
  const fs = require('node:fs')
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/) } catch (e) { console.log('LOG READ FAIL:', e.message); return }
  const sig = [
    ['REFUSED', /replay cap|REFUSED/i],
    ['SKIPPED(cooldown)', /cooldown/i],
    ['no compactable', /no compactable region/i],
    ['OK commit', /builtin compaction OK/i],
    ['transaction error', /transaction ended in error/i],
    ['TEMP-DIAG stack', /TEMP-DIAG/i],
    ['stream not iterable', /did NOT return an async iterable|STREAM_NOT_ITERABLE/i],
    ['NO_FINISH', /without a terminal finish chunk|NO_FINISH/i],
  ]
  console.log('\n=== sign-line tally over the whole log ===')
  for (const [label, re] of sig) {
    const hits = lines.filter(l => re.test(l))
    const last = hits.length ? hits[hits.length-1].trim() : '(none)'
    console.log(`  ${label.padEnd(20)} count=${hits.length}\n      last: ${last.slice(-240)}`)
  }
  console.log(`\nsession ${sid} — DONE.`)
}

async function isIdle(sid) {
  try {
    const list = await rpc('session.list', {})
    const arr = (list && (Array.isArray(list) ? list : list.items)) || []
    const s = arr.find(x => (x.id || x.sessionId) === sid)
    return !!s && /idle/.test(JSON.stringify(s) || '')
  } catch { return true }
}

main().then(() => console.log('\n== DONE ==')).catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1) })
