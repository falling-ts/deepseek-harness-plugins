'use strict'
;(async () => {
  const sid = 'session-aeb1c9da-bc5c-4acb-8c12-759e94d53a24'
  const crypto = require('node:crypto')
  const rpc = { type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.history', payload: { sessionId: sid } }
  const r = await fetch('http://127.0.0.1:3180/api/session.history', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc),
  })
  const raw = await r.text()
  const o = JSON.parse(raw)
  const dumpTop = (obj, depth = 0) => {
    const pad = '  '.repeat(depth)
    const keys = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : (Array.isArray(obj) ? 'ARRAY(len ' + obj.length + ')' : typeof obj)
    console.log(pad + (depth === 0 ? 'ROOT' : 'KEY') + ': ' + JSON.stringify(keys))
    if (depth < 3 && obj && typeof obj === 'object' && !Array.isArray(obj)) for (const k of Object.keys(obj)) dumpTop(obj[k], depth + 1)
  }
  if (!o.result.ok) {
    console.error('RPC ERROR:', JSON.stringify(o.result.error))
    process.exit(2)
  }
  const histVal = o.result.value
  const items = Array.isArray(histVal) ? histVal : histVal.events
  let nodes = []
  const replaces = []
  for (const item of items) {
    const e = item.event
    if (!['user/message', 'assistant/message', 'tool/result'].includes(e.type)) continue
    const op = e.surfaceOp
    if (op && op.op === 'replace') {
      const si = nodes.indexOf(op.start)
      const ei = nodes.indexOf(op.end)
      let shadowedTxt = '(bounds not found)'
      if (si >= 0 && ei >= si) {
        shadowedTxt = nodes.slice(si, ei + 1).join(',')
        nodes.splice(si, ei - si + 1, e.seq)
      } else {
        nodes.push(e.seq)
      }
      replaces.push(`REPLACE seq=${e.seq} bounds=${op.start}..${op.end} actuallyShadowed=[${shadowedTxt}] declaredSourceEventSeqs=[${(e.sourceEventSeqs || []).join(',')}]`)
      continue
    }
    nodes.push(e.seq)
  }
  for (const l of replaces) console.log(l)
  console.log('FINAL SURFACE:', nodes.join(','))
  console.log('surface node count:', nodes.length)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
