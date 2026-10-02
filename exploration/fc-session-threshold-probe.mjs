// Probe: per-session auto-compaction threshold override.
//
// The feature spans both halves of the package, so it is verified the same way
// the K/M parser was: drive the REAL host resolver through a fake Config, then
// extract the REAL client helpers straight out of `web/client.js`.
//
//   host   src/core/settings.js  — `sessionThresholds` map + `readSettings(ctx, session)`
//   client web/client.js         — composer-dock chip (icon + value, popover input)
//
// Executable: 1-4 (host resolution) and 5-6 (client helpers).
// Pinned by source inspection: 7-10 (wiring a DOM cannot prove).
//
// Run: node exploration/fc-session-threshold-probe.mjs
import fs from 'node:fs'
import {
  bindConfig, readSettings, resolveSessionThreshold, MIN_TOKEN_SCALES, DEFAULTS,
} from '../dsh-force-compact/src/core/settings.js'

const root = new URL('../dsh-force-compact/', import.meta.url)
const client = fs.readFileSync(new URL('web/client.js', root), 'utf8')
const settingsSrc = fs.readFileSync(new URL('src/core/settings.js', root), 'utf8')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : '  ' + detail}`)
}
const FLOOR = MIN_TOKEN_SCALES.autoThresholdTokens

// ------------------------------------------------- 1. host: global default
// A fake Config stands in for the Loader-bound volatile refs (`bindConfig`).
const configWith = (fields) => bindConfig(Object.fromEntries(
  Object.entries(fields).map(([k, v]) => [k, { get: () => v }]),
))

configWith({ autoThresholdTokens: 700000 })
const plain = await readSettings(undefined, { id: 's-any' })
check(plain !== null, 'readSettings resolves with a bound Config')
check(plain.autoThresholdTokens === 700000, 'no override → the global setting is the threshold')
check(plain.autoThresholdTokensDefault === 700000, 'the default is reported separately')
check(plain.sessionThresholdTokens === undefined, 'no override → sessionThresholdTokens is undefined')

// Session-less callers (the debug logger, the thinking gate) keep the global.
const noSession = await readSettings(undefined)
check(noSession.autoThresholdTokens === 700000, 'a session-less read keeps the global default')

// Unbound Config degrades to defaults rather than throwing.
bindConfig(undefined)
const unbound = await readSettings(undefined, { id: 's-any' })
check(unbound.autoThresholdTokens === DEFAULTS.autoThresholdTokens, 'unbound Config → DEFAULTS (never a throw)')// -------------------------------------------- 2. host: per-session override
configWith({
  autoThresholdTokens: 700000,
  sessionThresholds: { 's-a': 400000, 's-b': '1M', 's-c': '500K', 's-other': 12345 },
})
const a = await readSettings(undefined, { id: 's-a' })
const b = await readSettings(undefined, { id: 's-b' })
const c = await readSettings(undefined, { id: 's-c' })
const other = await readSettings(undefined, { id: 's-other' })
const missing = await readSettings(undefined, { id: 's-nope' })
check(a.autoThresholdTokens === 400000, 'plain number override wins over the global')
check(a.sessionThresholdTokens === 400000, 'the override is surfaced as sessionThresholdTokens')
check(a.autoThresholdTokensDefault === 700000, 'the global default stays readable alongside')
check(b.autoThresholdTokens === 1000000, 'K/M suffix in a stored override parses (1M)')
check(c.autoThresholdTokens === 500000, 'K suffix in a stored override parses (500K)')
check(other.autoThresholdTokens === FLOOR, `sub-floor override clamps up to the floor (${FLOOR})`)
check(missing.autoThresholdTokens === 700000, 'an unset session falls back to the global default')

// Session identity drives the lookup: two sessions, same map, different answers.
const s1 = await readSettings(undefined, { id: 's-a' })
const s2 = await readSettings(undefined, { id: 's-b' })
check(s1.autoThresholdTokens !== s2.autoThresholdTokens, 'two sessions resolve to different thresholds (isolation)')

// ---------------------------------------- 3. host: hostile stored shapes
configWith({ autoThresholdTokens: 700000, sessionThresholds: { 's-x': 'garbage' } })
const garbage = await readSettings(undefined, { id: 's-x' })
check(garbage.autoThresholdTokens === 700000, 'an unparseable override is DROPPED → global default')
check(garbage.sessionThresholds['s-x'] === undefined, 'the dropped entry never reaches the map')

for (const [label, raw] of [
  ['null', null], ['an array', [1, 2]], ['a string', 'nope'], ['a number', 42],
]) {
  configWith({ autoThresholdTokens: 700000, sessionThresholds: raw })
  const shaped = await readSettings(undefined, { id: 's-a' })
  check(shaped.autoThresholdTokens === 700000 && typeof shaped.sessionThresholds === 'object',
    `sessionThresholds=${label} degrades to an empty map, not a crash`)
}

configWith({ autoThresholdTokens: 700000, sessionThresholds: { 's-a': 0 } })
check((await readSettings(undefined, { id: 's-a' })).autoThresholdTokens === 700000, 'a 0 override is dropped (0 means unset, not compress-everything)')
configWith({ autoThresholdTokens: 700000, sessionThresholds: { 's-a': -5 } })
check((await readSettings(undefined, { id: 's-a' })).autoThresholdTokens === 700000, 'a negative override is dropped')

// ----------------------------------- 4. host: resolveSessionThreshold contract
check(resolveSessionThreshold({ 's-a': 500 }, { id: 's-a' }) === 500, 'resolveSessionThreshold reads a known id')
check(resolveSessionThreshold({ 's-a': 500 }, { id: 's-b' }) === undefined, 'unknown id → undefined')
check(resolveSessionThreshold({}, undefined) === undefined, 'no session → undefined')
check(resolveSessionThreshold({}, null) === undefined, 'null session → undefined')
check(resolveSessionThreshold({}, {}) === undefined, 'a session without an id → undefined')
check(resolveSessionThreshold({}, { id: '' }) === undefined, 'an empty id → undefined')
check(resolveSessionThreshold(undefined, { id: 's-a' }) === undefined, 'no map → undefined')
// --------------------------------- 5. client: the same three rules, real code
// Pull the REAL functions out of the browser bundle and run them in Node.
const fieldConst = client.match(/const SESSION_THRESHOLD_FIELD = "([^"]+)"/)
check(fieldConst !== null, 'client declares SESSION_THRESHOLD_FIELD')
const FLOOR_CONST = client.match(/const THRESHOLD_FLOOR = (\d+)/)
check(FLOOR_CONST !== null, 'client declares THRESHOLD_FLOOR')
const clientField = fieldConst === null ? 'sessionThresholds' : fieldConst[1]
check(clientField === 'sessionThresholds', 'client field name matches the host schema field')
check(Number(FLOOR_CONST === null ? NaN : FLOOR_CONST[1]) === FLOOR,
  'client THRESHOLD_FLOOR matches the host MIN_TOKEN_SCALES floor')

const extractFn = (name, deps) => {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {4}\\}`)
  const m = client.match(re)
  if (m === null) throw new Error(`client is missing ${name}`)
  const keys = Object.keys(deps)
  return new Function(...keys, `${m[0]}\nreturn ${name}`)(...keys.map(k => deps[k]))
}
const clientSessionOverride = extractFn('sessionOverrideOf', { SESSION_THRESHOLD_FIELD: clientField })
const clientDefault = extractFn('defaultThresholdOf', { THRESHOLD_FLOOR: FLOOR })
const clientFormat = extractFn('formatTokenScale', {})

