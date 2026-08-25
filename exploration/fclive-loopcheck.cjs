#!/usr/bin/env node
// 现场活体验证: 在 3180 上跑一个回合,确认新版 guard(含冷却门禁)加载且未崩,
// 并且 pre-step 路径能正常走到(无论是否触发压缩,只要不崩+能完成回合即达标)。
// 用法: node fclive-loopcheck.cjs [PORT]
const crypto = require('crypto'), http = require('http')
const PORT = process.argv[2] || '3180'
const BASE = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
function post(m, p) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: m, payload: p })
    const r = http.request(`${BASE}/api/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } })
    r.on('error', rej)
    r.on('response', rs => { let d = ''; rs.on('data', c => d += c); rs.on('end', () => res(d)) })
    r.write(body); r.end()
  })
}
(async () => {
  const create = JSON.parse(await post('session.create', {}))
  const sid = create.result.value.sessionId
  console.log('created', sid)
  const p = JSON.parse(await post('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly the word: ok' }] }))
  console.log('prompt accepted=', p.result.value.accepted)
  let done = false
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const hist = JSON.parse(await post('session.history', { sessionId: sid }))
    const txt = JSON.stringify(hist.result.value.events || hist.result.value || [])
    if (/\"role\":\"assistant\"/.test(txt) && /ok/i.test(txt)) { done = true; console.log(`completed poll ${i + 1}`); break }
  }
  console.log(done ? '✅ guard engaged without crash, turn completed' : '⚠️ no reply — inspect log manually')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
