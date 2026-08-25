#!/usr/bin/env node
/** Fire settings.describe ONCE against the given port and pretty-print whatever
 *  comes back — used to disambiguate whether the endpoint is missing outright
 *  (router 404) or responding with an empty/missing namespace view (business 200).
 */
const http = require('http')
const PORT = Number(process.argv[2] || 3180)
const payload = JSON.stringify({
  type: 'client-request',
  rpcId: `diag-${Date.now()}`,
  method: 'settings.describe',
  payload: {},
})
const req = http.request({
  hostname: '127.0.0.1',
  port: PORT,
  path: '/api/settings.describe',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
}, (res) => {
  let chunks = []
  res.on('data', (c) => chunks.push(c))
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    console.log('HTTP', res.statusCode)
    try {
      const j = JSON.parse(text)
      console.log(JSON.stringify(j, null, 2).slice(0, 4000))
    } catch {
      console.log('non-JSON response:')
      console.log(text.slice(0, 2000))
    }
  })
})
req.on('error', (e) => { console.error('transport error:', e.message); process.exit(2) })
req.setTimeout(15000, () => { console.error('timed out'); process.exit(3) })
req.write(payload)
req.end()