// formatTokenScale — the chip's label.
for (const [input, expected] of [
  [32000, '32K'], [700000, '700K'], [1000000, '1M'], [2000000, '2M'],
  [1234, '1234'], [1, '1'], [0, '—'], [-1, '—'],
  [undefined, '—'], [null, '—'], [NaN, '—'], [Infinity, '—'], ['32000', '—'],
]) {
  check(clientFormat(input) === expected, `formatTokenScale(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`)
}
// sessionOverrideOf — the chip's read path (mirrors the host resolver).
check(clientSessionOverride({ sessionThresholds: { a: 400000 } }, 'a') === 400000, 'client reads a plain override')
check(clientSessionOverride({ sessionThresholds: { a: '400000' } }, 'a') === undefined, 'client ignores a non-number override')
check(clientSessionOverride({ sessionThresholds: { a: 0 } }, 'a') === undefined, 'client ignores a 0 override')
check(clientSessionOverride({ sessionThresholds: { a: -1 } }, 'a') === undefined, 'client ignores a negative override')
check(clientSessionOverride({ sessionThresholds: null }, 'a') === undefined, 'null map → undefined')
check(clientSessionOverride({ sessionThresholds: [1] }, 'a') === undefined, 'array map → undefined')
check(clientSessionOverride({}, 'a') === undefined, 'absent map → undefined')
check(clientSessionOverride({ sessionThresholds: { a: 1 } }, '') === undefined, 'empty session id → undefined')
check(clientSessionOverride({ sessionThresholds: { a: 1 } }, undefined) === undefined, 'undefined session id → undefined')
check(clientSessionOverride(undefined, 'a') === undefined, 'undefined snapshot value → undefined')

