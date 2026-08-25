#!/usr/bin/env node
// Send the LARGE turn 2 to an EXISTING session id on the given port, then poll until idle.
'use strict'
const [portArg, sid] = process.argv.slice(2)
if (!portArg || !sid) { console.error('usage: fcturn2.cjs <PORT> <sessionId>'); process.exit(2) }
const PORT = /^\d+$/.test(portArg) ? parseInt(portArg, 10) : 3180
const BASE = 'http://127.0.0.1:' + PORT
let n = 0
async function rpc(m, p) {
  const id = 't2-' + (++n)
  const r = await fetch(BASE + '/api/' + m, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: id, method: m, payload: p }),
  })
  const j = await r.json()
  if (!r.ok || (j.result && j.result.ok === false)) throw new Error(m + ' -> ' + JSON.stringify(j).slice(0, 200))
  return j.result ? j.result.value : undefined
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
(async () => {
  const filler = '这是用于填充上下文的中文段落，用来确保本次请求的总上下文 tokens 超过自动压缩阈值。'.repeat(80)
  const p = await rpc('session.prompt', {
    sessionId: sid, mode: 'queue',
    content: [{ type: 'text', text: filler + '\n\n现在请简短总结以上填充内容（只需一句）。' }],
  })
  console.error('[t2] queued accepted=' + JSON.stringify(p && (p.accepted !== undefined ? p.accepted : p)))
  const dl = Date.now() + 300000
  for (;;) {
    if (Date.now() > dl) throw new Error('did not go idle in 300s')
    const rows = await rpc('session.list', {})
    const items = Array.isArray(rows) ? rows : (rows && (rows.sessions || rows.items || rows.rows)) || []
    const me = items.find(s => (s.sessionId || s.id) === sid)
    if (me && !me.running) { console.error('[t2] idle at ' + new Date().toISOString()); return }
    await sleep(1000)
  }
})().catch(e => { console.error('[t2] FAILED: ' + (e && e.message || e)); process.exit(1) })
