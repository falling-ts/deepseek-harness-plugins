#!/usr/bin/env node
/**
 * fc-wire-smoke-3180b.cjs — refined unit smoke. Stubs the session with a
 * minimal shape that satisfies the plugin's target-resolution walk
 * (level-1 explicit config takes priority, so levels 2/3 are never reached —
 * no need for requestHeader). Verifies the summarizer's options construction
 * stamps `reasoning_effort: 'none'` exactly when `extra.reasoningEffort === 'off'`.
 */
const path = require('node:path')

const PLUGIN_SRC = path.resolve(__dirname, '..', 'dsh-force-compact', 'src', 'engine', 'summarizer.js')

async function main() {
  const mod = await import('file://' + PLUGIN_SRC.replace(/\\/g, '/'))
  const summarize = mod.summarize

  // Minimal fake session — only the fields the summarizer touches.
  const fakeSession = { id: 'sess-smoke' }
  const agentStub = {
    session: fakeSession,
    options: { provider: 'fake', model: 'fake-model' },
  }

  function makeRecord() { return { received: undefined } }
  function makeCtx(rec) {
    const llmObj = {
      stream(opts) { rec.received = opts; return fakeStream() },
    }
    return {
      // Direct property access (some older paths still use this).
      llm: llmObj,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      // Cordis-style service lookup — summarizer uses `ctx.get('llm')` (line 192).
      get: (svc) => (svc === 'llm' ? llmObj : undefined),
    }
  }
  async function* fakeStream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '(smoke)' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '(smoke)' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: 'stop' }
  }

  const config = {
    // Level-1 explicit config → target-resolver short-circuits here; levels
    // 2 (session.requestHeader) and 3 (agent.options) are never consulted.
    summarizationProvider: 'fake',
    summarizationModel: 'fake-model',
    maxSummaryTokens: 64,
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

  const cases = [
    { name: 'disableThinking ON (extra.reasoningEffort="off")', extra: { reasoningEffort: 'off' }, expectPresent: true },
    { name: 'disableThinking OFF (extra={})                   ', extra: {},                                      expectPresent: false },
    { name: 'extra omitted                                     ', extra: undefined,                              expectPresent: false },
  ]

  let allPass = true
  for (const c of cases) {
    const rec = makeRecord()
    const ctx = makeCtx(rec)
    try {
      await summarize(ctx, config, agentStub, messages, new AbortController().signal, c.extra)
      const o = rec.received
      const hasField = !!o && Object.prototype.hasOwnProperty.call(o, 'reasoning_effort')
      const val = hasField ? o.reasoning_effort : undefined
      const presentAsNone = hasField && val === 'none'
      const ok = presentAsNone === c.expectPresent
      allPass = allPass && ok
      const summary = `received.purpose=${o && o.purpose}, received.reasoningEffort=${o && o.reasoningEffort}, received.reasoning_effort=${JSON.stringify(val)}`
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ${summary}\n      expected.present=${c.expectPresent}`)
      if (!ok) console.log('      FULL OPTIONS KEYS:', o ? Object.keys(o).join(',') : 'N/A')
    } catch (err) {
      allPass = false
      console.log(`FAIL  ${c.name}\n      THREW: ${err && err.message}\n      stack: ${(err && err.stack || '').split('\n').slice(0, 4).join('\n          ')}`)
    }
  }
  console.log('')
  console.log(allPass ? '✅ ALL PASS' : '❌ FAILURES ABOVE')
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
