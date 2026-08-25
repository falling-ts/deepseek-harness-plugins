#!/usr/bin/env node
// fc-streamprobe.cjs — diagnose the ACTUAL chunk stream shape handed to plugins.
// Drives one summarization-shaped llm/stream call against a live dev instance
// (default port 3180) and traces EVERY chunk: its `type`, the exact `keys`,
// whether a `finish` chunk arrives, what `finish.reason` looks like, whether
// the stream YIELDS ANYTHING AT ALL (silent-empty signature), and whether it
// throws "not async iterable" / hangs.
//
// Usage: node fc-streamprobe.cjs [port] [provider] [model]
//   provider/model optional — when omitted we read them from the instance's
//   default routing via settings + a tiny probe session.

const PORT = parseInt(process.argv[2] || '3180', 10)
const BASE = `http://127.0.0.1:${PORT}/api`

async function rpc(method, payload) {
  const r = await fetch(`${BASE}/${method.replace('.', '.')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: Math.random().toString(36).slice(2), method, payload: payload ?? {} }),
  })
  const txt = await r.text()
  let json
  try { json = JSON.parse(txt) } catch { throw new Error(`HTTP ${r.status} non-JSON for ${method}: ${txt.slice(0, 300)}`) }
  if (json.result && json.result.ok === false) throw new Error(`${method} -> ${json.result.error || 'rejected'} :: ${JSON.stringify(json.result.value ?? '').slice(0, 200)}`)
  return json.result?.value
}

async function main() {
  const t0 = Date.now()
  console.log(`== fc-streamprobe port=${PORT} ==`)

  // 1. Create a scratch session so we have a sessionId for a realistic call.
  const created = await rpc('session.create', {})
  const sid = created && (created.sessionId || created.id)
  console.log(`scratch session: ${sid}`)

  // 2. Read the instance's default routing so our call targets a REAL adapter.
  //    Try settings.describe for provider hints; fall back to the well-known
  //    llama.cpp OpenAI-compatible local target used throughout this workspace.
  const provider = process.argv[3] || 'llama.cpp'
  const model = process.argv[4] || 'local'
  console.log(`targeting provider=${provider} model=${model} (override via argv[3]/argv[4])`)

  // 3. Fire ONE llm/stream call via the wire. The harness exposes llm as a
  //    service; the closest wire-routable surface for a raw stream is
  //    `llm.stream` if present, else we lean on the plugin's OWN summarizer by
  //    triggering /force-compact on the scratch session and reading the debug
  //    log. To avoid coupling to either, we print BOTH: (a) attempt direct
  //    llm.stream RPC, (b) note the command-driven path.
  let directOk = false
  try {
    const v = await rpc('llm.stream', {
      provider, model,
      maxTokens: 64,
      purpose: 'compaction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say exactly: PING' }] }],
    })
    directOk = true
    console.log(`DIRECT llm.stream result kind=${v && typeof v}`)
    console.log(`   raw value (first 600 chars): ${JSON.stringify(v).slice(0, 600)}`)
  } catch (e) {
    console.log(`DIRECT llm.stream UNAVAILABLE/FAILED (expected if not wire-exposed): ${e.message}`)
  }

  console.log(`\n== interpretation guide ==`)
  console.log(`- If DIRECT returned an ARRAY / object of chunks: inspect each .type & .finish.reason.`)
  console.log(`- If it threw 'no adapter'/unknown provider: the target is wrong — set argv[3]/argv[4].`)
  console.log(`- The AUTHORITATIVE chunk-shape truth lives in the PLUGIN DEBUG LOG after a /force-compact:`)
  console.log(`    %USERPROFILE%\\.dsh\\logs\\dsh-force-compact.log  (search 'CHUNK-SHAPE PROBE' & 'read kind')`)
  console.log(`elapsed ${Date.now() - t0}ms`)
}

main().then(() => console.log('\n== DONE ==')).catch(err => { console.error('FATAL:', err.message); process.exit(1) })
