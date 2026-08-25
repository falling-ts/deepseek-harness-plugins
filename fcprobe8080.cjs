'use strict'
// Live probe of the local llama.cpp instance on :8080, sending a request in
// EXACTLY the shape the dsh-llm-deepseek adapter produces
// (see packages/llm/llm-deepseek/src/serialize.ts serializeRequest tail).
const BASE = 'http://127.0.0.1:8080'
async function main() {
  // 1. What model name does the server expose?
  const modelsRes = await fetch(BASE + '/v1/models')
  console.log('=== GET /v1/models status:', modelsRes.status)
  const modelsBody = await modelsRes.text()
  console.log(modelsBody.slice(0, 400))

  // 2. Send a harness-shaped request through the OpenAI-compat endpoint
  const body = {
    model: 'qwen3.8-27b',
    messages: [{ role: 'system', content: 'Reply with exactly: ready.' },
               { role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: 'disabled' },
    temperature: 0.7,
    max_tokens: 32,
    stop: [],
  }
  const t0 = Date.now()
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  console.log('\n=== POST /v1/chat/completions status:', res.status,
              'content-type:', res.headers.get('content-type'))
  const text = await res.text()
  console.log('(took', (Date.now() - t0) + 'ms)')
  // Show last 6 SSE lines (usage/finish usually trailing)
  const lines = text.split(/\r?\n/).filter(Boolean)
  console.log('SSE frames:', lines.filter(l => l.startsWith('data:')).length)
  console.log('--- first frame ---')
  console.log(lines.find(l => l.startsWith('data:') && !l.includes('[DONE]')))
  console.log('--- last 3 frames ---')
  console.log(lines.slice(-3).join('\n'))
}
main().catch(err => { console.error('PROBE FAILED:', err.message); process.exit(1) })
