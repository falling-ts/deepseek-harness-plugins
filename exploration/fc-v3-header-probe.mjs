/**
 * fc-v3-header-probe.mjs — standalone regression probe for the harness 0.1.5
 * `EpochHeader.system` removal in dsh-force-compact's summarizer.
 *
 * Asserts `headerPrefix()`:
 *  - derives the system text from surface node 0's `system/message` when the
 *    request header no longer carries `system` (0.1.5 V3);
 *  - still passes through `header.system` when present (pre-V3);
 *  - always forwards `header.tools`.
 *
 * Run: node D:\deepseek-harness-plugins\exploration\fc-v3-header-probe.mjs
 */
import { headerPrefix } from '../dsh-force-compact/src/engine/summarizer.js'

const sysEvent = {
  type: 'system/message',
  seq: 0,
  time: 0,
  data: { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'SYS-A' }, { type: 'text', text: 'SYS-B' }] } },
}
const userEvent = { type: 'user/message', seq: 1, time: 0, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }
const events = [sysEvent, userEvent]
const tools = [{ name: 't1' }]

function session(head) {
  return {
    surface: { nodes: [0, 1], replaceGeneration: 0 },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    requestHeader: () => head,
  }
}

let failed = false
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failed = true
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

console.log('— 0.1.5: header without system, system/message at node 0 —')
{
  const p = headerPrefix(session({ config: {}, tools }))
  check('system', p.system, 'SYS-ASYS-B')
  check('tools', JSON.stringify(p.tools), JSON.stringify(tools))
}

console.log('— pre-V3: header carries system —')
{
  const p = headerPrefix(session({ config: {}, system: 'HEADER-SYS', tools }))
  check('system', p.system, 'HEADER-SYS')
  check('tools', JSON.stringify(p.tools), JSON.stringify(tools))
}

console.log('— no system head, no header.system —')
{
  const s = session({ config: {}, tools })
  s.surface = { nodes: [1], replaceGeneration: 0 }
  s.eventAt = (seq) => (seq === 1 ? userEvent : undefined)
  const p = headerPrefix(s)
  check('system', p.system, undefined)
  check('tools', JSON.stringify(p.tools), JSON.stringify(tools))
}

console.log('— defensive: no requestHeader / null session —')
{
  check('null session', JSON.stringify(headerPrefix(null)), '{}')
  check('no requestHeader', JSON.stringify(headerPrefix({ surface: { nodes: [1] } })), '{}')
}

if (failed) {
  console.error('\nPROBE FAILED')
  process.exitCode = 1
} else {
  console.log('\nPROBE PASSED')
}
