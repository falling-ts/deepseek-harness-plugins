// Offline probe for the `/force-compact` command row face (official-style icon +
// localized name + localized description).
//
// Why it exists: `ui-commands` gives a slash-menu row its icon and localized
// label ONLY for the six first-party commands listed in its `HOST_FACES` map
// (`presentation.ts`), matched by `definitionId`. A third-party host command has
// no such seam in 0.2.0-rc.2 -- the client half therefore attaches the face at
// the candidate-synthesis exit (`commandUi.candidates`). That wrapper is an
// implementation-detail seam, so every property it relies on is asserted here:
// install, per-row scoping, live locale lookup, idempotence, disposal restore,
// and silent degradation when upstream renames or removes the method.
//
// Run: node exploration/fc-command-face-probe.mjs
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../dsh-force-compact/web/client.js', import.meta.url), 'utf8')
const HOST_SRC = readFileSync(new URL('../dsh-force-compact/src/hooks/command.js', import.meta.url), 'utf8')

let passed = 0
const failures = []
function check(name, actual, expected) {
  if (actual === expected) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`) }
}

// -- minimal DOM / loader stubs (the module touches document at apply time) ---
class El {
  constructor(tag) { this.tagName = tag; this.childNodes = []; this.attrs = {}; this.id = undefined }
  append(child) { this.childNodes.push(child); return child }
  appendChild(child) { return this.append(child) }
  remove() {}
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  querySelectorAll() { return [] }
  querySelector() { return null }
}
const head = new El('HEAD')
const styles = new Map()
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 }
globalThis.document = {
  head,
  body: new El('BODY'),
  getElementById: (id) => styles.get(id) ?? null,
  createElement: (tag) => new El(tag.toUpperCase()),
  querySelectorAll: () => [],
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
const realAppend = head.append.bind(head)
head.append = (child) => { if (child.id !== undefined) styles.set(child.id, child); return realAppend(child) }

const React = {
  createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {},
  useMemo: (f) => f(), useRef: () => ({ current: null }),
}

/** Load the client half the way the browser module loader does. */
function loadFace({ primitives = { IconCompactOutlineRegular: function IconCompactOutlineRegular() {} }, primitivesThrows = false } = {}) {
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (init) => ({ update: (f) => f(init), getSnapshot: () => init }) }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitivesThrows) throw new Error('module table miss')
      return primitives
    }
    throw new Error(`unexpected require("${id}")`)
  }
  new Function(SRC)()
  if (loaded === null) throw new Error('module loader was never called')
  return loaded.factory(requireStub)
}

// -- the dictionaries the module carries (zh is the key-set source) ----------
function extractDict(src, name) {
  const at = src.indexOf(`const ${name} = {`)
  const start = src.indexOf('{', at)
  let depth = 0; let inStr = false; let esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return new Function(`return (${src.slice(start, i + 1)})`)() }
  }
  return null
}
const dicts = Object.fromEntries(['zh', 'en', 'ja', 'ko'].map((l) => [l, extractDict(SRC, l)]))

console.log('-- command row face probe --')

// 1) every language carries the two row-face keys, distinct from the raw name.
for (const lang of ['zh', 'en', 'ja', 'ko']) {
  const d = dicts[lang]
  check(`${lang}: cmdLabel present`, typeof d.cmdLabel === 'string' && d.cmdLabel.trim() !== '', true)
  check(`${lang}: cmdDescription present`, typeof d.cmdDescription === 'string' && d.cmdDescription.trim() !== '', true)
  check(`${lang}: label is not the raw command name`, d.cmdLabel.toLowerCase() === 'force-compact', false)
}
check('en description matches the host registration copy',
  dicts.en.cmdDescription, (HOST_SRC.match(/description: '([^']+)'/) ?? [])[1])

// 2) the host registration carries the official-style identity + one-line copy.
check('host registration declares a plugin-owned definitionId',
  /definitionId: '@falling-ts\/dsh-force-compact'/.test(HOST_SRC), true)
check('host description is a single short sentence (no parenthetical)',
  /description: '[^'()]{1,60}',/.test(HOST_SRC), true)

/**
 * Stand-in for `CommandUiRuntime`: same call shape as the harness's method.
 * A fresh class per instance -- one shared prototype would leak the patch (and
 * its locale closure) from one scenario into the next.
 */
function makeCommandUi(rows) {
  class FakeCommandUi {
    constructor() { this.rows = rows; this.calls = 0 }
    async candidates(_session, _req) {
      this.calls += 1
      return this.rows.map((row) => ({ ...row }))
    }
  }
  return new FakeCommandUi()
}

const ROWS = [
  { name: 'compact', description: 'Compact older conversation history' },
  { name: 'force-compact', description: 'Force-compact this session context now' },
  { name: 'export', description: 'Download this Session log as a ZIP archive' },
]

/** ctx stub: real enough for `apply`, plus the two seams the face installer uses. */
function makeCtx(commandUi, { lang = 'zh' } = {}) {
  const state = { lang }
  const effects = []
  const ctx = {
    state,
    effects,
    effect: (body, label) => { effects.push({ label, dispose: body() }) },
    get: (name) => (name === 'commandUi' ? commandUi : undefined),
    inject: (deps, callback) => { if (deps.includes('commandUi') && commandUi !== undefined) callback(ctx); return () => {} },
    locale: {
      bind: () => (key) => dicts[state.lang][key],
      register: () => () => {},
      addLanguage: () => () => {},
    },
    configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', value: {}, writable: true }), subscribe: () => () => {}, set: () => {}, unset: () => {} }) },
    slots: { inject: (_name, callback) => callback(), register: () => () => {} },
    logger: { debug: () => {}, warn: () => {} },
  }
  return ctx
}

// 3) install + per-row scoping.
{
  const ui = makeCommandUi(ROWS)
  const original = ui.candidates
  const face = loadFace()
  const ctx = makeCtx(ui)
  face.apply(ctx)

  const before = await original.call(ui, {}, {})
  check('original rows are the plain catalog face', before[1].label, undefined)

  const rows = await ui.candidates({}, {})
  const ours = rows.find((r) => r.name === 'force-compact')
  const compact = rows.find((r) => r.name === 'compact')
  const exp = rows.find((r) => r.name === 'export')
  check('our row gets the localized label', ours.label, dicts.zh.cmdLabel)
  check('our row gets the localized description', ours.description, dicts.zh.cmdDescription)
  check('our row gets an icon component', typeof ours.icon, 'function')
  check('our row keeps its name (MenuView renders it as the alias)', ours.name, 'force-compact')
  check('the official /compact row is untouched', JSON.stringify(compact), JSON.stringify(ROWS[0]))
  check('an unrelated row is untouched', JSON.stringify(exp), JSON.stringify(ROWS[2]))
  check('row count is unchanged (no manufactured command)', rows.length, ROWS.length)

  // 4) live locale lookup: the next menu pass reads the new language.
  ctx.state.lang = 'en'
  const en = (await ui.candidates({}, {})).find((r) => r.name === 'force-compact')
  check('locale change reaches the next candidate pass', en.label, dicts.en.cmdLabel)
  check('locale change also switches the description', en.description, dicts.en.cmdDescription)
  ctx.state.lang = 'ja'
  const ja = (await ui.candidates({}, {})).find((r) => r.name === 'force-compact')
  check('ja label resolved', ja.label, dicts.ja.cmdLabel)

  // 5) idempotence: a second apply must not stack a second wrapper.
  const wrapped = ui.candidates
  face.apply(makeCtx(ui))
  check('second apply does not re-wrap the same method', ui.candidates, wrapped)
  const callsBefore = ui.calls
  await ui.candidates({}, {})
  check('one menu pass still calls the original exactly once', ui.calls - callsBefore, 1)

  // 6) disposal restores the original method.
  const effect = ctx.effects.find((e) => String(e.label).includes('command row face'))
  check('a disposer was registered for the patch', effect !== undefined, true)
  if (effect !== undefined) effect.dispose()
  check('disposal restores the upstream method', ui.candidates, original)
  check('the restored method returns the plain face again',
    (await ui.candidates({}, {})).find((r) => r.name === 'force-compact').label, undefined)
}

// 7) degradation: no commandUi service, or a service without the method.
{
  const face = loadFace()
  let threw = false
  try { face.apply(makeCtx(undefined)) } catch { threw = true }
  check('absent commandUi service does not throw', threw, false)
}
{
  const face = loadFace()
  const ui = { kind: 'renamed-upstream' }
  let threw = false
  try { face.apply(makeCtx(ui)) } catch { threw = true }
  check('a service without candidates() does not throw', threw, false)
  check('nothing was added to the foreign service', Object.keys(ui).length, 1)
}
{
  // Upstream may keep the method but change its name: the wrapper is never
  // installed, and the plugin must still work (settings section included).
  const face = loadFace()
  const ui = makeCommandUi(ROWS)
  Object.defineProperty(ui, 'candidates', { value: undefined, writable: true, configurable: true })
  let threw = false
  try { face.apply(makeCtx(ui)) } catch { threw = true }
  check('a non-function candidates does not throw', threw, false)
}

// 8) degradation: the icon module is absent -- face keeps the copy, drops the glyph.
{
  const ui = makeCommandUi(ROWS)
  const face = loadFace({ primitivesThrows: true })
  face.apply(makeCtx(ui))
  const ours = (await ui.candidates({}, {})).find((r) => r.name === 'force-compact')
  check('missing icon module still yields the localized label', ours.label, dicts.zh.cmdLabel)
  check('missing icon module omits the icon field', 'icon' in ours, false)
}
{
  const ui = makeCommandUi(ROWS)
  const face = loadFace({ primitives: { IconCompactOutlineRegular: 'not-a-component' } })
  face.apply(makeCtx(ui))
  const ours = (await ui.candidates({}, {})).find((r) => r.name === 'force-compact')
  check('a non-component export omits the icon field', 'icon' in ours, false)
}

// 9) the row keeps its Host-declared input hint (if any) and every other field.
{
  const ui = makeCommandUi([{ name: 'force-compact', description: 'x', hint: '<text>' }])
  const face = loadFace()
  face.apply(makeCtx(ui))
  const ours = (await ui.candidates({}, {})).find((r) => r.name === 'force-compact')
  check('unrelated row fields survive the face', ours.hint, '<text>')
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} -- ${passed} passed, ${failures.length} failed`)
if (failures.length !== 0) process.exit(1)
