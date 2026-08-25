#!/usr/bin/env node
// fchistshape.cjs — dump the RAW shape of `session.history` so we learn the
// exact envelope/field names before building the surface verifier.
const PORT = parseInt(process.argv[2] || '3180', 10)
const sid = process.argv[3]
async function rpc(method, payload) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: Math.random().toString(36).slice(2), method, payload: payload ?? {} }) })
  const txt = await r.text(); return JSON.parse(txt).result?.value
}
(async () => {
  const h = await rpc('session.history', { sessionId: sid })
  console.log('history top type:', h && typeof h, Array.isArray(h) ? `(array len ${h.length})` : '')
  console.log('top keys:', h && !Array.isArray(h) ? Object.keys(h).join(', ') : '(bare array)')
  const first = Array.isArray(h) ? h[0] : (h && (h.events ? h.events[0] : h))
  console.log('first item keys:', first ? Object.keys(first).join(', ') : '(none)')
  console.log('FIRST ITEM JSON (truncated):\n', JSON.stringify(first, null, 2).slice(0, 1500))
  // find any compaction event + any user/message with surfaceOp
  const arr = Array.isArray(h) ? h : (h && h.events) || []
  const comp = arr.filter(e => String(e.type||'').startsWith('compaction/'))
  console.log(`\ncompaction/* events: ${comp.length}`)
  for (const e of comp.slice(-6)) console.log(' ', JSON.stringify(e).slice(0, 300))
  const msgs = arr.filter(e => String(e.type||'')==='user/message')
  console.log(`user/message events: ${msgs.length}`)
})().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
