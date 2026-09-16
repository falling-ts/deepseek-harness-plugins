// Probe: do both self-owned client halves carry complete, aligned zh/en/ja/ko
// dictionaries, contribute the ja/ko language-pack entries, and keep every
// product-visible string behind the locale service?
//
// Upstream ships only zh and en (@deepseek-ai/dsh-client-locale LOCALE_IDS);
// every other language arrives through the addLanguage language-pack seam. A
// typo'd key, a missing translation, or a hardcoded string therefore fails
// SILENTLY at runtime (the lookup chain falls back to en, or the raw key is
// shown), which is exactly what this probe makes loud.
//
// Run: node exploration/i18n-parity-probe.mjs
import fs from 'node:fs'

const LANGS = ['zh', 'en', 'ja', 'ko']

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

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
      if (depth === 0) {
        // The body is a pure object literal; evaluating it yields real keys and
        // values (escapes and {placeholder} templates intact).
        return new Function(`return (${src.slice(start, i + 1)})`)()
      }
    }
  }
  return null
}

/** Replace `const <lang> = { ... };` blocks and comments with blanks, keeping offsets. */
function stripDictionariesAndComments(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  let out = src
  for (const lang of [...LANGS, 'zh', 'en']) {
    const at = out.indexOf(`const ${lang} = {`)
    if (at < 0) continue
    const start = out.indexOf('{', at)
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < out.length; i++) {
      const c = out[i]
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
        if (depth === 0) { out = out.slice(0, start) + blank(out.slice(start, i + 1)) + out.slice(i + 1); break }
      }
    }
  }
  // Comments last, so a commented-out dictionary cannot be seen (or missed).
  return out
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)))
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/

/** Keys whose value is deliberately language-neutral (paths, SI unit suffixes). */
const LANGUAGE_NEUTRAL = /^(logFilePlaceholder|unitHz|unitMs)$/

/** Product copy left as a hardcoded string literal, excluding the language labels. */
function hardcodedCopy(src) {
  const body = stripDictionariesAndComments(src)
  const lineOf = (index) => {
    const start = body.lastIndexOf('\n', index) + 1
    const end = body.indexOf('\n', index)
    return body.slice(start, end < 0 ? body.length : end)
  }
  const hits = []
  for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const value = m[1]
    if (!CJK.test(value)) continue
    // contributeLanguages declares each language in its own script (日本語 /
    // 한국어) — that IS the locale identity, not translatable copy.
    if (/fallback:/.test(lineOf(m.index))) continue
    hits.push({ value, line: body.slice(0, m.index).split('\n').length })
  }
  return hits
}

