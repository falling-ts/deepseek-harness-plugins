#!/usr/bin/env node
/** Print the per-node content mass of the COMPRESSED SPAN (seq 11..14) so we can see
 *  how the backward accumulation crossed the 8000 budget. */
'use strict'
const http = require('http')
const crypto = require('crypto')
const PORT = process.argv[2] || '3180'
const SID = process.argv[3] || 'session-32890c9e-eb50-4205-b1a8-cfe9c8627de3'
function call(method, payload) {
  const rpcId = crypto.randomUUID()
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload })
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${PORT}/api/${method}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let acc = ''
        res.on('data', (c) => { acc += c })
        res.on('end', () => {
          const j = JSON.parse(acc)
          const r = j.result || {}
          if (r.ok === false) return reject(new Error(JSON.stringify(r)))
          resolve(r.value)
        })
      })
    req.write(body); req.end()
  })
}
const unwrap = (row) => (row && row.event ? row.event : row)
const textMass = (ev) => {
  const d = ev.data || {}
  const blocks = Array.isArray(d.blocks) ? d.blocks : (Array.isArray(d.content) ? d.content : [])
  return blocks.reduce((sum, b) => sum + ((b && typeof b.text === 'string') ? b.text.length : 0), 0)
}
;(async () => {
  const h = await call('session.history', { sessionId: SID })
  const events = (h.events ?? []).map(unwrap)
  console.log('span seq 11..14 per-node masses (chars and ~chars/4):\n')
  let runningBackward = 0
  const spanRows = []
  for (const ev of events) {
    if (ev.seq === null || ev.seq === undefined) continue
    if (ev.seq >= 11 && ev.seq <= 14) spanRows.push(ev)
  }
  spanRows.sort((a, b) => b.seq - a.seq)
  for (const ev of spanRows) {
    const ch = textMass(ev)
    runningBackward += Math.ceil(ch / 4)
    let label = ev.type
    if (ev.type === 'user/message') {
      const d = ev.data || {}
      const blocks = Array.isArray(d.blocks) ? d.blocks : (Array.isArray(d.content) ? d.content : [])
      const firstText = blocks.find(b => b && b.type === 'text')
      const snippet = firstText ? String(firstText.text).replace(/\s+/g, ' ').slice(0, 80) : '(non-text)'
      label += ` «${snippet}…»`
      if (d.source?.kind === 'plugin') label = `(previously ${d.source.plugin})`
    }
    console.log(`seq=${ev.seq} ${label.padEnd(60)} chars=${String(ch).padStart(6)} cumBackward≈${runningBackward}tok`)
  }
  console.log(`\ntotal compressed span chars≈${spanRows.reduce((s,e)=>s+textMass(e),0)}, i.e. ≈${Math.ceil(spanRows.reduce((s,e)=>s+textMass(e),0)/4)} tokens`)
})().catch(e => { console.error('fatal:', e); process.exit(1) })
