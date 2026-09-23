// End-to-end load probe for the force-compact client half.
//
// Evaluates web/client.js the way the browser module loader does
// (`window.__ModuleLoader__.load({ id, factory })`), runs `apply(ctx)` against a
// stub context, then drives the settings snapshot and asserts the visible
// turn-process label is rewritten. Catches wiring breakage (dangling
// references, missing disposers) that a syntax check cannot see.
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../dsh-force-compact/web/client.js', import.meta.url), 'utf8')

// ── DOM stub ────────────────────────────────────────────────────────────────
class TextNode {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentElement = null }
  get parentNode() { return this.parentElement }
}
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.childNodes = []; this.parentElement = null; this.attrs = {}; this.isConnected = true }
  get textContent() { return this.childNodes.filter(c => c.nodeType === 3).map(c => c.nodeValue).join('') }
  get children() { return this.childNodes.filter(c => c.nodeType === 1) }
  append(child) { child.parentElement = this; this.childNodes.push(child); return child }
  appendChild(child) { return this.append(child) }
  setText(value) { const node = new TextNode(value); node.parentElement = this; this.childNodes = [node]; return node }
  matches(selector) {
    return selector === 'button[data-turn-process] > span'
      && this.tagName === 'SPAN' && this.parentElement !== null
      && this.parentElement.tagName === 'BUTTON'
      && this.parentElement.attrs['data-turn-process'] !== undefined
  }
  querySelector(selector) {
    if (selector !== '[role="status"][aria-live="polite"]') return null
    return this.children.find(c => c.attrs.role === 'status' && c.attrs['aria-live'] === 'polite') ?? null
  }
}
const scopes = []
const head = new El('HEAD')
const styles = new Map()
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 }
globalThis.document = {
  head,
  body: new El('BODY'),
  getElementById: (id) => styles.get(id) ?? null,
  createElement: (tag) => new El(tag.toUpperCase()),
  querySelectorAll(selector) {
    if (selector !== 'button[data-turn-process] > span') return []
    return scopes.map(scope => scope.children.find(c => c.tagName === 'BUTTON').children[0])
  },
}
class MutationObserverStub {
  constructor(callback) { this.callback = callback; this.connected = false }
  observe() { this.connected = true }
  disconnect() { this.connected = false }
}
globalThis.MutationObserver = MutationObserverStub
// `<style id>` bookkeeping: the theme sheet appends itself; record it by id.
const realAppend = head.append.bind(head)
head.append = (child) => { if (child.attrs !== undefined && child.id !== undefined) styles.set(child.id, child); return realAppend(child) }

// ── module loader stub ──────────────────────────────────────────────────────
let loaded = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
const React = { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: () => ({ current: null }) }
const requireStub = (id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (init) => ({ update: (f) => f(init), getSnapshot: () => init }) }
  throw new Error(`unexpected require("${id}")`)
}
new Function(SRC)()
if (loaded === null) throw new Error('module loader was never called')
if (loaded.id !== '@falling-ts/dsh-force-compact') throw new Error(`unexpected module id ${loaded.id}`)
const face = loaded.factory(requireStub)

// ── ctx stub ────────────────────────────────────────────────────────────────
let snapshot = { status: 'ready', value: {}, writable: true }
let onSnapshot = () => {}
const effects = []
const ctx = {
  effect: (body, label) => { effects.push({ label, dispose: body() }) },
  locale: {
    bind: () => (key) => (key === 'badgeWorking13' ? '正在翻阅《天机》' : key),
    register: () => () => {},
    addLanguage: () => () => {},
  },
  configForms: {
    get: () => ({
      getSnapshot: () => snapshot,
      subscribe: (callback) => { onSnapshot = callback; return () => { onSnapshot = () => {} } },
      set: () => {}, unset: () => {},
    }),
  },
  slots: { inject: (_name, callback) => callback(), register: () => () => {} },
  logger: { debug: () => {}, warn: () => {} },
}

// ── assertions ──────────────────────────────────────────────────────────────
let passed = 0
const failures = []
function check(name, actual, expected) {
  if (actual === expected) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`) }
}

face.apply(ctx)
check('apply() ran and registered effects', effects.length >= 3, true)
check('theme sheet injected', styles.has('falling-ts-theme-tokens'), true)
check('no swish sheet injected', styles.has('falling-ts-swish-inline'), false)

// Mount one running turn, then drive the host's liveUi push.
const scope = new El('DIV')
const status = new El('SPAN')
status.attrs.role = 'status'
status.attrs['aria-live'] = 'polite'
status.setText('深度求索中')
const button = new El('BUTTON')
button.attrs['data-turn-process'] = '4'
const label = new El('SPAN')
const labelText = label.setText('深度求索中，用时1分14秒')
button.append(label)
scope.append(status)
scope.append(button)
scopes.push(scope)

snapshot = { status: 'ready', value: { liveUi: { phase: 'working', text: '正在翻阅《天机》', textId: 'working.13' } }, writable: true }
onSnapshot()
check('liveUi push rewrites the visible label', labelText.nodeValue, '正在翻阅《天机》，用时1分14秒')
check('announcement node untouched', status.textContent, '深度求索中')

// Clear (conversation end) restores the official text.
snapshot = { status: 'ready', value: { liveUi: { phase: 'end', text: '', textId: 'end' } }, writable: true }
onSnapshot()
check('end clear restores the official label', labelText.nodeValue, '深度求索中，用时1分14秒')

// Unloading the plugin disconnects the observer (the registered disposer runs).
const observerEffect = effects.find(e => String(e.label).includes('turn-label observer'))
check('observer disposer registered', observerEffect !== undefined, true)
if (observerEffect !== undefined) observerEffect.dispose()
check('disposer is callable after unload', typeof observerEffect.dispose, 'function')

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
if (failures.length !== 0) process.exit(1)
