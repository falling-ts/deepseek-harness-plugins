// Behavioural probe for the summarizer's capability-aware reasoning effort.
//
// Extracts the real `EFFORT_LADDER` … `resolveEffectiveEffort` span out of
// src/engine/summarizer.js and drives it against stub `llm` services, so the
// shipped degradation logic (not a copy) is exercised: a route that cannot
// express `off` must yield the cheapest accepted level instead of failing the
// whole compaction transaction.
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../dsh-force-compact/src/engine/summarizer.js', import.meta.url), 'utf8')
const start = SRC.indexOf('const EFFORT_LADDER')
if (start < 0) throw new Error('EFFORT_LADDER not found')
const fnStart = SRC.indexOf('async function resolveEffectiveEffort(', start)
if (fnStart < 0) throw new Error('resolveEffectiveEffort not found')
const end = SRC.indexOf('\n}\n', fnStart)
if (end < 0) throw new Error('resolveEffectiveEffort closer not found')
const span = SRC.slice(start, end + 2)
for (const marker of ['isUnsupportedEffort', 'warnEffortDowngrade', 'EFFORT_LADDER']) {
  if (!span.includes(marker)) throw new Error(`extracted span is missing ${marker}`)
}

const factory = new Function('readProp', `${span}\nreturn { resolveEffectiveEffort, isUnsupportedEffort, EFFORT_LADDER, effortDowngradeWarned };`)
const api = factory((obj, key) => (obj === null || obj === undefined ? undefined : obj[key]))

let passed = 0
const failures = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`) }
}
function ctxStub() {
  const warnings = []
  return { warnings, logger: { warn: (m) => warnings.push(m), debug: () => {} } }
}
/** llm stub: `accepts` is the set of effort ids the route declares. */
function llmStub(accepts, { throwsUnknown = false } = {}) {
  const probed = []
  return {
    probed,
    async resolveCallConfig(config) {
      probed.push(config.reasoningEffort)
      if (throwsUnknown) { const e = new Error('provider "x" is not registered'); throw e }
      if (!accepts.includes(config.reasoningEffort)) {
        const error = new Error(`provider "opencode-go" model "deepseek-v4.1-flash" does not support reasoning effort "${config.reasoningEffort}"`)
        error.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw error
      }
      return config
    },
  }
}
const target = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
/** The warn-once guard is module state: reset it between cases (its own test below). */
const resetWarnings = () => api.effortDowngradeWarned.clear()

// 1 · the deepseek route accepts 'off' (the historical happy path).
{
  resetWarnings()
  const ctx = ctxStub()
  const llm = llmStub(['off', 'low', 'high', 'max'])
  check("route accepts 'off' → returns 'off'", await api.resolveEffectiveEffort(llm, target, 'off', ctx), 'off')
  check('  no warning emitted', ctx.warnings.length, 0)
  check('  probed exactly once', llm.probed, ['off'])
}

// 2 · opencode-go/deepseek-v4.1-flash: off/minimal/medium/xhigh unsupported.
{
  resetWarnings()
  const ctx = ctxStub()
  const llm = llmStub(['low', 'high', 'max'])
  check("off unsupported → cheapest supported level", await api.resolveEffectiveEffort(llm, target, 'off', ctx), 'low')
  check('  warned once', ctx.warnings.length, 1)
  check('  warning names the route and the substitute',
    ctx.warnings[0].includes('opencode-go/deepseek-v4.1-flash') && ctx.warnings[0].includes("'low'") && ctx.warnings[0].includes('compaction continues'), true)
  check('  probe order is the ascending ladder', llm.probed, ['off', 'minimal', 'low'])
}

// 3 · a non-reasoning model: nothing accepted → omit the field.
{
  resetWarnings()
  const ctx = ctxStub()
  const llm = llmStub([])
  check('no level accepted → undefined (omit the field)', await api.resolveEffectiveEffort(llm, target, 'off', ctx), undefined)
  check('  warned once, explaining the omission', ctx.warnings.length === 1 && ctx.warnings[0].includes('omits the field'), true)
  check('  walked the whole ladder', llm.probed.length, api.EFFORT_LADDER.length)
}

// 4 · older harness without the capability query → keep the requested effort.
{
  const ctx = ctxStub()
  const llm = { stream: () => {} }
  check('no resolveCallConfig → requested effort kept', await api.resolveEffectiveEffort(llm, target, 'off', ctx), 'off')
  check('  no warning', ctx.warnings.length, 0)
}

// 5 · an unrelated failure must not be swallowed into a downgrade.
{
  const ctx = ctxStub()
  const llm = llmStub([], { throwsUnknown: true })
  check('unrelated error → treated as accepted (no interference)', await api.resolveEffectiveEffort(llm, target, 'off', ctx), 'off')
  check('  no warning', ctx.warnings.length, 0)
}

// 6 · the warning is once per route+effort (the loop compacts up to 8 rounds).
{
  resetWarnings()
  const ctx = ctxStub()
  const llm = llmStub(['low', 'high', 'max'])
  await api.resolveEffectiveEffort(llm, target, 'off', ctx)
  await api.resolveEffectiveEffort(llm, target, 'off', ctx)
  await api.resolveEffectiveEffort(llm, target, 'off', ctx)
  check('warning is emitted once per route+effort', ctx.warnings.length, 1)
  check('  every call still resolves the substitute', llm.probed.filter(p => p === 'low').length, 3)
}

// 7 · error recognition also works from the message alone (code stripped).
{
  const bare = new Error('pi-ai provider "opencode-go" model "x" does not support reasoning effort "off"')
  check('message-only rejection is recognized', api.isUnsupportedEffort(bare), true)
  check('a null error is not a rejection', api.isUnsupportedEffort(null), false)
  check('an unrelated error is not a rejection', api.isUnsupportedEffort(new Error('boom')), false)
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
if (failures.length !== 0) process.exit(1)
