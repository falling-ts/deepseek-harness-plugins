// Probe: the three AGENT ACTION phases and their insertion points.
//
// The status texts name WHICH KIND OF WORK the agent is doing:
//   requesting 模型请求中   — agent issued a model request, waiting for token 1
//   responding 模型响应中   — token 1 arrived, lasts to the end of the response
//   tooling    工具执行中   — a non-model agent-internal operation is running
//
// This probe extracts the REAL implementations and drives them, asserting:
//   1. each phase's insertion point publishes exactly its own phase;
//   2. the requesting/responding split really is "before first token" vs "from
//      first token", including the `start` frame NOT publishing (the attempt
//      opens before any token has arrived);
//   3. both wateralls still reach `next()` (a listener that swallows the chain
//      would stall the request);
//   4. a COMPACTION summarization request publishes NONE of the three phases —
//      the user's explicit exclusion. This holds structurally (the summarizer
//      calls `ctx.llm.stream` directly), and the probe pins the consequence:
//      the phase publishers are reached only from agent-loop seams.
//   5. the retired random-working machinery (WORKING_TEXTS / working.N /
//      randomWorkingStatus / the 3 s DONE fallback timer) is gone.
//
// Run: node exploration/fc-agent-phase-probe.mjs
import { readFileSync } from 'node:fs'

const root = new URL('../dsh-force-compact/', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, root), 'utf8')
const host = read('src/core/ui-signal.js')
const index = read('index.js')

