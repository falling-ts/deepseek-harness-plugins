// Behavioural probe for the force-compact LiveUI prefix replacer.
//
// Extracts the REAL `RUNNING_ROOT_SELECTOR` … `paintTurnStatus` span out of
// web/client.js and runs it against a minimal DOM stub, so the shipped code
// (not a copy) is exercised against the harness 0.2.0 running-status DOM:
//   div[data-chat-running] > [role=status] + .runningDivider + .runningContent
//     > .runningIcon (whale animation — MUST stay untouched)
//     > TextShimmer[data-shimmer] > .content > .text  (real text node)
//                                > .decoration > .sweep > .highlight
//                                    > .text[data-shimmer-text]  (CSS ::after copy)
// Covers prefix replacement, elapsed-time preservation (including the official
// trailing " ···"), the dual write into the shimmer copy, the per-second React
// rewrite, the whale-icon/announcement invariants, and the clear/restore path.
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../dsh-force-compact/web/client.js', import.meta.url), 'utf8')
const START = '/** 运行态容器：RunningStatus 的 div 带稳定属性 data-chat-running。 */'
const start = SRC.indexOf(START)
if (start < 0) throw new Error('prefix-replacer start marker not found')
const fnStart = SRC.indexOf('function paintTurnStatus(', start)
if (fnStart < 0) throw new Error('paintTurnStatus not found')
const end = SRC.indexOf('\n    }\n', fnStart)
if (end < 0) throw new Error('paintTurnStatus closer not found')
const span = SRC.slice(start, end + '\n    }'.length)
for (const helper of ['function timeSuffixOf', 'function resolvedText', 'function runningTextOf', 'function writeDecoration']) {
  if (!span.includes(helper)) throw new Error(`extracted span is missing ${helper}`)
}

// ── minimal DOM stub ────────────────────────────────────────────────────────
class TextNode {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentElement = null }
  get parentNode() { return this.parentElement }
}
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.childNodes = []; this.parentElement = null; this.attrs = {}; this.isConnected = true }
  get textContent() {
    return this.childNodes.map(c => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('')
  }
  get children() { return this.childNodes.filter(c => c.nodeType === 1) }
  append(child) { child.parentElement = this; this.childNodes.push(child); return child }
  setText(value) { const node = new TextNode(value); node.parentElement = this; this.childNodes = [node]; return node }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  /** Only the selectors web/client.js actually uses. */
  matches(selector) {
    if (selector === '[data-chat-running]') return this.getAttribute('data-chat-running') !== null
    if (selector === '[data-shimmer]') return this.getAttribute('data-shimmer') !== null
    if (selector === '[data-shimmer-text]') return this.getAttribute('data-shimmer-text') !== null
    if (selector === '[role="status"][aria-live="polite"]') return this.attrs.role === 'status' && this.attrs['aria-live'] === 'polite'
    if (selector === '*') return true
    return false
  }
  descendants() {
    const out = []
    for (const child of this.children) { out.push(child); out.push(...child.descendants()) }
    return out
  }
  querySelectorAll(selector) { return this.descendants().filter(el => el.matches(selector)) }
  querySelector(selector) { const hits = this.querySelectorAll(selector); return hits.length === 0 ? null : hits[0] }
}
const observers = []
class MutationObserverStub {
  constructor(callback) { this.callback = callback; this.connected = false; this.options = null; observers.push(this) }
  observe(_target, options) { this.connected = true; this.options = options }
  disconnect() { this.connected = false }
}
const roots = []
const settled = []
const documentStub = {
  body: new El('BODY'),
  querySelectorAll(selector) {
    if (selector === '[data-chat-running]') return roots.filter(root => root.isConnected)
    return []
  },
}
const NodeStub = { TEXT_NODE: 3, ELEMENT_NODE: 1 }

/**
 * Build one harness-0.2.0 running-status fragment.
 * @param announcement role=status text (the official `chat.deepDiving`).
 * @param label TextShimmer text (the official `chat.deepDivingFor`).
 */
