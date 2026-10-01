// Probe: the two halves of the K/M token-scale feature must agree.
//
// 1. `src/core/token-scale.js` (host) and `web/client.js` (browser) are two
//    independently bundled artifacts of one package, so the parser is
//    necessarily written twice. This probe extracts the REAL client function
//    and runs it head-to-head against the REAL host function over a shared
//    case table — drift in either direction fails.
// 2. The three token rows must be wired to the suffix-accepting hook and
//    rendered as text inputs (`tokenRow`), not the plain number rows.
// 3. Every locale must carry the same new `tokenScalePlaceholder` key and say
//    that K/M suffixes are accepted, or the affordance is invisible.
//
// Run: node exploration/fc-token-scale-parity-probe.mjs
import fs from 'node:fs'
import { parseTokenScale } from '../dsh-force-compact/src/core/token-scale.js'

const root = new URL('../dsh-force-compact/', import.meta.url)
const client = fs.readFileSync(new URL('web/client.js', root), 'utf8')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : '  ' + detail}`)
}

// ---------------------------------------------------------------- 1. parser
const fnSource = client.match(/function parseTokenScaleText\(raw, fallback\) \{[\s\S]*?\n {4}\}/)
check(fnSource !== null, 'client parseTokenScaleText is present')
const clientParse = new Function(`${fnSource[0]}\nreturn parseTokenScaleText`)()

const CASES = [
  ['32000', 32000], ['32K', 32000], ['32k', 32000], ['1M', 1000000],
  ['1m', 1000000], ['1.5M', 1500000], ['0.5K', 500], ['.5K', 500],
  ['1_000_000', 1000000], ['1,000,000', 1000000], ['1 M', 1000000],
  [' 8K ', 8000], ['+8K', 8000], ['-5', -5], ['0', 0],
  ['', null], ['   ', null], ['abc', null], ['1e3', null], ['1G', null],
  ['K', null], ['K32', null], ['32KK', null], ['NaN', null],
  [undefined, null], [null, null], [32000, 32000], [1.9, 1], [0.4, 0],
  [NaN, null], [Infinity, null], [-Infinity, null], [true, null], [{}, null],
  ['32000', 32000], ['1000000', 1000000],
]

let mismatches = 0
for (const [input, expected] of CASES) {
  const host = parseTokenScale(input, null)
  const web = clientParse(input, null)
  const agree = Object.is(host, web)
  const right = Object.is(host, expected)
  if (!agree || !right) {
    mismatches++
    console.log(`  MISMATCH ${JSON.stringify(input)} host=${JSON.stringify(host)} client=${JSON.stringify(web)} expected=${JSON.stringify(expected)}`)
  }
}
check(mismatches === 0, `host/client agree on all ${CASES.length} cases and match expectations`)

// decimal base is the documented contract: 32K must equal the 32000 default
check(parseTokenScale('32K', null) === 32000, 'decimal base: 32K === 32000 (the shipped default)')
check(parseTokenScale('1M', null) === 1000000, 'decimal base: 1M === 1000000')

// ------------------------------------------------------- 2. wiring & rows
const TOKEN_KEYS = ['autoThresholdTokens', 'retainLatestTokens', 'maxSummaryTokens']
for (const key of TOKEN_KEYS) {
  check(
    client.includes(`useDraftTokenScale("${key}"`),
    `${key} goes through useDraftTokenScale`,
  )
  check(
    client.includes(`tokenRow("${key}"`),
    `${key} renders through tokenRow (text input)`,
  )
  check(
    !client.includes(`numberRow("${key}"`),
    `${key} no longer renders through numberRow`,
  )
}
const tokenRowBody = client.match(/function tokenRow\([\s\S]*?\n {6}\}/)
check(tokenRowBody !== null, 'tokenRow is defined')
check(tokenRowBody !== null && tokenRowBody[0].includes('type: "text"'), 'tokenRow renders a text input')
const hookBody = client.match(/function useDraftTokenScale\([\s\S]*?\n {4}\}/)
check(hookBody !== null && hookBody[0].includes('parseTokenScaleText'), 'the hook parses the suffix before writing')
check(hookBody !== null && hookBody[0].includes('update(key, c)'), 'the hook writes the parsed INTEGER back (store stays numeric)')
// The ms timeout row must stay a plain number row — it is not a token budget.
check(client.includes('numberRow("summarizationTimeoutMs"'), 'summarizationTimeoutMs stays a number row')

// ------------------------------------------------------------- 3. locales
const LANGUAGES = ['zh', 'en', 'ja', 'ko']
for (const lang of LANGUAGES) {
  const block = client.match(new RegExp(`const ${lang} = \\{([\\s\\S]*?)\\n {4}\\};`))
  check(block !== null, `${lang} dictionary is present`)
  if (block === null) continue
  check(/tokenScalePlaceholder:\s*".+"/.test(block[1]), `${lang} carries tokenScalePlaceholder`)
  for (const key of TOKEN_KEYS) {
    const hint = block[1].match(new RegExp(`${key}Hint:\\s*"([^"]*)"`))
    check(hint !== null && /K\/M/.test(hint[1]), `${lang} ${key}Hint advertises K/M`, hint === null ? '' : '')
  }
}

// key sets must stay aligned across languages (zh is the source of truth)
const keySets = LANGUAGES.map((lang) => {
  const block = client.match(new RegExp(`const ${lang} = \\{([\\s\\S]*?)\\n {4}\\};`))
  return [...block[1].matchAll(/^ {6}([A-Za-z0-9_]+):/gm)].map((m) => m[1]).sort()
})
const sameKeys = keySets.every((set) => set.length === keySets[0].length && set.every((k, i) => k === keySets[0][i]))
check(sameKeys, 'all four dictionaries share one key set', `keys=${keySets[0].length}`)

console.log(failures === 0 ? '\nALL PASS' : `\nFAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)