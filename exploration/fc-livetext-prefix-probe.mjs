// Behavioural probe for the force-compact LiveUI prefix replacer.
//
// Extracts the REAL `TURN_LABEL_SELECTOR` … `paintTurnStatus` span out of
// web/client.js and runs it against a minimal DOM stub, so the shipped code
// (not a copy) is exercised: prefix replacement, elapsed-time preservation,
// the per-second React rewrite, the clear/restore path, and locale fallback.
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../dsh-force-compact/web/client.js', import.meta.url), 'utf8')
const START = '/** 可见运行标签：button 带稳定属性 data-turn-process，其 span 即文案载体。 */'
const start = SRC.indexOf(START)
if (start < 0) throw new Error('prefix-replacer start marker not found')
const fnStart = SRC.indexOf('function paintTurnStatus(', start)
if (fnStart < 0) throw new Error('paintTurnStatus not found')
const end = SRC.indexOf('\n    }\n', fnStart)
if (end < 0) throw new Error('paintTurnStatus closer not found')
const span = SRC.slice(start, end + '\n    }'.length)
if (!span.includes('function timeSuffixOf') || !span.includes('function resolvedText')) {
  throw new Error('extracted span is missing helpers')
}

// ── minimal DOM stub ────────────────────────────────────────────────────────
class TextNode {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentElement = null }
  get parentNode() { return this.parentElement }
}
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.childNodes = []; this.parentElement = null; this.attrs = {}; this.isConnected = true }
  get textContent() { return this.childNodes.filter(c => c.nodeType === 3).map(c => c.nodeValue).join('') }
  get children() { return this.childNodes.filter(c => c.nodeType === 1) }
  append(child) { child.parentElement = this; this.childNodes.push(child); return child }
  setText(value) { const node = new TextNode(value); node.parentElement = this; this.childNodes = [node]; return node }
  matches(selector) {
    return selector === 'button[data-turn-process] > span'
      && this.tagName === 'SPAN'
      && this.parentElement !== null
      && this.parentElement.tagName === 'BUTTON'
      && this.parentElement.attrs['data-turn-process'] !== undefined
  }
  querySelector(selector) {
    if (selector !== '[role="status"][aria-live="polite"]') return null
    return this.children.find(child => child.attrs.role === 'status' && child.attrs['aria-live'] === 'polite') ?? null
  }
}
const observers = []
class MutationObserverStub {
  constructor(callback) { this.callback = callback; this.connected = false; observers.push(this) }
  observe() { this.connected = true }
  disconnect() { this.connected = false }
}
const scopes = []
const documentStub = {
  body: new El('BODY'),
  querySelectorAll(selector) {
    if (selector !== 'button[data-turn-process] > span') return []
    return scopes.map(scope => scope.children.find(c => c.tagName === 'BUTTON').children[0])
  },
}
const NodeStub = { TEXT_NODE: 3, ELEMENT_NODE: 1 }

/** Build one turn-process DOM fragment: hidden announcement + button>span.label. */
function mount(announcement, label) {
  const scope = new El('DIV')
  const status = new El('SPAN')
  status.attrs.role = 'status'
  status.attrs['aria-live'] = 'polite'
  status.setText(announcement)
  const button = new El('BUTTON')
  button.attrs['data-turn-process'] = '1'
  const labelEl = new El('SPAN')
  const textNode = labelEl.setText(label)
  button.append(labelEl)
  scope.append(status)
  scope.append(button)
  scopes.push(scope)
  return { scope, labelEl, textNode }
}

const api = new Function('document', 'Node', 'MutationObserver', `${span}\nreturn { paintTurnStatus };`)(
  documentStub, NodeStub, MutationObserverStub,
)

