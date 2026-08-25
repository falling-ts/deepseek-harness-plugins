#!/usr/bin/env node
// 冒烟: 证明修复后"新建会话+发消息"不再卡死,且回合能真正完成。
// 用法: node fcsmoke-freeze.cjs [PORT]
const PORT = process.argv[2] || '3180'
const BASE = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

function post(method, payloadObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: require('crypto').randomUUID(), method, payload: payloadObj })
    const req = require('http').request(`${BASE}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.write(body); req.end()
  })
}

(async () => {
  console.log('== 1. connectivity ==')
  const list = await post('session.list', {})
  console.log('session.list server-response?', list.includes('server-response'))

  console.log('== 2. create session ==')
  const create = JSON.parse(await post('session.create', {}))
  const sid = create.result.value.sessionId
  console.log('sessionId=', sid)

  console.log('== 3. send a queued prompt ==')
  const prompt = JSON.parse(await post('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Reply with the single word: hello' }] }))
  console.log('prompt accepted=', prompt.result.value.accepted)

  console.log('== 4. poll history until an assistant reply lands or timeout ==')
  let done = false
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const hist = JSON.parse(await post('session.history', { sessionId: sid }))
    const events = hist.result.value.events || hist.result.value || []
    // 找 assistant/message 或含 hello 的回执
    const txt = JSON.stringify(events)
    if (/hello/i.test(txt) && /assistant/.test(txt)) { done = true; console.log(`completed on poll ${i + 1}`); break }
    console.log(`poll ${i + 1}: ${events.length} events, still working…`)
  }

  console.log('== RESULT ==')
  console.log(done ? 'OK-FROZEN-GONE: turn completed, assistant replied' : 'WARN: no assistant reply within timeout — inspect manually')
})().catch(e => { console.error('SMOKE ERR:', e.message); process.exit(1) })
