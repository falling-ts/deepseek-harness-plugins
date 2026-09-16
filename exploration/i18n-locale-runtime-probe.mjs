// Probe: drives the REAL upstream LocaleRuntime (imported from
// packages/client/locale/src/client/index.ts through tsx) with the REAL
// contributeLanguages() and dictionaries lifted verbatim out of my two client
// halves, then switches languages and resolves copy through the official
// lookup chain.
//
// Why this exists: upstream ships only zh and en, so ja/ko depend on the
// addLanguage language-pack seam and on each plugin's own dictionary
// registration. Two failure modes are invisible in a source-text check and
// only appear at runtime — a language whose catalog entry is missing (so the
// Language row never offers it and browser detection cannot match it), and the
// second plugin's addLanguage throwing because the first already owns that id.
//
// Run: node --import <deepseek-harness>/node_modules/tsx/dist/esm/index.mjs \
//        exploration/i18n-locale-runtime-probe.mjs
import fs from 'node:fs'
import { register } from 'node:module'

// The official module pulls in its settings-row React component and a CSS
// Module for `apply`, which the probe never calls. Stub those two shapes before
// importing it (see lib/client-ui-stub-loader.mjs).
register(new URL('./lib/client-ui-stub-loader.mjs', import.meta.url))
const {
  FALLBACK_LOCALE, LocaleRuntime,
} = await import('../deepseek-harness/packages/client/locale/src/client/index.ts')
// The built-in id list lives in the shared settings module (the client entry
// does not re-export it); importing it separately keeps the assertion honest.
const { LOCALE_IDS } = await import('../deepseek-harness/packages/client/locale/src/locale-settings.ts')

const LANGS = ['zh', 'en', 'ja', 'ko']
let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (actual, expected, label) =>
  check(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

/** Extract a `const <name> = { ... };` object literal and evaluate it. */
function extractDict(src, name) {
  const at = src.indexOf(`const ${name} = {`)
  if (at < 0) return null
  const start = src.indexOf('{', at)
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return new Function(`return (${src.slice(start, i + 1)})`)()
    }
  }
  return null
}

/** Extract a top-level `function <name>(...) { ... }` declaration and evaluate it. */
function extractFunction(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return null
  const start = src.indexOf('{', at)
  let depth = 0
  let inStr = false
  let esc = false
  let lineComment = false
  let blockComment = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (lineComment) { if (c === '\n') lineComment = false; continue }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++ } continue }
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '/' && next === '/') { lineComment = true; i++; continue }
    if (c === '/' && next === '*') { blockComment = true; i++; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return new Function(`return (${src.slice(at, i + 1)})`)()
    }
  }
  return null
}

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const forceCompact = read('dsh-force-compact/web/client.js')
const webDing = read('dsh-web-ding/web/client.js')

const fcDicts = Object.fromEntries(LANGS.map((l) => [l, extractDict(forceCompact, l)]))
const wdDicts = Object.fromEntries(LANGS.map((l) => [l, extractDict(webDing, l)]))
const fcLanguages = extractFunction(forceCompact, 'contributeLanguages')
const wdLanguages = extractFunction(webDing, 'contributeLanguages')

/** Minimal client ctx: the runtime only needs to register effects and emit. */
const clientCtx = () => ({ effect: (fn) => fn(), emit: () => {} })

console.log('=== upstream locale catalog ===')
eq(LOCALE_IDS.join(','), 'zh,en', 'upstream ships exactly zh + en')
eq(FALLBACK_LOCALE, 'en', 'English is the fallback terminal')
check(typeof LocaleRuntime === 'function', 'the real LocaleRuntime loaded from source')
check(fcLanguages !== null && wdLanguages !== null, 'both contributeLanguages lifted from source')

console.log('\n=== plugin A contributes the ja/ko language pack ===')
const solo = new LocaleRuntime(clientCtx())
eq(solo.getSnapshot().locales.map((l) => l.id).join(','), 'zh,en', 'fresh catalog is zh,en')
const disposeSolo = fcLanguages(solo)
const ids = solo.getSnapshot().locales.map((l) => l.id).join(',')
eq(ids, 'zh,en,ja,ko', 'addLanguage appends ja and ko')
const ja = solo.getSnapshot().locales.find((l) => l.id === 'ja')
const ko = solo.getSnapshot().locales.find((l) => l.id === 'ko')
eq(ja.label, '日本語', 'ja is labelled in its own language')
eq(ko.label, '한국어', 'ko is labelled in its own language')
eq(ja.fallback, 'en', 'ja falls back to en (chain must terminate at English)')
check(solo.getSnapshot().revision > 0, 'catalog registration bumps the revision')

console.log('\n=== the sibling plugin must tolerate the same ids ===')
const shared = new LocaleRuntime(clientCtx())
const disposeA = fcLanguages(shared)
let siblingError = null
let disposeB = null
try { disposeB = wdLanguages(shared) } catch (error) { siblingError = error }
check(siblingError === null, 'the second plugin does not throw on an owned language id',
  siblingError ? String(siblingError.message) : '')
