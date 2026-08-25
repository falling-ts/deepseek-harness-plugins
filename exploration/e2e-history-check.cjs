#!/usr/bin/env node
/** Assert the committed compaction bracket in the e2e session's persisted history.
 *  Wire shape (measured): value.events[] = { event: SessionEvent, <envelope?> }. */
'use strict'
const http = require('http')
const crypto = require('crypto')
const PORT = process.argv[2] || '3180'
const SID = process.argv[3] || 'session-32890c9e-eb50-4205-b1a8-cfe9c8627de3'
async function call(method, payload) {
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
;(async () => {
  const h = await call('session.history', { sessionId: SID })
  const rows = h.events ?? h.history ?? h
  const events = rows.map(unwrap)
  console.log(`event count: ${events.length}\n`)
  for (const ev of events) {
    const d = ev.data || {}
    if (!(ev.type === 'compaction/start' || ev.type === 'compaction/summary' || ev.type === 'compaction/end' || (ev.type === 'user/message' && (ev.surfaceOp || d.source?.kind === 'plugin')))) continue
    let tag = ev.type
    if (ev.surfaceOp) tag += ` REPLACE[${ev.surfaceOp.start}..${ev.surfaceOp.end}]`
    if (d.compactionId) tag += ` cid=${String(d.compactionId).slice(0,8)}…`
    let extra = ''
    if (ev.type === 'compaction/summary') extra = `provider=${d.provider} model=${String(d.model).slice(0,40)} range=${JSON.stringify(d.shadowedRange)} nShadowed=${(d.shadowedSeqs||[]).length} tok=${d.shadowedTokenCount}`
    else if (ev.type === 'user/message' && d.source?.kind === 'plugin') extra = `source={plugin:${d.source.plugin}}`
    else if (ev.type === 'user/message') {
      const blocks = Array.isArray(d.blocks) ? d.blocks : (Array.isArray(d.content) ? d.content : [])
      const txt = blocks.filter(b => b && b.type === 'text').map(b => String(b.text).replace(/\n/g, ' ')).join(' ').slice(0, 70)
      extra = `text="${txt}${txt.length >= 70 ? '…' : ''}"`
    }
    console.log(`seq=${ev.seq} ${tag}${extra ? ' | ' + extra : ''}`)
  }
  const comp = events.filter(e => e.type && e.type.startsWith('compaction/'))
  const cids = new Set(comp.map(e => e.data.compactionId))
  const starts = comp.filter(e => e.type === 'compaction/start')
  const summaries = comp.filter(e => e.type === 'compaction/summary')
  const ends = comp.filter(e => e.type === 'compaction/end')
  const replaces = events.filter(e => e.type === 'user/message' && e.surfaceOp && e.surfaceOp.op === 'replace')
  const ordered = (() => {
    const order = [
      ...(starts.length ? [[starts[0].seq, 'start']] : []),
      ...(summaries.length ? [[summaries[0].seq, 'summary']] : []),
      ...(replaces.length ? [[replaces[0].seq, 'replace']] : []),
      ...(ends.length ? [[ends[0].seq, 'end']] : []),
    ].sort((a, b) => a[0] - b[0]).map(x => x[1]).join('→')
    return order
  })()
  const ok = cids.size === 1 && starts.length >= 1 && summaries.length >= 1 && ends.length >= 1 &&
    !ends.every(e => !!e.data?.error) && replaces.some(r => r.data?.source?.plugin === 'compact')
  console.log('\n==== ASSERTION ====')
  console.log(`unique compactionIds: ${cids.size} (want exactly 1)`)
  console.log(`start/summary/replace/end counts: ${starts.length}/${summaries.length}/${replaces.length}/${ends.length}`)
  console.log(`order by seq: ${ordered} (want start→summary→replace→end)`)
  console.log(`errors on end events: ${ends.filter(e => e.data?.error).map(e => e.data.error).join('; ') || 'none'}`)
  console.log(ok ? 'VERDICT: PASS — bracket committed intact' : 'VERDICT: FAIL')
  process.exit(ok ? 0 : 1)
})().catch(e => { console.error('fatal:', e); process.exit(1) })