function mount(announcement, label) {
  const root = new El('DIV'); root.setAttribute('data-chat-running', '')
  const status = new El('SPAN'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setText(announcement)
  const divider = new El('SPAN'); divider.setAttribute('aria-hidden', 'true')
  const content = new El('SPAN')
  const icon = new El('SPAN'); icon.setAttribute('aria-hidden', 'true')
  const animated = icon.append(new El('SPAN'))
  const shimmer = new El('SPAN'); shimmer.setAttribute('data-shimmer', 'true')
  const base = shimmer.append(new El('SPAN'))
  const realTextEl = base.append(new El('SPAN'))
  const textNode = realTextEl.setText(label)
  const decoration = shimmer.append(new El('SPAN')); decoration.setAttribute('aria-hidden', 'true')
  const sweep = decoration.append(new El('SPAN'))
  const highlight = sweep.append(new El('SPAN'))
  const decoText = highlight.append(new El('SPAN')); decoText.setAttribute('data-shimmer-text', label)
  content.append(icon); content.append(shimmer)
  root.append(status); root.append(divider); root.append(content)
  roots.push(root)
  return { root, status, divider, icon, animated, shimmer, realTextEl, textNode, decoText }
}

/** Settled turns (button[data-turn-process]) must never be painted by this plugin. */
function mountSettledTurn(announcement, label) {
  const scope = new El('DIV')
  const status = new El('SPAN'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setText(announcement)
  const button = new El('BUTTON'); button.setAttribute('data-turn-process', '1')
  const labelEl = new El('SPAN')
  const textNode = labelEl.setText(label)
  button.append(labelEl); scope.append(status); scope.append(button)
  settled.push({ scope, textNode })
  return { scope, textNode }
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
  badgeWorking13: '正在翻阅《天机》', badgeWorking7: '假装很忙',
}[key] ?? key)
const enT = (key) => ({
  badgeCompressing: '[compressing]', badgeDone: '[done]', badgeEnd: '',
  badgeWorking13: 'Consulting the oracle...', badgeWorking7: 'Looking busy...',
}[key] ?? key)

// 1 · zh running label: replace the leading phrase, keep the clock AND the official " ···".
const zh = mount('深度求索中', '深度求索中，用时1分14秒 ···')
api.paintTurnStatus({ phase: 'working', text: '正在翻阅《天机》', textId: 'working.13' }, zhT)
check('zh: prefix replaced, harness clock preserved', zh.textNode.nodeValue, '正在翻阅《天机》，用时1分14秒 ···')
check('zh: shimmer copy carries the same sentence', zh.decoText.getAttribute('data-shimmer-text'), '正在翻阅《天机》，用时1分14秒 ···')

// 2 · en running label keeps its own connector (" for ").
const en = mount('Deep diving', 'Deep diving for 1m 14s ···')
api.paintTurnStatus({ phase: 'working', text: 'Consulting the oracle...', textId: 'working.13' }, enT)
check('en: prefix replaced, harness clock preserved', en.textNode.nodeValue, 'Consulting the oracle... for 1m 14s ···')
check('en: shimmer copy carries the same sentence', en.decoText.getAttribute('data-shimmer-text'), 'Consulting the oracle... for 1m 14s ···')

// 3 · the a11y announcement is read-only for this plugin.
check('a11y announcement untouched', zh.status.textContent, '深度求索中')

// 4 · the whale animation icon and the divider are never touched.
check('whale icon subtree untouched', zh.animated.attrs && Object.keys(zh.animated.attrs).length === 0, true)
check('whale icon still aria-hidden', zh.icon.getAttribute('aria-hidden'), 'true')
check('divider untouched', zh.divider.childNodes.length, 0)

// 5 · settled turns (no [data-chat-running]) are left alone — 0.2.0 regression guard.
const ended = mountSettledTurn('已完成', '已完成，用时 2分5秒')
api.paintTurnStatus({ phase: 'working', text: '假装很忙', textId: 'working.7' }, zhT)
check('settled turn label left official', ended.textNode.nodeValue, '已完成，用时 2分5秒')

// 6 · no-duration form (turn.start absent) → prefix only.
const bare = mount('深度求索中', '深度求索中')
api.paintTurnStatus({ phase: 'working', text: '假装很忙', textId: 'working.7' }, zhT)
check('no-duration form → prefix only', bare.textNode.nodeValue, '假装很忙')
check('no-duration form → shimmer copy is the prefix only', bare.decoText.getAttribute('data-shimmer-text'), '假装很忙')

// 7 · phase change while our text is still in place (React has not rewritten yet).
api.paintTurnStatus({ phase: 'compressing', text: '[强制压缩中>>>]', textId: 'compressing' }, zhT)
check('phase change repaints in place', zh.textNode.nodeValue, '[压缩中]，用时1分14秒 ···')
check('phase change repaints the shimmer copy too', zh.decoText.getAttribute('data-shimmer-text'), '[压缩中]，用时1分14秒 ···')

// 8 · per-second React rewrite → the observer re-applies with the FRESH clock, both copies.
// `ensureLabelObserver` is lazy and a clear() disconnects it, so always take the newest instance.
const observerNow = () => observers[observers.length - 1]
check('observer watches the shimmer attribute', JSON.stringify(observerNow().options.attributeFilter), '["data-shimmer-text"]')
zh.textNode.nodeValue = '深度求索中，用时1分15秒 ···'          // React writes the official text again
zh.decoText.setAttribute('data-shimmer-text', '深度求索中，用时1分15秒 ···')
observerNow().callback([
  { type: 'characterData', target: zh.textNode, addedNodes: [] },
  { type: 'attributes', target: zh.decoText, addedNodes: [] },
])
check('observer re-applies after a React rewrite', zh.textNode.nodeValue, '[压缩中]，用时1分15秒 ···')
check('observer re-applies to the shimmer copy', zh.decoText.getAttribute('data-shimmer-text'), '[压缩中]，用时1分15秒 ···')

// 9 · our own writes must not self-excite (same value → no further change).
zh.textNode.nodeValue = '[压缩中]，用时1分15秒 ···'
zh.decoText.setAttribute('data-shimmer-text', '[压缩中]，用时1分15秒 ···')
observerNow().callback([
  { type: 'characterData', target: zh.textNode, addedNodes: [] },
  { type: 'attributes', target: zh.decoText, addedNodes: [] },
])
check('own write is idempotent (no self-excitation)', zh.textNode.nodeValue, '[压缩中]，用时1分15秒 ···')

// 10 · unrelated transcript churn must not trigger a repaint.
const outsider = new El('SPAN'); outsider.setText('streamed answer text')
check('unrelated characterData is filtered out', (() => {
  const before = zh.textNode.nodeValue
  observerNow().callback([{ type: 'characterData', target: outsider.childNodes[0], addedNodes: [] }])
  return zh.textNode.nodeValue === before
})(), true)

// 11 · clear (textId 'end') → official text restored in BOTH copies, observer disconnected.
const cleared = observerNow()
api.paintTurnStatus({ phase: 'end', text: '', textId: 'end' }, zhT)
check('clear restores the official text', zh.textNode.nodeValue, '深度求索中，用时1分15秒 ···')
check('clear restores the shimmer copy', zh.decoText.getAttribute('data-shimmer-text'), '深度求索中，用时1分15秒 ···')
check('clear disconnects the observer', cleared.connected, false)

// 12 · fallback: no dictionary entry / no t → the host's canonical text.
const noT = mount('深度求索中', '深度求索中，用时3秒 ···')
api.paintTurnStatus({ phase: 'working', text: '正在酝酿骚操作', textId: 'working.99' }, undefined)
check('unknown textId falls back to the canonical text', noT.textNode.nodeValue, '正在酝酿骚操作，用时3秒 ···')

// 13 · two open sessions are painted independently.
const second = mount('深度求索中', '深度求索中，用时5秒 ···')
api.paintTurnStatus({ phase: 'working', text: '正在驯服混沌', textId: 'working.11' }, zhT)
check('all open sessions painted', `${noT.textNode.nodeValue} | ${second.textNode.nodeValue}`,
  '正在驯服混沌，用时3秒 ··· | 正在驯服混沌，用时5秒 ···')

// 14 · a container that appears only after the push (fresh turn) is picked up by childList records.
const late = mount('深度求索中', '深度求索中，用时7秒 ···')
observerNow().callback([{ type: 'childList', target: documentStub.body, addedNodes: [late.root] }])
check('container mounted after the push is painted', late.textNode.nodeValue, '正在驯服混沌，用时7秒 ···')

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
if (failures.length !== 0) { for (const f of failures) console.log(`  ${f}`); process.exit(1) }