// defaultThresholdOf — the chip's fallback.
check(clientDefault({ autoThresholdTokens: 700000 }) === 700000, 'client reads the global default')
check(clientDefault({ autoThresholdTokens: 1 }) === 1, 'a non-floor global is taken as written')
check(clientDefault({}) === FLOOR, 'absent global → floor')
check(clientDefault(undefined) === FLOOR, 'undefined value → floor')
check(clientDefault({ autoThresholdTokens: -3 }) === FLOOR, 'a negative global → floor')
check(clientDefault({ autoThresholdTokens: 'x' }) === FLOOR, 'a non-number global → floor')

// --------------------------------------------- 6. host/client parity on the same map
const SHARED_MAP = { 's-a': 400000, 's-b': 32000, 's-c': 0, 's-d': 1000000 }
for (const id of ['s-a', 's-b', 's-c', 's-d', 's-missing']) {
  const hostValue = resolveSessionThreshold(SHARED_MAP, { id }) ?? 700000
  const clientValue = clientSessionOverride({ sessionThresholds: SHARED_MAP }, id) ?? clientDefault({ autoThresholdTokens: 700000 })
  check(hostValue === clientValue, `host/client agree on the effective threshold for ${id}`, `${hostValue}`)
}
// -------------------------------------- 7. host wiring: every gate is session-aware
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]
))
const srcFiles = walk(new URL('src/', root)).filter((u) => u.pathname.endsWith('.js'))
const callSites = []
for (const url of srcFiles) {
  const rel = url.pathname.split('/dsh-force-compact/')[1]
  for (const line of fs.readFileSync(url, 'utf8').split('\n')) {
    const m = line.match(/await readSettings\(ctx(.*?)\)\s*\?\?/)
    if (m !== null) callSites.push({ rel, arg: m[1].replace(/^[),\s]+/, '').trim() })
  }
}
check(callSites.length === 9, `all 9 readSettings call sites are present`, `found ${callSites.length}`)
const globalOnly = callSites.filter((s) => s.arg === '')
const sessionAware = callSites.filter((s) => s.arg !== '')
check(sessionAware.length === 7, 'seven gate sites pass a session', sessionAware.map((s) => s.rel).join(', '))
check(globalOnly.length === 2, 'only two session-less reads remain (debug logger + thinking gate)',
  globalOnly.map((s) => s.rel).join(', '))
