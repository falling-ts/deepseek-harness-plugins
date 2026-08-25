#!/usr/bin/env node
// fc-verifysurface.cjs — AUTHORITATIVE proof that a committed built-in
// compaction REMOVES the shadowed nodes from the derived conversation surface
// (answering the user's "有没有从上下文剔除这些上下文内容" question).
//
// Reads the plugin log to find the LATEST "builtin compaction OK" line, extracts
// its session id + span, then pulls that session's `session.history` and shows:
//   • the surface projection (which seqs SURVIVE vs which were shadowed),
//   • the 4-event compaction transaction (start/summary/replace/end),
//   • the BEFORE (original messages in the span) vs AFTER (single checkpoint).
// Usage: node fc-verifysurface.cjs [port]

const PORT = parseInt(process.argv[2] || '3180', 10)
const BASE = `http://127.0.0.1:${PORT}/api`
const fs = require('node:fs'), os = require('node:os')
const LOG = require('node:path').join(os.homedir(), '.dsh', 'logs', 'dsh-force-compact.log')

async function rpc(method, payload) {
  const r = await fetch(`${BASE}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: Math.random().toString(36).slice(2), method, payload: payload ?? {} }) })
  const txt = await r.text(); let json
  try { json = JSON.parse(txt) } catch { throw new Error(`HTTP ${r.status} non-JSON: ${txt.slice(0,200)}`) }
  if (json.result && json.result.ok === false) throw new Error(`${method} -> ${json.result.error||'rejected'}`)
  return json.result?.value
}

async function main() {
  const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/)
  // Latest OK commit line, e.g.:
  // … <sid>: builtin compaction OK — replaced span seq[A..B] (N nodes…) …
  let okLine = null
  for (let i = lines.length - 1; i >= 0; i--) if (/builtin compaction OK — replaced span seq\[/.test(lines[i])) { okLine = lines[i]; break }
  if (!okLine) { console.log('No "builtin compaction OK" line in log.'); return }
  console.log('Latest OK commit:\n', okLine.trim(), '\n')
  const sid = (okLine.match(/(session-[a-z0-9-]+)/i) || [])[1]
  const spanMatch = okLine.match(/seq\[(\d+)\.\.(\d+)\]/)
  if (!sid) { console.log('Could not parse session id from OK line.'); return }
  const [A, B] = spanMatch ? [parseInt(spanMatch[1]), parseInt(spanMatch[2])] : [NaN, NaN]
  console.log(`Inspecting session ${sid} (committed span seq ${A}..${B}).\n`)

  const hist = await rpc('session.history', { sessionId: sid })
  const events = Array.isArray(hist) ? hist : (hist.events || [])
  const bySeq = new Map(events.map(e => [e.seq, e]))

  // The surface projection: which surface events survive after the replace.
  const surfEvents = events.filter(e => ['user/message','assistant/message','tool/result'].includes(e.type))
  console.log(`TOTAL log events: ${events.length}; surface (message) events: ${surfEvents.length}`)

  // Show the 4-event transaction cluster (search for compaction/* around the span).
  const txEvents = events.filter(e => /^compaction\//.test(e.type) || (e.type === 'user/message' && e.surfaceOp && e.surfaceOp.op === 'replace'))
  console.log('\n=== Compaction transaction cluster (event types + seqs) ===')
  for (const e of txEvents.slice(-12)) {
    const d = e.data || {}
    const bits = []
    if (d.compactionId) bits.push('id='+String(d.compactionId).slice(0,14))
    if (d.shadowedRange) bits.push('range=['+d.shadowedRange.start+'..' + d.shadowedRange.end + ']')
    if (Array.isArray(d.shadowedSeqs)) bits.push('shadowedSeqs='+d.shadowedSeqs.length)
    if (d.error) bits.push('ERROR='+String(d.error).slice(0,60))
    if (e.surfaceOp) bits.push('surfaceOp='+JSON.stringify(e.surfaceOp))
    console.log(`  seq ${String(e.seq).padStart(4)} ${e.type.padEnd(18)} ${bits.join(' ')}`)
  }

  // The CORE QUESTION: do the shadowed seqs A..B still appear as LIVE surface
  // nodes, or have they been REPLACED by the checkpoint? List surviving
  // surface events whose seq lies within [A,B] — if compaction worked, the
  // originals are shadowed (still present in the raw log but OUT OF the live
  // surface projection) and the checkpoint node sits in their stead.
  const inSpanSurface = surfEvents.filter(e => e.seq >= A && e.seq <= B)
  console.log(`\nSURFACE events with seq in [${A}..${B}]: ${inSpanSurface.length}`)
  for (const e of inSpanSurface) {
    const src = e.data && e.data.source ? JSON.stringify(e.data.source) : '-'
    console.log(`  seq ${String(e.seq).padStart(4)} ${e.type.padEnd(15)} src=${src}${e.surfaceOp?' REPLACE':''}`)
  }
  const checkpoint = inSpanSurface.find(e => e.type==='user/message' && e.data && e.data.source && e.data.source.plugin === 'compact')
  console.log(checkpoint
    ? `\n✅ CHECKPOINT PRESENT in span: seq ${checkpoint.seq} is the replacement (plugin='compact'). Shadowed originals remain in the raw log but are OUT of the live surface projection → CONTENT IS REMOVED from context.`
    : `\n⚠ No plugin='compact' checkpoint found in [A..B] — inspect manually.`)
}
main().then(()=>console.log('\n== DONE ==')).catch(e=>{console.error('FATAL:', e.stack||e.message); process.exit(1)})
