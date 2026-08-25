'use strict';
// Live-shape ledger check: import the PLUGIN'S pairing.js against a MOCK session
// that reproduces the OBSERVED shapes (dense events[] + SPARSE surface.nodes[]
// of bare seqs). Asserts the four correctness properties, mirroring the
// official compaction-loop-repro precedent. Run: node ledger-livecheck.mjs
import { eventDelta, toolPairingBalancedAfter, toolPairingBalancedBefore,
         toolPairingBalancedAfterSafe, toolPairingBalancedBeforeSafe } from '../dsh-force-compact/src/core/pairing.js'

// --- Build a synthetic session that mirrors the REAL observed shapes --------
// events[] DENSE by seq. Interleave log-only events (turn/*, step/*, tool/call)
// with surface-eligible ones (user/message, assistant/message w/ tool-call
// blocks, tool/result). Surface nodes = SPARSE seq list in model-visible order.
const events = []
// seq 0,1: log-only
events[0] = { type: 'turn/start', seq: 0, data: { turn: 1 } }
events[1] = { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }
// seq 2: user message (surface #0)
events[2] = { type: 'user/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'hi' }] } } }
// seq 3,4: log-only
events[3] = { type: 'step/end', seq: 3, data: { turn: 1, step: 1 } }
events[4] = { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'complete' } } }
// seq 5: assistant WITH TWO tool calls (surface #1) -> +2
events[5] = { type: 'assistant/message', seq: 5, data: { message: { content: [
  { type: 'text', text: 'calling tools' },
  { type: 'tool-call', id: 'tc1' },
  { type: 'tool-call', id: 'tc2' },
] } } }
// seq 6,7: log-only tool/call
events[6] = { type: 'tool/call', seq: 6, data: { callId: 'tc1' } }
events[7] = { type: 'tool/call', seq: 7, data: { callId: 'tc2' } }
// seq 8: tool/result #1 (surface #2) -> -1  => running now 1 (STILL OPEN)
events[8] = { type: 'tool/result', seq: 8, data: { message: { content: [{ type: 'text', text: 'r1' }] } } }
// seq 9: tool/result #2 (surface #3) -> -1  => running now 0 (CLOSED)
events[9] = { type: 'tool/result', seq: 9, data: { message: { content: [{ type: 'text', text: 'r2' }] } } }
// seq 10: user message (surface #4)
events[10] = { type: 'user/message', seq: 10, data: { message: { content: [{ type: 'text', text: 'thanks' }] } } }

const surfaceNodes = [2, 5, 8, 9, 10] // SPARSE, exactly the observed pattern
const session = { events, surface: { nodes: surfaceNodes, replaceGeneration: 0 } }

let failed = 0
function assert(label, cond) {
  const ok = !!cond
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

// (a) FIRST node's leading cut is trivially balanced
assert('(a) balancedBefore(first surface node seq 2) === true',
       toolPairingBalancedBefore(session, 2) === true)
// (b) MID-TOOL position: AFTER the first tool/result (seq 8) ONE call still open
assert('(b) balancedAfter(mid-tool seq 8) === false',
       toolPairingBalancedAfter(session, 8) === false)
// (c) TOOL-BOUNDARY position: AFTER the second tool/result (seq 9) all closed
assert('(c) balancedAfter(tool-close seq 9) === true',
       toolPairingBalancedAfter(session, 9) === true)
// (d) LAST node's trailing cut reflects the closed tail
assert('(d) balancedAfter(last surface node seq 10) === true',
       toolPairingBalancedAfter(session, 10) === true)
// (e) THE KEY DIFFERENCE the ledger enables: seq 9 is NOT a user/message yet IS a
//     balanced END boundary — the old heuristic could only stop at seq 10.
assert("(e) seq 9 is not user/message (it's tool/result)",
       events[9].type === 'tool/result')
assert('(e2) so ledger lets us CUT at 9, the old user-msg rule forced 10',
       toolPairingBalancedAfter(session, 9) === true && events[9].type !== 'user/message')
// (f) safe variants NEVER throw, mirror the throwing predicates here
assert('(f) safe-after(seq 8) === false (same math, no throw)',
       toolPairingBalancedAfterSafe(session, 8) === false)
// (g) foreign seq (not on surface) throws on the RAW variant
let threw = false
try { toolPairingBalancedAfter(session, 1000) } catch (e) { threw = true }
assert('(g) raw predicate THROWS on a foreign seq', threw)
// (h) safe variant degrades foreign seq to 'assume balanced' (true)
assert('(h) SAFE variant resolves foreign seq to true (degrade, no wedge)',
       toolPairingBalancedAfterSafe(session, 1000) === true)
// (i) incrementality: a second read over the SAME cache must be consistent
assert('(i) repeated read is stable (cache reuse)',
       toolPairingBalancedAfter(session, 9) === true)
// (j) eventDelta sanity on the actual event objects
assert('(j) eventDelta(assistant w/ 2 tool-calls) === 2', eventDelta(events[5]) === 2)
assert('(j2) eventDelta(tool/result) === -1', eventDelta(events[8]) === -1)
assert('(j3) eventDelta(user/message) === 0', eventDelta(events[2]) === 0)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)
