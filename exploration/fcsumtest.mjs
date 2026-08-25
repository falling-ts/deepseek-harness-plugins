// Behavior test for the rewritten summarize():
//  - three-tier target resolution (configured -> routed header -> agent.options)
//  - fail-closed finish classification (error / aborted / max-tokens-empty / image / no-target)
//  - prefix passthrough (system + tools forwarded into options)
//  - backward-compatible bare-array input
import assert from 'node:assert/strict'
const { summarize, headerPrefix, COMPACTION_INSTRUCTION, CHECKPOINT_PREAMBLE } = await import(
  'file:///D:/deepseek-harness-plugins/dsh-force-compact/src/engine/summarizer.js'
)

const results = []
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(['PASS', name]))
    .catch(e => { results.push(['FAIL', name, e.message]); process.exitCode = 1 })
}

// --- helpers ----------------------------------------------------------------
function makeCtx(chunks) {
  const seen = { options: undefined }
  return {
    _seen: seen,
    get(name) {
      if (name !== 'llm') return undefined
      return {
        stream(opts) {
          seen.options = opts
          const arr = Array.from(chunks)
          return {
            [Symbol.asyncIterator]() {
              let i = 0
              return {
                next: () => (i < arr.length ? { value: arr[i++], done: false } : { value: undefined, done: true }),
              }
            },
          }
        },
      }
    },
  }
}
const hdrCfg = {
  requestHeader: () => ({ config: { provider: 'hdrProv', model: 'hdrMod' } }),
}
const hdrSys = {
  requestHeader: () => ({ config: { provider: 'hdrProv', model: 'hdrMod' }, system: 'SYS', tools: [{ name: 'read' }] }),
}
const agOpts = { session: hdrCfg, options: { provider: 'optP', model: 'optM' } }

// --- tests ------------------------------------------------------------------
await t('three-tier: header beats agent.options', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'x' }, { type: 'finish', kind: 'complete', finishReason: 'stop' }])
  const r = await summarize(ctx, {}, agOpts, { messages: [{ role: 'user', content: [] }] })
  assert.equal(r.provider, 'hdrProv')
  assert.equal(r.model, 'hdrMod')
})
await t('three-tier: configured beats header', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'y' }, { type: 'finish', kind: 'complete', finishReason: 'stop' }])
  const r = await summarize(ctx, { summarizationProvider: 'cfgP', summarizationModel: 'cfgM' }, agOpts, { messages: [] })
  assert.equal(r.provider, 'cfgP'); assert.equal(r.model, 'cfgM')
})
await t('three-tier: agent.options fallback when header empty', async () => {
  const agent = { session: { requestHeader: () => undefined }, options: { provider: 'optP', model: 'optM' } }
  const ctx = makeCtx([{ type: 'text-delta', text: 'z' }, { type: 'finish', kind: 'complete', finishReason: 'stop' }])
  const r = await summarize(ctx, {}, agent, { messages: [] })
  assert.equal(r.provider, 'optP'); assert.equal(r.model, 'optM')
})
await t('no target anywhere -> null', async () => {
  const agent = { session: { requestHeader: () => undefined }, options: {} }
  const ctx = makeCtx([])
  const r = await summarize(ctx, {}, agent, { messages: [] })
  assert.equal(r, null)
})
await t('missing ctx.llm -> null', async () => {
  const ctx = { get: () => undefined }
  const r = await summarize(ctx, {}, agOpts, { messages: [] })
  assert.equal(r, null)
})
await t('finish error -> throws PROVIDER_ERROR', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'partial' }, { type: 'finish', kind: 'error', failure: { message: 'boom' } }])
  await assert.rejects(async () => summarize(ctx, {}, agOpts, { messages: [] }), /provid(er)? .*boom|provider failure/i)
})
await t('finish aborted -> throws ABORTED', async () => {
  const ctx = makeCtx([{ type: 'finish', kind: 'aborted', finishReason: 'abort' }])
  await assert.rejects(async () => summarize(ctx, {}, agOpts, { messages: [] }), /aborted/i)
})
await t('finish max-tokens with NO text -> throws MAX_TOKENS_EMPTY', async () => {
  const ctx = makeCtx([{ type: 'finish', kind: 'max-tokens', finishReason: 'max_tokens' }])
  await assert.rejects(async () => summarize(ctx, {}, agOpts, { messages: [] }), /token cap|truncated/i)
})
await t('finish max-tokens WITH text -> accepted (partial)', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'some' }, { type: 'finish', kind: 'max-tokens', finishReason: 'max_tokens' }])
  const r = await summarize(ctx, {}, agOpts, { messages: [] })
  assert.ok(Array.isArray(r.summary)); assert.match(r.summary[0].text, /some/)
})
await t('image output -> refuses UNSUPPORTED_CONTENT', async () => {
  const ctx = makeCtx([
    { type: 'text-delta', text: 'txt' },
    { type: 'image', mediaType: 'image/png', url: 'data:' },
    { type: 'finish', kind: 'complete', finishReason: 'stop' },
  ])
  await assert.rejects(async () => summarize(ctx, {}, agOpts, { messages: [] }), /image/i)
})
await t('prefix passthrough: system + tools forwarded, purpose=compaction', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'k' }, { type: 'finish', kind: 'complete', finishReason: 'stop' }])
  await summarize(ctx, { maxSummaryTokens: 999 }, agOpts, {
    messages: [{ role: 'user', content: [] }], system: 'SYS', tools: [{ name: 'read' }],
  }, undefined, { reasoningEffort: 'off', maxTokens: 1234 })
  const o = ctx._seen.options
  assert.equal(o.system, 'SYS'); assert.deepEqual(o.tools, [{ name: 'read' }])
  assert.equal(o.purpose, 'compaction'); assert.equal(o.maxTokens, 1234); assert.equal(o.reasoningEffort, 'off')
  assert.ok(String(o.messages[o.messages.length - 1].content[0].text).includes('Primary Request and Intent'))
})
await t('backward-compat: bare messages array works', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'arr' }, { type: 'finish', kind: 'complete', finishReason: 'stop' }])
  const r = await summarize(ctx, { maxSummaryTokens: 5 }, agOpts, [{ role: 'user', content: [] }])
  assert.match(r.summary[0].text, /arr/)
})
await t('usage surfaced when provider reports it', async () => {
  const ctx = makeCtx([
    { type: 'text-delta', text: 'u' },
    { type: 'usage', usage: { promptTokens: 10, completionTokens: 2 } },
    { type: 'finish', kind: 'complete', finishReason: 'stop' },
  ])
  const r = await summarize(ctx, {}, agOpts, { messages: [] })
  assert.deepEqual(r.usage, { promptTokens: 10, completionTokens: 2 })
})
await t('directive + preamble exported', () => {
  assert.match(COMPACTION_INSTRUCTION, /PRIOR checkpoint/); assert.match(CHECKPOINT_PREAMBLE, /established background/)
})
await t('headerPrefix extracts system+tools; tolerates empty', () => {
  const p = headerPrefix(hdrSys)
  assert.equal(p.system, 'SYS'); assert.deepEqual(p.tools, [{ name: 'read' }])
  assert.deepEqual(headerPrefix(hdrCfg), {})
  assert.deepEqual(headerPrefix(undefined), {})
})

console.log(results.map(([s, n, e]) => s + ' ' + n + (e ? ' :: ' + e : '')).join('\n'))
