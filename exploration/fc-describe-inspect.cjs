#!/usr/bin/env node
// 直接查看 falling-ts-force-compact 命名空间在 settings.describe 里的完整 schema 段,
// 区分"真·空 schema 回归" 与 "探测切片窗口偏移导致的误报"。
const crypto = require('crypto'), http = require('http')
const BASE = `http://127.0.0.1:${process.argv[2] || '3180'}`
function post(m, p) {
  return new Promise((res, rej) => {
    const b = JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: m, payload: p })
    const r = http.request(`${BASE}/api/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } })
    r.on('error', rej)
    r.on('response', rs => { let d = ''; rs.on('data', c => d += c); rs.on('end', () => res(d)) })
    r.write(b); r.end()
  })
}
(async () => {
  const j = await post('settings.describe', {})
  const i = j.indexOf('"ns":"falling-ts-force-compact"')
  console.log('namespace found at index=', i)
  // 向后多切一段, 看 schema 结构
  console.log('---- 片段 ----')
  console.log(j.slice(i, i + 300))
  // 精确判据: 该 ns 段内是否有 "schema":{"uid" 且 refs 非空
  const seg = j.slice(i, i + 1500)
  const schemaIdx = seg.indexOf('"schema"')
  const snippet = seg.slice(schemaIdx, schemaIdx + 200)
  const isRealRefs = /"schema"\s*:\s*\{\s*"uid"/.test(snippet) && /"refs"\s*:/.test(snippet)
  console.log('---- 精确判据 ----')
  console.log('schema 起始段:', snippet.slice(0, 160))
  console.log('REAL refs tree?', isRealRefs)
})().catch(e => console.error('ERR', e.message))
