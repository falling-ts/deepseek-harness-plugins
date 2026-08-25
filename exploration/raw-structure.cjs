#!/usr/bin/env node
/** Show the raw data shape of one user/message and one assistant/tool node to fix the
 *  text-mass extractor. */
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
;(async () => {
  const h = await call('session.history', { sessionId: SID })
  const events = (h.events ?? []).map(row => (row && row.event ? row.event : row))
  for (const target of ['user/message', 'assistant/message', 'tool/result']) {
    const found = events.find(e => e.type === target)
    if (!found) { console.log(`${target}: none found`); continue }
    console.log(`==== ${target} @ seq ${found.seq} — data keys: ${Object.keys(found.data || {}).join(', ')} ====`)
    console.log(JSON.stringify(found.data).slice(0, 900), '\n')
  }
})().catch(e => { console.error('fatal:', e); process.exit(1) })
