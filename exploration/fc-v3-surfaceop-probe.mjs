/**
 * fc-v3-surfaceop-probe.mjs — integration probe against the REAL harness 0.1.5
 * session core (`packages/core/session/lib`), proving the two V3 contracts the
 * dsh-force-compact fix relies on:
 *
 *  1. `surfaceOp:{op:'replace',startSeq,endSeq}` folds successfully, while the
 *     pre-V3 `{op:'replace',start,end}` is rejected ("invalid replace surfaceOp").
 *  2. A replace covering surface node 0 (the `system/message`) is rejected by
 *     `assertSystemHeadRewrite` — which is why the region selectors must drop it.
 *
 * Run: node D:\deepseek-harness-plugins\exploration\fc-v3-surfaceop-probe.mjs
 */
const SESSION_LIB = 'file:///D:/deepseek-harness-plugins/deepseek-harness/packages/core/session/lib/index.js'
const { foldSurface } = await import(SESSION_LIB)

const sys = {
  type: 'system/message', seq: 0, time: 0,
  data: { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'SYS' }] } },
  surfaceOp: 'append',
}
const u1 = { type: 'user/message', seq: 1, time: 0, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'u1' }] }, surfaceOp: 'append' }
const u2 = { type: 'user/message', seq: 2, time: 0, data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'u2' }] }, surfaceOp: 'append' }

function replaceEvent(seq, surfaceOp, sourceEventSeqs) {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: {
      id: 'c1', role: 'user', content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'probe' },
    },
    surfaceOp,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

let failed = false
function report(name, fn, expectThrow) {
  try {
    const out = fn()
    if (expectThrow) {
      failed = true
      console.log(`  FAIL ${name}: expected a throw, got ${JSON.stringify(out)}`)
    } else {
      console.log(`  OK   ${name}: nodes=[${out.nodes.join(',')}]`)
    }
  } catch (error) {
    if (expectThrow) console.log(`  OK   ${name}: threw -> ${error.message}`)
    else {
      failed = true
      console.log(`  FAIL ${name}: unexpected throw -> ${error.message}`)
    }
  }
}

console.log('— V3 replace (startSeq/endSeq) commits —')
report('new fields', () => foldSurface([sys, u1, u2, replaceEvent(3, { op: 'replace', startSeq: 1, endSeq: 2 }, [1, 2])]), false)

console.log('— pre-V3 replace (start/end) is rejected —')
report('old fields', () => foldSurface([sys, u1, u2, replaceEvent(3, { op: 'replace', start: 1, end: 2 }, [1, 2])]), true)

console.log('— a replace covering node 0 (system head) is rejected —')
report('covers node 0', () => foldSurface([sys, u1, u2, replaceEvent(3, { op: 'replace', startSeq: 0, endSeq: 2 }, [0, 1, 2])]), true)

console.log('— a replace starting AFTER node 0 commits (the fixed selectors) —')
report('starts after head', () => foldSurface([sys, u1, u2, replaceEvent(3, { op: 'replace', startSeq: 1, endSeq: 2 }, [1, 2])]), false)

if (failed) {
  console.error('\nPROBE FAILED')
  process.exitCode = 1
} else {
  console.log('\nPROBE PASSED')
}
