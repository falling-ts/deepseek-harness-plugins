#!/usr/bin/env node
/** Reconstruct the surface as of the moment of compression in the e2e session:
 *  list ALL surface nodes in positional order with their rough token mass, marking
 *  the compressed span (seq 11..14) and what immediately preceded it. */
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
const collectStrings = (v, out) => {
  if (typeof v === 'string') { out.push(v); return }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out); return }
  if (v && typeof v === 'object') {
    // Skip replayState subtrees entirely — they're transport metadata, not conversation mass.
    for (const [k, val] of Object.entries(v)) {
      if (k === 'replayState') continue
      collectStrings(val, out)
    }
  }
}
const textMass = (ev) => {
  const strings = []
  collectStrings(ev.data, strings)
  return strings.join('').length
}
;(async () => {
  const h = await call('session.history', { sessionId: SID })
  const events = (h.events ?? []).map(unwrap).filter(e => e && e.seq != null)
  events.sort((a, b) => a.time - b.time || a.seq - b.seq)
  const SURF = new Set(['user/message', 'assistant/message', 'tool/result'])
  // Nodes that existed AS OF the compression moment = those appended before the
  // checkpoint event (seq 1125). Anything with seq > 1124 was added afterward.
  const ckptSeq = 1125
  const before = events.filter(e => e.seq < ckptSeq)
  const surfBefore = before.filter(e => SURF.has(e.type))
  console.log(`surface nodes present BEFORE the checkpoint (as of compress): ${surfBefore.length}\n`)
  console.log('last 12 such nodes (chronological):\n')
  const tail12 = surfBefore.slice(-12)
  let running = 0
  for (const ev of [...tail12].reverse()) {
    const ch = textMass(ev)
    running += Math.ceil(ch / 4)
    const d = ev.data || {}
    let label = ev.type
    if (ev.type === 'user/message') {
      const blocks = Array.isArray(d.content) ? d.content : (Array.isArray(d.blocks) ? d.blocks : [])
      const t = blocks.find(b => b && b.type === 'text')
      label += ` «${t ? String(t.text).replace(/\s+/g, ' ').slice(0, 60) : ''}»`
      if (d.source?.kind === 'plugin') label += ` [${d.source.plugin}]`
    }
    const inSpan = ev.seq >= 11 && ev.seq <= 14 ? '  <-- IN SPAN 11..14' : ''
    console.log(`seq=${ev.seq.toString().padEnd(5)} ${label.padEnd(78)} ~${String(Math.ceil(ch/4)).padStart(6)} tok  tailCum≈${running}tok${inSpan}`)
  }
})().catch(e => { console.error('fatal:', e); process.exit(1) })
