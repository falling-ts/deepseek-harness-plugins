#!/usr/bin/env node
/**
 * fc-wire-smoke-3180.cjs — verify the summarizer's llama.cpp compat wire
 * field (reasoning_effort:"none") is ACTUALLY stamped onto the options object
 * handed to llm.stream when disableThinking is true.
 *
 * Strategy (cheapest possible verification):
 *   1. Load the plugin's summarize() function from engine/summarizer.js.
 *   2. Stub a fake llm object whose .stream(options) records whatever options
 *      it received WITHOUT actually invoking an LLM.
 *   3. Call summarize() twice:
 *       a. extra = { reasoningEffort: 'off' }   → expect options.reasoning_effort === 'none'
 *       b. extra = { }                            → expect options.reasoning_effort === undefined
 *   4. Print a PASS/FAIL table.
 *
 * Run:  node exploration/fc-wire-smoke-3180.cjs
 */
const assert = require('node:assert')
const path = require('node:path')

const PLUGIN_SRC = path.resolve(__dirname, '..', 'dsh-force-compact', 'src', 'engine', 'summarizer.js')

async function main() {
  // Dynamic import of ESM module from CJS entry.
  const mod = await import(pathToFileUrl(PLUGIN_SRC))
  const summarize = mod.summarize

  function makeFakeCtx(record) {
    return {
      llm: {
        stream(opts) { record.received = opts; return fakeStream() },
      },
      logger: { debug: () => {}, info: () => {}, warn: console.warn.bind(console), error: console.error.bind(console) },
      sessions: { /* unused by the stubbed path */ },
      get: (svc) => (svc === 'settings' ? undefined : svc === 'llm' ? record.llm : undefined),
    }
  }

  async function fakeStream() {
    // Yield one minimal finish-shaped chunk so collectChunks terminates cleanly.
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '(smoke)' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '(smoke)' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: 'stop' }
    })()
  }

  const config = { provider: 'fake', model: 'fake-model', maxSummaryTokens: 64, summarizationProvider: undefined, summarizationModel: undefined }
  const agentStub = { session: null, options: { provider: 'fake', model: 'fake-model' } }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

  const cases = [
    { name: 'CASE 1 — disableThinking ON (extra.reasoningEffort="off")', extra: { reasoningEffort: 'off' }, expectPresent: true },
    { name: 'CASE 2 — disableThinking OFF (extra={})                     ', extra: {},                                        expectPresent: false },
    { name: 'CASE 3 — extra omitted (undefined)                        ', extra: undefined,                                   expectPresent: false },
  ]

  let allPass = true
  for (const c of cases) {
    const record = {}
    const ctx = makeFakeCtx(record)
    try {
      await summarize(ctx, config, agentStub, messages, new AbortController().signal, c.extra)
      const got = record.received && Object.prototype.hasOwnProperty.call(record.received, 'reasoning_effort') ? record.received.reasoning_effort : undefined
      const present = got === 'none'
      const ok = present === c.expectPresent
      allPass = allPass && ok
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  got=${JSON.stringify(got)}  expected=${c.expectPresent ? '"none"' : 'undefined'}`)
      if (!ok) console.log(`      ^^^ received=${JSON.stringify(record.received && Object.keys(record.received))}  purpose=${record.received && record.received.purpose}  reasoningEffort=${record.received && record.received.reasoningEffort}`)
    } catch (err) {
      allPass = false
      console.log(`FAIL  ${c.name}  THREW: ${err && err.message}`)
      console.log(`      stack: ${(err && err.stack || '').split('\n')[0]}`)
    }
  }
  console.log('')
  console.log(allPass ? '✅ ALL CASES PASS — summarizer stamps reasoning_effort="none" exactly when extra.reasoningEffort==="off"' : '❌ SOMETHING BROKE — inspect above')
  process.exit(allPass ? 0 : 1)
}

function pathToFileUrl(p) {
  return 'file://' + p.replace(/\\/g, '/')
}

main().catch((e) => { console.error(e); process.exit(1) })
