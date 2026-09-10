#!/usr/bin/env node
/**
 * fc-deepseek-reqext-3180.cjs — reproduce "DeepSeek request extension preparation failed"
 * on the 3180 dev instance by routing a real request to the `deepseek-official` provider.
 *
 * Sequence: session/create -> session/selectModel(deepseek-official/deepseek-v4-flash)
 *           -> session/prompt (short). The adapter calls deepseekLlmApiExtensions.prepare()
 *           BEFORE fetch; if the default-on `dsh_plugin_packages` provider fails to resolve
 *           an active package's identity, the whole request fails with REQUEST_EXTENSION
 *           and the wrapped `cause` names the failing package.
 *
 * Usage: node exploration/fc-deepseek-reqext-3180.cjs [port]
 */
const PORT = process.argv[2] || '3180'
const BASE = `http://127.0.0.1:${PORT}`

async function rpc(method, args) {
  const body = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function main() {
  const created = await rpc('session/create', { request: {} })
  const sessionId = created?.result?.value?.sessionId
  console.log('create:', JSON.stringify(created?.result?.ok), 'sessionId=', sessionId)
  if (!sessionId) { console.log('create failed:', JSON.stringify(created)); return }

  const sel = await rpc('session/selectModel', {
    request: { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  console.log('selectModel:', JSON.stringify(sel?.result?.ok), '->', JSON.stringify(sel?.result?.value))

  const prompt = await rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'reply with the single word OK' }],
    },
  })
  console.log('prompt accepted:', JSON.stringify(prompt?.result?.ok), '->', JSON.stringify(prompt?.result?.value))

  console.log('sessionId=', sessionId, '(check 3180 log for the REQUEST_EXTENSION cause)')
}

main().catch(e => { console.error('probe error:', e); process.exit(1) })
