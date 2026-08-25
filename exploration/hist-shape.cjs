#!/usr/bin/env node
/** Dump the RAW session.history response shape (top-level keys + first 3 entries verbatim). */
'use strict'
const http = require('http')
const crypto = require('crypto')
const PORT = process.argv[2] || '3180'
const SID = process.argv[3] || 'session-32890c9e-eb50-4205-b1a8-cfe9c8627de3'
const rpcId = crypto.randomUUID()
const body = JSON.stringify({ type: 'client-request', rpcId, method: 'session.history', payload: { sessionId: SID } })
const req = http.request(`http://127.0.0.1:${PORT}/api/session.history`,
  { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
  (res) => {
    let acc = ''
    res.on('data', (c) => { acc += c })
    res.on('end', () => {
      const j = JSON.parse(acc)
      const v = j.result?.value ?? j.result
      console.log('top-level value keys:', Object.keys(v))
      const arrKey = Object.entries(v).find(([_, x]) => Array.isArray(x))
      const arr = arrKey ? arrKey[1] : null
      if (!arr) { console.log(JSON.stringify(v).slice(0, 2000)); return }
      console.log(`array key: ${arrKey[0]}, length: ${arr.length}`)
      console.log('\n-- first entry --')
      console.log(JSON.stringify(arr[0], null, 1).slice(0, 1500))
      const comp = arr.find(e => e && e.type && e.type.startsWith('compaction/'))
      if (comp) {
        const ci = arr.indexOf(comp)
        console.log(`\n-- compaction event at array index ${ci} --`)
        console.log(JSON.stringify(arr[ci], null, 1))
      }
    })
  })
req.write(body); req.end()
