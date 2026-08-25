#!/usr/bin/env node
/** Call settings.describe and extract ONLY the target namespace (default
 *  falling-ts-force-compact) — prints its full schema/value/base so the
 *  operator sees whether the plugin's namespace is LIVE. */
const http = require('http')
const NS_WANTED = process.argv[3] || 'falling-ts-force-compact'
const payload = JSON.stringify({
  type: 'client-request',
  rpcId: `extract-${Date.now()}`,
  method: 'settings.describe',
  payload: {},
})
const req = http.request({
  hostname: '127.0.0.1',
  port: Number(process.argv[2] || 3180),
  path: '/api/settings.describe',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
}, (res) => {
  let chunks = []
  res.on('data', (c) => chunks.push(c))
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    const j = JSON.parse(text)
    const nsList = j.result?.value?.namespaces || []
    const mine = nsList.find((n) => n.ns === NS_WANTED || n.id === NS_WANTED)
    console.log('total namespaces advertised:', nsList.length)
    if (!mine) {
      console.log(`namespace "${NS_WANTED}" ABSENT — ids present:`, nsList.map((n) => n.ns || n.id).join(', '))
      process.exit(0)
    }
    console.log(`\n=== ${NS_WANTED} FOUND ===`)
    console.log(JSON.stringify(mine, null, 2))
  })
})
req.on('error', (e) => { console.error('transport error:', e.message); process.exit(2) })
req.setTimeout(15000, () => { console.error('timed out'); process.exit(3) })
req.write(payload)
req.end()