let passed = 0
const failures = []
function check(name, actual, expected) {
  if (actual === expected) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(`${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); console.log(`  FAIL ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`) }
}

// ── load the real ui-signal module ───────────────────────────────────────────
const uiSignal = await import(new URL('src/core/ui-signal.js', root).href)
const {
  PHASE_TEXTS, phasePayload, publishRequesting, publishResponding, publishTooling,
  publishCompressing, publishDone, publishEnd, publishUiStatus,
} = uiSignal

// A stub ctx capturing every settings write onto the liveUi field.
function captureCtx() {
  const writes = []
  return {
    writes,
    ctx: {
      get: (name) => (name === 'settings'
        ? { update: async (ns, patch) => { writes.push({ ns, patch }) } }
        : undefined),
      logger: { debug: () => {}, warn: () => {} },
    },
  }
}
const lastPhase = (writes) => (writes.length === 0 ? null : writes[writes.length - 1].patch.liveUi.phase)
const lastText = (writes) => (writes.length === 0 ? null : writes[writes.length - 1].patch.liveUi.text)

// ── 1 · the phase union and its canonical texts ──────────────────────────────
check('six phases are defined', Object.keys(PHASE_TEXTS).length, 6)
check('requesting carries the canonical zh text', PHASE_TEXTS.requesting, '模型请求中')
check('responding carries the canonical zh text', PHASE_TEXTS.responding, '模型响应中')
check('tooling carries the canonical zh text', PHASE_TEXTS.tooling, '工具执行中')
check('compressing banner is preserved', PHASE_TEXTS.compressing, '[强制压缩中>>>]')
check('done banner is preserved', PHASE_TEXTS.done, '[压缩完成!]')
check('end is the empty clear', PHASE_TEXTS.end, '')

// Every payload must carry textId === phase (the client's localization seam).
for (const phase of Object.keys(PHASE_TEXTS)) {
  const payload = phasePayload(phase)
  check(`payload(${phase}) carries textId === phase`, payload.textId, phase)
  check(`payload(${phase}) carries the canonical text`, payload.text, PHASE_TEXTS[phase])
}

// ── 2 · each publisher writes exactly its own phase ──────────────────────────
for (const [fn, phase] of [
  [publishRequesting, 'requesting'],
  [publishResponding, 'responding'],
  [publishTooling, 'tooling'],
  [publishCompressing, 'compressing'],
  [publishDone, 'done'],
  [publishEnd, 'end'],
]) {
  const { ctx, writes } = captureCtx()
  await fn(ctx)
  check(`${fn.name} publishes one write`, writes.length, 1)
  check(`${fn.name} publishes '${phase}'`, lastPhase(writes), phase)
  check(`${fn.name} targets the plugin namespace`, writes[0]?.ns, 'falling-ts-force-compact')
}

// ── 3 · every phase OVERWRITES, including over a pinned bracket banner ───────
// (no `[`-prefix gate any more: with the DONE fallback timer gone, a gate would
// strand the banner on screen).
{
  const { ctx, writes } = captureCtx()
  await publishCompressing(ctx)
  await publishTooling(ctx)
  check('a phase overwrites the compressed banner', lastPhase(writes), 'tooling')
  check('the overwrite is unconditional (no importance argument needed)', writes.length, 2)
}
// A hostile settings service must never disturb a request or a transaction.
{
  const ctx = {
    get: () => ({ update: async () => { throw new Error('settings write refused') } }),
    logger: { debug: () => {}, warn: () => {} },
  }
  let threw = false
  try { await publishRequesting(ctx) } catch { threw = true }
  check('a failing settings write is swallowed', threw, false)
}
{
  const ctx = { get: () => undefined, logger: { debug: () => {}, warn: () => {} } }
  let threw = false
  try { await publishTooling(ctx) } catch { threw = true }
  check('an absent settings service is swallowed', threw, false)
}

// ── 4 · the insertion points, extracted from the REAL index.js registrations ─
// Each listener's source region is sliced out by anchor (not by indentation-
// sensitive regex), so this asserts the shipped wiring, not a paraphrase of it.
function sliceFrom(label, until) {
  const start = index.indexOf(label)
  if (start === -1) return undefined
  const end = index.indexOf(until, start + label.length)
  return end === -1 ? index.slice(start) : index.slice(start, end)
}
const requestListenerBody = sliceFrom("guard('agent/request listener'", "guard('agent/assistant-stream listener'")
const streamListenerBody = sliceFrom("guard('agent/assistant-stream listener'", "guard('tools/pre-execute listener'")
const toolListenerBody = sliceFrom("guard('tools/pre-execute listener'", 'async function __agentRequestListenerBody')

check('the agent/request listener is present', typeof requestListenerBody === 'string', true)
check('agent/request publishes the requesting phase', /void publishRequesting\(ctx\)/.test(requestListenerBody), true)

check('the agent/assistant-stream listener is present', typeof streamListenerBody === 'string', true)
check('the stream listener fires only on a chunk frame',
  /frame\.type !== 'chunk'/.test(streamListenerBody), true)
check('the stream listener fires only on the FIRST chunk',
  /frame\.index !== 0/.test(streamListenerBody), true)
check("the stream listener NEVER gates on the 'start' frame",
  /'start'/.test(streamListenerBody), false)
check('the stream listener publishes the responding phase',
  /void publishResponding\(ctx\)/.test(streamListenerBody), true)
check('the stream listener is contained (never throws into the stream)',
  /catch \{/.test(streamListenerBody), true)

check('the tools/pre-execute listener is present', typeof toolListenerBody === 'string', true)
check('tools/pre-execute publishes the tooling phase',
  /void publishTooling\(ctx\)/.test(toolListenerBody), true)
check('tools/pre-execute still reaches next()', /return next\(\)/.test(toolListenerBody), true)
check('the agent/request listener still reaches next()', /await next\(\)/.test(requestListenerBody), true)
check('the agent/request listener publishes BEFORE awaiting next()',
  requestListenerBody.indexOf('void publishRequesting(ctx)') < requestListenerBody.indexOf('__agentRequestListenerBody'),
  true)

// ── 5 · a compaction summarization request publishes NONE of the three ───────
// STRUCTURAL exclusion: the summarizer calls `ctx.llm.stream` directly, so it
// traverses neither agent seam. Assert the wiring that makes that true, and
// assert that no phase publisher is reachable from an `llm/stream` listener
// (the retired watermark's seam).
const summarizer = read('src/engine/summarizer.js')
check('the summarizer calls ctx.llm.stream directly',
  /llm\.stream\s*\(/.test(summarizer), true)
check('no llm/stream listener remains in the plugin',
  /ctx\.on\('llm\/stream'/.test(index) || /ctx\.on\('llm\/stream'/.test(read('src/hooks/wire-rewrite.js')), false)
for (const name of ['publishRequesting', 'publishResponding', 'publishTooling']) {
  check(`${name} is NOT referenced by the summarizer`, summarizer.includes(name), false)
  check(`${name} is NOT referenced by the builtin engine`, read('src/engine/builtin.js').includes(name), false)
}

// ── 6 · the retired random-working machinery is gone ─────────────────────────
check('ui-signal no longer defines WORKING_TEXTS', /WORKING_TEXTS/.test(host), false)
check('ui-signal no longer defines randomWorkingStatus', /randomWorkingStatus/.test(host), false)
check('ui-signal no longer defines pinnedPayload', /pinnedPayload/.test(host), false)
check('the 3 s DONE fallback timer is gone', /DONE_FALLBACK_MS/.test(host) && /setTimeout/.test(host), false)
check('index.js no longer imports the retired watermark hook',
  /registerLlmStreamHook/.test(index), false)
check('no module still exports registerLlmStreamHook',
  /export function registerLlmStreamHook/.test(read('src/hooks/wire-rewrite.js')), false)

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
if (failures.length !== 0) { for (const f of failures) console.log(`  ${f}`); process.exit(1) }