// ── assertions ──────────────────────────────────────────────────────────────
let passed = 0
const failures = []
function check(name, actual, expected) {
  if (actual === expected) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(`${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); console.log(`  FAIL ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`) }
}
const zhT = (key) => ({
  badgeCompressing: '[压缩中]', badgeDone: '[完成]', badgeEnd: '',
  badgeWorking13: '正在翻阅《天机》...', badgeWorking7: '假装很忙...',
}[key] ?? key)
const enT = (key) => ({
  badgeCompressing: '[compressing]', badgeDone: '[done]', badgeEnd: '',
  badgeWorking13: 'Consulting the oracle...', badgeWorking7: 'Looking busy...',
}[key] ?? key)

// 1 · zh running label: replace the leading phrase, keep "，用时…" verbatim.
const zh = mount('深度求索中', '深度求索中，用时1分14秒')
api.paintTurnStatus({ phase: 'working', text: '正在翻阅《天机》...', textId: 'working.13' }, zhT)
check('zh: prefix replaced, harness clock preserved', zh.textNode.nodeValue, '正在翻阅《天机》...，用时1分14秒')

// 2 · en running label keeps its own connector (" for ").
const en = mount('Deep diving...', 'Deep diving for 1m 14s')
api.paintTurnStatus({ phase: 'working', text: 'Consulting the oracle...', textId: 'working.13' }, enT)
check('en: prefix replaced, harness clock preserved', en.textNode.nodeValue, 'Consulting the oracle... for 1m 14s')

// 3 · announcement node untouched (a11y restored to the official text).
check('a11y announcement untouched', zh.scope.children[0].textContent, '深度求索中')

// 4 · no-duration form (turn.start absent) → prefix only.
const bare = mount('深度求索中', '深度求索中')
api.paintTurnStatus({ phase: 'working', text: '假装很忙...', textId: 'working.7' }, zhT)
check('no-duration form → prefix only', bare.textNode.nodeValue, '假装很忙...')

// 5 · ended turn ("用时 2分5秒" vs announcement "已完成工作") → untouched.
const ended = mount('已完成工作', '用时 2分5秒')
api.paintTurnStatus({ phase: 'working', text: '假装很忙...', textId: 'working.7' }, zhT)
check('ended label left official', ended.textNode.nodeValue, '用时 2分5秒')

// 6 · phase change while our text is still in place (React has not rewritten yet).
api.paintTurnStatus({ phase: 'compressing', text: '[强制压缩中>>>]', textId: 'compressing' }, zhT)
check('phase change repaints in place', zh.textNode.nodeValue, '[压缩中]，用时1分14秒')

// 7 · per-second React rewrite → the observer re-applies with the FRESH clock.
const observer = observers[observers.length - 1]
zh.textNode.nodeValue = '深度求索中，用时1分15秒'   // React writes the official text again
observer.callback([{ type: 'characterData', target: zh.textNode, addedNodes: [] }])
check('observer re-applies after a React rewrite', zh.textNode.nodeValue, '[压缩中]，用时1分15秒')

// 8 · our own write must not self-excite (same value → no further change).
zh.textNode.nodeValue = '[压缩中]，用时1分15秒'
observer.callback([{ type: 'characterData', target: zh.textNode, addedNodes: [] }])
check('own write is idempotent (no self-excitation)', zh.textNode.nodeValue, '[压缩中]，用时1分15秒')

// 9 · clear (textId 'end') → official text restored, observer disconnected.
api.paintTurnStatus({ phase: 'end', text: '', textId: 'end' }, zhT)
check('clear restores the official text', zh.textNode.nodeValue, '深度求索中，用时1分15秒')
check('clear disconnects the observer', observer.connected, false)

// 10 · fallback: no dictionary entry / no t → the host's canonical text.
const noT = mount('深度求索中', '深度求索中，用时3秒')
api.paintTurnStatus({ phase: 'working', text: '正在酝酿骚操作...', textId: 'working.99' }, undefined)
check('unknown textId falls back to the canonical text', noT.textNode.nodeValue, '正在酝酿骚操作...，用时3秒')

// 11 · two open sessions are painted independently.
const second = mount('深度求索中', '深度求索中，用时5秒')
api.paintTurnStatus({ phase: 'working', text: '正在驯服混沌...', textId: 'working.11' }, zhT)
check('all open sessions painted', `${noT.textNode.nodeValue} | ${second.textNode.nodeValue}`,
  '正在驯服混沌...，用时3秒 | 正在驯服混沌...，用时5秒')

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
if (failures.length !== 0) { for (const f of failures) console.log(`  ${f}`); process.exit(1) }
