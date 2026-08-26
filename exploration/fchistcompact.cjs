/**
 * fchistcompact.cjs — 经 harness 自己的 S1 接口(session.history)读取
 * session cc257952 的事件流,筛出 compaction 类事件(或 12:02:50–12:03:15 UTC
 * 窗口内的事件),打印其关键字段(type/ts/provider/model/usage/chars...)。
 *
 * 依次尝试 3180(dev)、3080(main),谁认得这个 session 就用谁。
 * 用法:node exploration\fchistcompact.cjs
 */
'use strict'

const SID = 'cc257952-8724-4795-a083-d64c3887e891'
const WIN_START = '2026-08-26T12:02:50'
const WIN_END = '2026-08-26T12:03:16'

async function tryPort(port) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 90_000)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/session.history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `fchistcompact-${port}-${Date.now()}`,
        method: 'session.history',
        payload: { sessionId: SID },
      }),
      signal: ctrl.signal,
    })
    const j = await res.json()
    if (!j.result || !j.result.ok) return { port, hit: false, err: j.result && j.result.error }
    const v = j.result.value
    const arr = Array.isArray(v) ? v : v.events || v.items || v.messages
    if (!Array.isArray(arr)) {
      return { port, hit: false, err: `unexpected value shape: ${JSON.stringify(v).slice(0, 300)}` }
    }
    const norm = (e) => {
      const o = e && (e.event || e.data || e.payload) || e
      const ts = o.ts || o.timestamp || o.at || (e.ts)
      const type = o.type || e.type
      return { type, ts, o }
    }
    const kept = []
    for (const e of arr) {
      const { type, ts, o } = norm(e)
      const inWin = typeof ts === 'string' && ts >= WIN_START && ts <= WIN_END
      const isCompact = typeof type === 'string' && /compaction|compact/i.test(type)
      if (inWin || isCompact) kept.push({ type, ts, o })
    }
    return { port, hit: true, total: arr.length, sampleTypes: [...new Set(arr.map(norm).map((x) => x.type).filter(Boolean))].slice(0, 30), kept }
  } catch (err) {
    return { port, hit: false, err: String(err.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

;(async () => {
  for (const port of [3180, 3080]) {
    const r = await tryPort(port)
    if (!r.hit) {
      console.log(`[port ${port}] miss: ${r.err}`)
      continue
    }
    console.log(`[port ${port}] HIT — total events: ${r.total}`)
    console.log(`observed types (first 30 unique): ${JSON.stringify(r.sampleTypes)}`)
    console.log(`kept ${r.kept.length} events (compaction-type or in-window)`)
    for (const k of r.kept.slice(0, 60)) {
      const slim = { ...k.o }
      // trim bulky fields
      for (const key of Object.keys(slim)) {
        const val = slim[key]
        if (typeof val === 'string' && val.length > 400) slim[key] = val.slice(0, 200) + `…(+${val.length - 200} chars)`
      }
      console.log(JSON.stringify(slim))
    }
    return
  }
  console.log('NO PORT COULD SERVE THIS SESSION')
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
