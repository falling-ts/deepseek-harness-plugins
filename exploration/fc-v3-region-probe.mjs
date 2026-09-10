/**
 * fc-v3-region-probe.mjs — standalone regression probe for the harness 0.1.5
 * session-format-V3 fix in dsh-force-compact's region selectors.
 *
 * Asserts that EVERY selector returns a span whose `start` is NOT surface node 0
 * when node 0 is the protected `system/message` (the core rejects a replace
 * covering it), and that it DOES start at node 0 when there is no system head
 * (pre-V3 compatibility).
 *
 * Run: node D:\deepseek-harness-plugins\exploration\fc-v3-region-probe.mjs
 */
import {
  selectRegion,
  selectRetainingLatestTokens,
  selectEarliestByTokens,
  selectEarliestByMeasurements,
} from '../dsh-force-compact/src/engine/region.js'

function buildEvents(withSystemHead) {
  const rows = [
    ['user/message', { role: 'user', content: [{ type: 'text', text: 'u1' }] }],
    ['assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] }, stream: [] }],
    ['user/message', { role: 'user', content: [{ type: 'text', text: 'u2' }] }],
    ['assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] }, stream: [] }],
    ['user/message', { role: 'user', content: [{ type: 'text', text: 'u3' }] }],
    ['assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'a3' }] }, stream: [] }],
  ]
  if (withSystemHead) {
    rows.unshift(['system/message', { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'SYS' }] } }])
  }
  return rows.map(([type, data], seq) => ({ type, seq, time: 0, data }))
}

function buildSession(withSystemHead) {
  const events = buildEvents(withSystemHead)
  const session = {
    id: 'probe',
    events,
    surface: { nodes: events.map(e => e.seq), replaceGeneration: 0 },
    snapshotEvents: () => events,
    eventAt: (seq) => events[seq],
  }
  const measurement = { totalTokens: events.length * 10, nodes: events.map(e => ({ seq: e.seq, tokens: 10 })) }
  return { session, measurement }
}

function run(withSystemHead) {
  const { session, measurement } = buildSession(withSystemHead)
  const expectedStart = withSystemHead ? 1 : 0
  const out = {
    selectRegion: selectRegion(session, { minNodes: 2, retainRatio: 0.34, minCompactableNodes: 1 }),
    selectRetainingLatestTokens: selectRetainingLatestTokens(session, 20, measurement),
    selectEarliestByTokens: selectEarliestByTokens(session, 20),
    selectEarliestByMeasurements: selectEarliestByMeasurements(session, 0.5, measurement, undefined),
  }
  let failed = false
  for (const [name, region] of Object.entries(out)) {
    if (region === null) {
      console.log(`  ${name}: null (no region)`)
      continue
    }
    const ok = region.start === expectedStart
    if (!ok) failed = true
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}: start=${region.start} end=${region.end} (expected start=${expectedStart})`)
  }
  return failed
}

console.log('— with system/message at node 0 (harness 0.1.5, V3) —')
const failedV3 = run(true)
console.log('— without a system head (pre-V3 compatibility) —')
const failedPre = run(false)
if (failedV3 || failedPre) {
  console.error('\nPROBE FAILED')
  process.exitCode = 1
} else {
  console.log('\nPROBE PASSED')
}