check(globalOnly.every((s) => s.rel.endsWith('log.js') || s.rel.endsWith('guard.js')),
  'the session-less reads are the debug logger and the thinking gate only',
  globalOnly.map((s) => s.rel).join(', '))
check(sessionAware.every((s) => /session|agent/.test(s.arg)), 'every session-aware call actually names a session')

// The override must be read from ONE place, so a session-less caller cannot
// accidentally observe it: the resolution lives in readSettings, not at the gates.
check(!settingsSrc.includes('sessionThresholds[session'), 'gates do not re-implement the lookup')

// ---------------------------------------- 8. host schema: writable by the client
check(/sessionThresholds: asVolatile\(z\.any\(\)\)/.test(settingsSrc),
  'sessionThresholds is declared as a volatile Config field (client-writable)')
check(/sessionThresholds: asVolatile\(z\.any\(\)\),\n/.test(settingsSrc) || settingsSrc.includes('sessionThresholds: asVolatile'),
  'the field sits inside the single Config object literal')
// ------------------------------- 9. client wiring: the chip is registered correctly
check(client.includes('ctx.slots.inject("conversation.composer.dock"'),
  'the chip injects into the composer-dock slot')
check(/id: "force-compact-threshold"/.test(client), 'the slot entry carries a dedicated id')
check(/order: 100/.test(client), 'order 100 places it after ui-chat StatsPills (order 0)')
check(/hooks: \{ forceCompact: store \}/.test(client), 'the chip subscribes to the shared configForms mirror')

// Writes must be ATOMIC path ops: the host writes liveUi into the same namespace
// on every request, so read-modify-write of the whole map would race.
check(/scope\.mutate\(\[\{ op: "set", path: \[SESSION_THRESHOLD_FIELD, sessionId\]/.test(client),
  'setting an override is a nested atomic path op (no read-modify-write)')
check(/scope\.mutate\(\[\{ op: "unset", path: \[SESSION_THRESHOLD_FIELD, sessionId\]/.test(client),
  'clearing an override is an atomic unset op')
check(!/scope\.set\(SESSION_THRESHOLD_FIELD/.test(client),
  'the whole-map set() form is NOT used (that would be the racy shape)')

// The pill must survive a composition without the dialog primitives.
check(/CHIP_PRIMITIVES/.test(client) && /CHIP_ANCHORED/.test(client),
  'the dialog primitives are resolved defensively (module-table miss degrades)')
check(/typeof sessionId !== "string"/.test(client), 'the chip renders nothing without a session id')

// Filter/parse surface: the popover input reuses the shared K/M parser.
check(/parseTokenScaleText\(String\(buf\)\.trim\(\), undefined\)/.test(client),
  'the popover parses its draft through the shared K/M parser')
check(/parsed < THRESHOLD_FLOOR \? THRESHOLD_FLOOR/.test(client), 'the popover clamps up to the floor before writing')

// ------------------------------------------- 10. locale parity across all four
const KEY_SET = [
  'thresholdChipAria', 'thresholdTitle', 'thresholdSessionLabel', 'thresholdHint',
  'thresholdSave', 'thresholdInvalid', 'thresholdFailed', 'thresholdUseDefault', 'thresholdOverridden',
]
for (const key of KEY_SET) {
  const hits = client.split(`${key}: "`).length - 1
  check(hits === 4, `locale key ${key} is present in all four languages`, `found ${hits}`)
}
check((client.split('autoThresholdTokens: "').length - 1) === 4, 'the global threshold label is still in all four languages')
check(/autoThresholdTokens: "[^"]*默认值/.test(client), 'the zh label now presents the global value as the DEFAULT')
check((client.split('autoThresholdTokensHint:').length - 1) === 4, 'the hint row survived the append')

// --------------------------------------------------------------- summary
console.log('')
if (failures === 0) {
  console.log('ALL GREEN')
} else {
  console.log(`${failures} FAILURE(S)`)
  process.exitCode = 1
}
