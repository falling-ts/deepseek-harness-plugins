// Cycle-4 verification driver: smoke the repaired 3180 instance, create a
// session, drive it across the 60000-token threshold, then classify the
// resulting compaction transactions (complete vs. empty-abort vs. error) and
// scan the plugin log for the repair's new signatures.
const BASE = 'http://127.0.0.1:3180'
const LOG_FILE = process.argv[2] || 'C:/Users/zghyu/.dsh/logs/dsh-force-compact.log'

async function rpc(method, payload) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload,
    }),
  })
  const json = await res.json()
  const value = json.result?.value
  return value !== undefined ? value : json.result
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const desc = await rpc('settings.describe', {})
  const ns = desc.namespaces ?? (Array.isArray(desc) ? desc : [])
  console.log('[ns] falling-ts namespaces:', ns.filter(n => typeof n === 'string' && n.includes('falling-ts')))

  const sess = await rpc('session.create', {})
  const sid = sess.sessionId
  console.log('[create]', sid)

  // Drive the session: a prompt asking the model to write a LONG answer
  // (thousands of tokens of Chinese prose) to accumulate context fast. The
  // local GGUF endpoint is slow, so this is driven sequentially and polled.
  const promptPayload = {
    sessionId: sid,
    mode: 'queue',
    content: [{
      type: 'text',
      text: '请用中文写一篇不少于 6000 字的长文，主题是「大语言模型在代码助手场景下的工程化实践」，要求结构清晰、论述深入、包含具体技术细节（如上下文管理、工具调用、压缩策略等），一次性输出全文，不要分段等待。',
    }],
  }
  const accepted = await rpc('session.prompt', promptPayload)
  console.log('[prompt] accepted=', JSON.stringify(accepted))

  // Poll until the turn settles (idle) — up to ~8 min for the local endpoint.
  const t0 = Date.now()
  while (Date.now() - t0 < 8 * 60_000) {
    await sleep(10_000)
    const hist = await rpc('session.history', { sessionId: sid })
    const evs = (hist.events ?? []).map(r => (r.event ?? r))
    const lastTurnEnd = evs.filter(e => e.type === 'turn/end').at(-1)
    const total = evs.reduce((acc, e) => acc + ((e.data?.content ?? []).reduce((c, b) => c + (b.text?.length ?? 0), 0) || (e.data?.message?.content ?? []).reduce((c, b) => c + (b.text?.length ?? 0), 0)), 0)
    const approxTokens = Math.ceil(total / 4)
    const compactionEvents = evs.filter(e => e.type.startsWith('compaction/')).map(e => ({ seq: e.seq, type: e.type, turn: e.data?.turn, error: e.data?.error, shadow: e.data?.shadowedRange, shadowedTokens: e.data?.shadowedTokenCount }))
    const busy = evs.some(e => e.type === 'turn/start' && e.seq > (lastTurnEnd?.seq ?? -1))
    const secs = Math.round((Date.now() - t0) / 1000)
    console.log(`[poll ${secs}s] events=${evs.length} approxSurfTok≈${approxTokens} compactions=${compactionEvents.length}${busy ? ' (turn still active)' : ''}`)
    if (!busy && lastTurnEnd) {
      console.log('[settled]', JSON.stringify(compactionEvents))
      break
    }
  }

  // Final classification of every compaction transaction in this session.
  const hist = await rpc('session.history', { sessionId: sid })
  const evs = (hist.events ?? []).map(r => (r.event ?? r))
  const txs = []
  let cur = null
  for (const e of evs) {
    if (e.type === 'compaction/start') {
      cur = { startSeq: e.seq, turn: e.data?.turn, summary: null, replace: null, end: null }
      txs.push(cur)
    } else if (cur && e.type === 'compaction/summary' && cur.summary === null) {
      cur.summary = { seq: e.seq, shadow: e.data?.shadowedRange, shadowedTokens: e.data?.shadowedTokenCount }
    } else if (cur && e.type === 'compaction/end') {
      cur.end = { seq: e.seq, error: e.data?.error }
      cur = null
    }
  }
  for (const t of txs) {
    const cls = t.end === null
      ? 'UNCLOSED'
      : t.summary !== null ? 'COMPLETE'
      : (t.end.error ? `EMPTY-ERROR(${t.end.error})` : 'EMPTY-ABORT')
    t.class = cls
  }
  console.log('[tx-classification]', JSON.stringify(txs, null, 2))

  // Scan the plugin log for the NEW signatures introduced by the repair.
  const fs = await import('node:fs/promises')
  const raw = await fs.readFile(LOG_FILE, 'utf8').catch(() => '')
  const lines = raw.split(/\r?\n/)
  const mine = lines.filter(l => l.includes(sid))
  const sig = {
    thresholdFloor: mine.filter(l => l.includes('threshold-aware floor')),
    emptyText: mine.filter(l => l.includes('empty-text')),
    noFinish: mine.filter(l => l.includes('no-finish')),
    synthesized: mine.filter(l => l.includes('synthesized')),
    cooldown: mine.filter(l => l.includes('SKIPPED (cooldown)')).length,
    errors: mine.filter(l => l.includes('transaction ended in error')),
  }
  console.log('[signatures]', JSON.stringify(sig, null, 2))

  // Print the session's last 15 lines from the plugin log for eyeball review.
  console.log('[log-tail-15]')
  for (const l of mine.slice(-15)) console.log('  ', l.slice(0, 300))
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
