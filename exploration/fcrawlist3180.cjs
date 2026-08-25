#!/usr/bin/env node
// Dump the RAW session.list response shape (truncated) so the real field names
// become obvious.
const port = process.argv[2] || '3180'
const base = `http://127.0.0.1:${port}`
;(async () => {
  const res = await fetch(`${base}/api/session.list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'raw-list', method: 'session.list', payload: {} }) })
  const json = await res.json()
  const s = JSON.stringify(json, null, 2)
  console.log('RAW (first 4000 chars):\n' + s.slice(0, 4000))
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1) })
