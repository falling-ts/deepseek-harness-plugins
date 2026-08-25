#!/usr/bin/env node
/** Simulate the read-time floor by running readSettings with a FAKE settings
 *  service whose stored values are deliberately sub-floor, confirming each field
 *  RESOLVES to its MIN_TOKEN_SCALES floor. */
const { DEFAULTS, MIN_TOKEN_SCALES, NS } = await import('file:///D:/deepseek-harness-plugins/dsh-force-compact/src/core/settings.js')
const fakeStored = {
  [NS]: {
    disableThinking: true,
    autoThresholdTokens: 1000,   // below 32000 → should clamp
    retainLatestTokens: 500,     // below 8000 → should clamp
    turnEndForceCompactionEnabled: true,
    debug: false,
    logFile: '~/custom.log',
    compactionMode: 'realm',
    builtinEnabled: true,
    maxSummaryTokens: 100,       // below 4096 → should clamp
  },
}
const fakeCtx = {
  get: (name) => (name === 'settings'
    ? { get: (field) => (typeof field === 'string' ? fakeStored[field] : fakeStored) }
    : undefined),
}
// readSettings signature is (ctx) — our stub provides a compatible surface.
// The internal `settings.get(NS)` reads the WHOLE section (our stub returns
// `fakeStored[NS]`), then each field is parsed individually via
// `settings.get(field-name)`. Verify both shapes.
const fakeSectionAccess = fakeStored[NS]
const settingsFacade = {
  get: (arg) => {
    // Mimics the settings service: called EITHER with the whole-namespace name
    // (returns the section) OR with a field name (returns the scalar). Both
    // forms are supported by the real service; our probe covers whichever the
    // plugin uses.
    if (arg === NS) return fakeSectionAccess
    return fakeSectionAccess[arg]
  },
}
const ctxStub = { get: (n) => (n === 'settings' ? settingsFacade : undefined) }
const resolved = await import('file:///D:/deepseek-harness-plugins/dsh-force-compact/src/core/settings.js').then(async (m) => m.readSettings(ctxStub))
console.log('resolved:', resolved)
console.log('\nfloors for reference:', MIN_TOKEN_SCALES)
const checks = [
  ['autoThresholdTokens', resolved.autoThresholdTokens, MIN_TOKEN_SCALES.autoThresholdTokens],
  ['retainLatestTokens', resolved.retainLatestTokens, MIN_TOKEN_SCALES.retainLatestTokens],
  ['maxSummaryTokens', resolved.maxSummaryTokens, MIN_TOKEN_SCALES.maxSummaryTokens],
]
let failed = 0
for (const [label, got, want] of checks) {
  const ok = got === want
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${label}: got ${got}, wanted ${want}${ok ? ' (clamped)' : ''}`)
}
if (failed > 0) process.exit(1)
console.log('\nALL SUB-FLOOR VALUES CORRECTLY CLAMPED UP TO THEIR FLOORS.')
