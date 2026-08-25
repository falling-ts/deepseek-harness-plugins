#!/usr/bin/env node
// 复现"低阈值下连发三条, 第三条卡死/失败"的时序脚本(修正版: 可靠轮询 running 状态)。
const crypto = require('crypto'), http = require('http')
const PORT = process.argv[2] || '3180'
const PER_TURN_TIMEOUT_S = parseFloat(process.argv[3] || '30')
const BASE = `http://127.0.0.1:${PORT}`
const T0 = Date.now()
const ts = () => `+${((Date.now()-T0)/1000).toFixed(1)}s`
const sleep = ms => new Promise(r => setTimeout(r, ms))

function post(method, payload, timeoutMs) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload })
    const req = http.request(`${BASE}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, rs => {
      let d = ''; rs.on('data', c => (d += c)); rs.on('end', () => res({ status: rs.statusCode, text: d }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`TIMEOUT ${timeoutMs}ms (${method})`)))
    req.on('error', rej); req.write(body); req.end()
  })
}

// 从一个 item JSON 串里读出它的 running/blank(顶层字段)
function extractFlags(itemJson) {
  const running = /"running"\s*:\s*(true|false)/.exec(itemJson)
  const blank = /"blank"\s*:\s*(true|false)/.exec(itemJson)
  return { running: running ? running[1] === 'true' : null, blank: blank ? blank[1] === 'true' : null }
}
async function getState(sid) {
  const r = await post('session.list', {}, 10000)
  const j = r.text.indexOf(sid)
  if (j < 0) return null
  // 截取一个足够长的窗口, 但限定在下一个 sessionId 之前, 避免读到别家的 running
  const nxt = r.text.indexOf('"sessionId"', j + sid.length)
  const win = r.text.slice(j, nxt > 0 ? Math.min(nxt, j + 6000) : j + 6000)
  return extractFlags(win)
}
async function waitForIdle(sid, label) {
  const deadline = Date.now() + PER_TURN_TIMEOUT_S * 1000
  let polls = 0
  while (Date.now() < deadline) {
    const g = await getState(sid)
    polls++
    if (g && g.running === false) return { ok: true, polls, note: `idle blank=${g.blank}` }
    if (g && g.running === null) return { ok: true, polls, note: 'session vanished?' }
    await sleep(800)
  }
  const last = await getState(sid)
  return { ok: false, polls, note: `WEDGE after ${polls} polls (running=${last ? last.running : '?'}, blank=${last ? last.blank : '?'})` }
}

;(async () => {
  const cr = await post('session.create', {}, 15000)
  const m = cr.text.match(/"sessionId"\s*:\s*"([^"]+)"/)
  const sid = m ? m[1] : null
  console.log(ts(), `CREATE status=${cr.status} sid=${sid}`)
  if (!sid) { console.log(ts(), 'CREATE FAIL', cr.text.slice(0, 200)); return }

  const msgs = [
    'Reply with the single word: HELLO',
    'Count from 1 to 5, one number per line. Nothing else.',
    'Reply exactly: END-OF-TEST',
  ]
  for (let k = 0; k < msgs.length; k++) {
    const label = `MSG${k + 1}`
    let acc = null, rejectBody = null
    try {
      const r = await post('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: msgs[k] }] }, 15000)
      const ai = r.text.indexOf('"accepted"')
      acc = ai >= 0 ? /"accepted"\s*:\s*true/.test(r.text.slice(ai, ai + 30)) : `status=${r.status}`
      if (acc === false || String(acc).startsWith('status=40')) rejectBody = r.text.slice(0, 240)
    } catch (e) { acc = 'EXCEPTION ' + e.message }
    console.log(ts(), `${label} ACCEPTED=${acc}${rejectBody ? '\n   REJECT-BODY: ' + rejectBody : ''}`)
    const w = await waitForIdle(sid, label)
    console.log(ts(), `${label} RESULT done=${w.ok} polls=${w.polls} ${w.note}`)
    // 如果这一条已经卡住, 后面两条大概率也会卡, 但仍继续观察第二条之后的表现
  }

  console.log(ts(), '--- 收尾: 再建一个新对话框, 验证能否成功 ---')
  try {
    const cr2 = await post('session.create', {}, 15000)
    const m2 = cr2.text.match(/"sessionId"\s*:\s*"([^"]+)"/)
    console.log(ts(), `RE-CREATE status=${cr2.status} newSid=${m2 ? m2[1] : '(none)'}`)
  } catch (e) { console.log(ts(), `RE-CREATE EXCEPTION ${e.message}`) }
})().catch(e => console.log('ERR', e.message))