/** Every `t("key")` / `tr("key")` call site's literal key. */
function translateKeys(src) {
  return [...src.matchAll(/\btr?\("([A-Za-z0-9_]+)"/g)].map((m) => m[1])
}

function checkPlugin({ name, file, hasHostBadge }) {
  console.log(`\n=== ${name} (${file}) ===`)
  const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const dicts = Object.fromEntries(LANGS.map((l) => [l, extractDict(src, l)]))

  for (const lang of LANGS) {
    check(dicts[lang] !== null, `${lang} dictionary present`)
  }
  if (LANGS.some((l) => dicts[l] === null)) return

  const base = Object.keys(dicts.zh)
  check(base.length > 0, `zh carries the key set (${base.length} keys)`)
  for (const lang of LANGS.filter((l) => l !== 'zh')) {
    const keys = Object.keys(dicts[lang])
    const missing = base.filter((k) => !(k in dicts[lang]))
    const extra = keys.filter((k) => !base.includes(k))
    check(missing.length === 0 && extra.length === 0,
      `${lang} key set matches zh (${keys.length} keys)`,
      `missing=[${missing}] extra=[${extra}]`)
  }
  // A value still equal to zh is untranslated — except for language-neutral
  // entries. en must be clean everywhere; ja/ko legitimately share kanji/hanja
  // with zh for some terms (音量), so they get a coverage ratio instead of an
  // exact rule: a dictionary left wholly in Chinese would fail it.
  const comparable = base.filter((k) => !LANGUAGE_NEUTRAL.test(k) && dicts.zh[k] !== '')
  const sameAsZh = (lang) => comparable.filter((k) => dicts[lang][k] === dicts.zh[k])
  const enCopied = sameAsZh('en')
  check(enCopied.length === 0, 'en has no value left identical to zh',
    `identical=[${enCopied.slice(0, 6)}]`)
  for (const lang of ['ja', 'ko']) {
    const identical = sameAsZh(lang)
    const translated = comparable.length - identical.length
    check(translated / comparable.length >= 0.6,
      `${lang} translated most keys (${translated}/${comparable.length} differ from zh)`,
      `identical=[${identical.slice(0, 8)}]`)
  }

  // Registration surface: all four locales into one namespace, plus the
  // language-pack catalog entries the settings Language row lists.
  const registerCall = src.match(/locale\.register\(\s*NS\s*,\s*\{([^}]*)\}/)
  check(registerCall !== null, 'registers its namespace in one call')
  if (registerCall) {
    for (const lang of LANGS) {
      check(new RegExp(`\\b${lang}\\b`).test(registerCall[1]), `register() includes ${lang}`)
    }
  }
  for (const [id, label] of [['ja', '日本語'], ['ko', '한국어']]) {
    check(new RegExp(`id:\\s*"${id}",\\s*label:\\s*"${label}",\\s*fallback:\\s*"en"`).test(src),
      `contributes language ${id} ("${label}", fallback en)`)
  }
  check(/locale\.addLanguage\(/.test(src), 'addLanguage seam is the contribution path')
  check(/is already registered/.test(src), 'tolerates a sibling plugin owning the same language id')

  // Copy ownership: no product-visible string may sit outside the dictionaries.
  const hard = hardcodedCopy(src)
  check(hard.length === 0, 'no hardcoded CJK copy outside the dictionaries',
    hard.map((h) => `L${h.line}:${h.value}`).join(' '))

  // Referenced keys must exist; declared keys must be referenced (dead copy).
  const used = new Set(translateKeys(src))
  const unknown = [...used].filter((k) => !base.includes(k))
  check(unknown.length === 0, 'every t()/tr() key exists in zh', `unknown=[${unknown}]`)
  // The badge keys are selected by construction ('badge' + capitalized textId,
  // 'badgeWorking' + index), so only literal-reference keys can be judged dead.
  const dynamic = /^badge/
  const dead = base.filter((k) => !dynamic.test(k) && !src.includes(`"${k}"`))
  check(dead.length === 0, 'every declared key is referenced somewhere', `dead=[${dead}]`)

  if (hasHostBadge) {
    // Index alignment against the host's canonical WORKING_TEXTS: the client's
    // zh entries shadow liveUi.text, so drift here changes what a zh user sees.
    const host = fs.readFileSync(new URL('../dsh-force-compact/src/core/ui-signal.js', import.meta.url), 'utf8')
    const hostTexts = [...host.match(/WORKING_TEXTS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
      .matchAll(/'([^']*)'/g)].map((m) => m[1])
    const zhBadge = Array.from({ length: 20 }, (_, i) => dicts.zh[`badgeWorking${i}`])
    check(zhBadge.length === hostTexts.length, `20 badgeWorking entries vs host ${hostTexts.length}`)
    check(zhBadge.every((t, i) => t === hostTexts[i]), 'zh badge texts match the host order/content')
    for (const lang of ['en', 'ja', 'ko']) {
      const list = Array.from({ length: 20 }, (_, i) => dicts[lang][`badgeWorking${i}`])
      check(list.every((v) => typeof v === 'string' && v.length > 0), `${lang} badge texts complete (20)`)
    }
  }
}

checkPlugin({ name: 'dsh-force-compact', file: 'dsh-force-compact/web/client.js', hasHostBadge: true })
checkPlugin({ name: 'dsh-web-ding', file: 'dsh-web-ding/web/client.js', hasHostBadge: false })

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
