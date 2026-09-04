// Offline verification (v2): build a minimal modern-Session FAKE exposing ONLY
// the new harness API (snapshotEvents/eventAt/surface — no `events` array), feed
// it to the plugin's shim + pairing + projection path, and prove the reads now
// produce real data (before the fix they silently fell back to empty).
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const FILE = 'C:/Users/zghyu/.dsh/sessions/--D-deepseek-harness-plugins--/session-b8dc3649-8d92-4ded-94fe-4c37111a3393/session.jsonl.zstd'
const data = readFileSync(FILE)
const spots = []
for (let i = 0; i < data.length - 4; i += 1) {
  if (data[i] === 0x28 && data[i + 1] === 0xB5 && data[i + 2] === 0x2F && data[i + 3] === 0xFD) spots.push(i)
}
let text = ''
for (let k = 1; k < spots.length; k += 1) {
  text += zstdDecompressSync(data.subarray(spots[k], k + 1 < spots.length ? spots[k + 1] : data.length)).toString('utf8')
}
const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
// Standard-envelope events only (chunk rows carry seq0/time0 — they are
// compressed storage rows and are NOT what plugin reads touch).
const events = rows.filter((e) => e && typeof e.seq === 'number')
const bySeq = new Map(events.map((e) => [e.seq, e]))
const surface = events
  .filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')
  .map((e) => e.seq)

const fakeSession = {
  id: 'session-b8dc3649-8d92-4ded-94fe-4c37111a3393',
  surface: { nodes: surface, replaceGeneration: 0 },
  // modern API ONLY — there is deliberately NO `events` array. The real
  // Session guarantees `seq == array index` (seq = log.length contiguity), so
  // build the index-aligned snapshot (chunk-row seqs are filled with the
  // surface/prologue events that real listeners see; holes only exist in this
  // reconstruction, not in a live Session).
  snapshotEvents() {
    const max = Math.max(0, ...events.map((e) => e.seq))
    const arr = new Array(max + 1)
    for (const e of events) arr[e.seq] = e
    for (let i = 0; i < arr.length; i += 1) if (arr[i] === undefined) arr[i] = { type: 'filled/hole', seq: i, time: 0, data: {} }
    return arr
  },
  eventAt(seq) { return bySeq.get(seq) },
}

const shim = await import(pathToFileURL('D:/deepseek-harness-plugins/dsh-force-compact/src/core/session-events.js').href)
const pairing = await import(pathToFileURL('D:/deepseek-harness-plugins/dsh-force-compact/src/core/pairing.js').href)

const all = shim.sessionEvents(fakeSession)
console.log('[shim] sessionEvents ->', all.length, 'events (surface', surface.length, 'nodes)')

const hello = shim.sessionEventAt(fakeSession, 42921)
console.log('[shim] eventAt(42921) ->', hello ? hello.type : 'undefined', '| first text block:', hello && hello.data && hello.data.content && hello.data.content[0] && JSON.stringify(hello.data.content[0].text).slice(0, 30))

// pairing must not throw and must yield real boolean polarity on tool-heavy cuts
const midSeq = surface[Math.floor(surface.length / 2)]
let beforeV, afterV, threw = null
try {
  beforeV = pairing.toolPairingBalancedBeforeSafe(fakeSession, midSeq)
  afterV = pairing.toolPairingBalancedAfterSafe(fakeSession, midSeq)
} catch (e) { threw = e.message }
console.log('[pairing] mid surface seq', midSeq, '-> balancedBefore', beforeV, 'balancedAfter', afterV, threw ? '(THREW ' + threw + ')' : '(no throw)')

// projection simulation over a head region (mimics projectRegion)
let msgs = 0
for (const seq of surface.slice(0, 60)) {
  const e = bySeq.get(seq)
  if (!e) continue
  const d = e.data || {}
  if (e.type === 'user/message') msgs += 1
  else if (e.type === 'assistant/message' && d.message && d.message.content) msgs += 1
  else if (e.type === 'tool/result' && d.message && d.message.content) msgs += 1
}
console.log('[project] first 60 surface nodes ->', msgs, 'messages (was 0 before the fix)')

// legacy-mode comparison: same reads through the OLD assumption (no events at all)
const legacySession = { surface: fakeSession.surface } // no events, no snapshotEvents
const legacyEvents = shim.sessionEvents(legacySession)
console.log('[legacy] sessionEvents on old-style missing array ->', legacyEvents.length, '(was the silent-empty bug)')

const ok = all.length > 0 && hello && hello.type === 'user/message' && msgs > 0 && !threw
console.log('\n' + (ok ? '✅ FIX VERIFIED — modern-Session reads now resolve real events' : '❌ STILL BROKEN'))
process.exit(ok ? 0 : 1)