eq(shared.getSnapshot().locales.map((l) => l.id).join(','), 'zh,en,ja,ko', 'catalog has no duplicate entry')
// The losing plugin owns nothing, so its disposer must not remove the winner's entry.
disposeB()
eq(shared.getSnapshot().locales.map((l) => l.id).join(','), 'zh,en,ja,ko',
  'the non-owning disposer leaves the language in place')
disposeA()
eq(shared.getSnapshot().locales.map((l) => l.id).join(','), 'zh,en',
  'the owning disposer removes exactly its own entries')

console.log('\n=== both dictionaries resolve per active language ===')
const rt = new LocaleRuntime(clientCtx())
const disposeLangs = fcLanguages(rt)
const disposeFc = rt.register('settings.forceCompact', fcDicts)
const disposeWd = rt.register('settings.webDing', wdDicts)
const tFc = rt.bind('settings.forceCompact')
const tWd = rt.bind('settings.webDing')
for (const lang of LANGS) {
  rt.setLocale(lang)
  eq(rt.getLocale().active, lang, `setLocale("${lang}") takes effect`)
  eq(tFc('nav'), fcDicts[lang].nav, `force-compact nav resolves in ${lang}`)
  eq(tWd('nav'), wdDicts[lang].nav, `web-ding nav resolves in ${lang}`)
}
check(tFc === rt.bind('settings.forceCompact'), 'bind() returns a stable identity per namespace')

console.log('\n=== placeholders and the fallback chain ===')
rt.setLocale('ja')
eq(tWd('doneTitle', { title: 'ABC' }), wdDicts.ja.doneTitle.replace('{title}', 'ABC'),
  'ja placeholder interpolation')
eq(tWd('sessionLabel', { id: 'x1' }), wdDicts.ja.sessionLabel.replace('{id}', 'x1'),
  'ja session placeholder interpolation')
eq(tFc('missingKey'), 'missingKey', 'an unknown key renders the key itself (hence the parity probe)')
// A ja dictionary lacking a key must reach en, not zh: the chain is ja -> en.
rt.register('probe.partial', { en: { only: 'EN-ONLY' }, ja: {} })
eq(rt.bind('probe.partial')('only'), 'EN-ONLY', 'a key absent from ja falls through to en')
rt.setLocale('ko')
eq(rt.bind('probe.partial')('only'), 'EN-ONLY', 'a key absent from ko falls through to en')

console.log('\n=== browser detection reaches the contributed language ===')
// detectBrowserLocale only runs when `window` exists (Node's own global
// navigator must not decide the locale for non-browser runs). Each case needs
// its own navigator, since the provisional locale is resolved at construction
// and recomputed on every catalog change.
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const withBrowser = (languages, fn) => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { languages, language: languages[0] }, configurable: true, writable: true,
  })
  return fn()
}
try {
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true })

  const detected = (languages, contributions) => withBrowser(languages, () => {
    const runtime = new LocaleRuntime(clientCtx())
    for (const c of contributions) runtime.addLanguage(c)
    return runtime.getLocale().active
  })
  const JA = { id: 'ja', label: '日本語', fallback: 'en' }
  const KO = { id: 'ko', label: '한국어', fallback: 'en' }

  eq(detected(['ja-JP', 'en-US'], [JA]), 'ja', 'a ja-JP browser selects the contributed ja')
  eq(detected(['ko-KR', 'en-US'], [KO]), 'ko', 'a ko-KR browser selects the contributed ko')
  eq(detected(['ko-KR'], [JA, KO]), 'ko', 'a ko-KR browser picks ko over the other contribution')
  eq(detected(['ja-JP'], [JA, KO]), 'ja', 'a ja-JP browser picks ja over the other contribution')
  eq(detected(['fr-FR', 'de'], [JA, KO]), 'en', 'an unregistered browser language falls back to en')
  // Exact-tag precedence: a regional registration wins over the language-wide one.
  eq(detected(['ja-JP'], [JA, { id: 'ja-JP', label: '日本語 (日本)', fallback: 'ja' }]), 'ja-JP',
    'an exact regional registration wins over the primary-subtag match')
} catch (error) {
  check(false, 'browser detection section ran', String(error.message))
} finally {
  for (const [name, saved] of [['window', savedWindow], ['navigator', savedNavigator]]) {
    if (saved) Object.defineProperty(globalThis, name, saved)
    else delete globalThis[name]
  }
}

console.log('\n=== disposal leaves no residue ===')
disposeFc(); disposeWd(); disposeLangs()
// A namespace whose dictionaries are gone renders keys; the catalog is back to built-ins.
rt.setLocale('en')
eq(rt.getLocale().active, 'en', 'en still selectable after the language pack left')
eq(rt.bind('settings.webDing')('nav'), 'nav', 'unregistered namespace renders keys')

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
