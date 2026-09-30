// End-to-end probe for the force-compact LiveUI prefix replacer against a LIVE
// `dsh web` instance (default port 3080).
//
// Why it does not call a model
// ----------------------------
// The painter keys on three upstream-stable anchors — `[data-chat-running]`,
// `[data-shimmer]` and `[data-shimmer-text]` — and reacts to the host's `liveUi`
// settings field. Both halves can be exercised for real, with no credentials and
// no model spend:
//
//   • the DOM: the run renders the SAME structure RunningStatus/TextShimmer
//     produce (asserted below against the served frontend bundle), built here with
//     the served stylesheet's own hashed class names so the whale APNG and the
//     shimmer sweep actually render;
//   • the trigger: `settings/update` on the live host, which travels the real
//     document-updated broadcast → the client's configForms mirror → the plugin's
//     `derive()` → `paintTurnStatus`.
//
// It asserts the four invariants the plugin promises: the leading phrase is
// replaced, the harness clock tail survives, the shimmer's CSS `::after` copy is
// kept in sync (otherwise the sweep would reveal the official text), and the
// whale icon / divider / role=status announcement are never touched. It then
// replays React's per-second rewrite to prove the MutationObserver re-applies,
// and the idle clear to prove the official text comes back.
//
// Usage: node exploration/fc-livetext-e2e-probe.mjs [port]
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../deepseek-harness/apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const NS = 'falling-ts-force-compact'
const SHOT = fileURLToPath(new URL('./fc-livetext-e2e.png', import.meta.url))
const SHOT_BEFORE = fileURLToPath(new URL('./fc-livetext-e2e-before.png', import.meta.url))

let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`); console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}

/** One unary RPC on the live host (slash form, `{args}` envelope). */
async function rpc(ns, method, args) {
  const response = await fetch(`${BASE}/api/${ns}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: `${ns}/${method}`, payload: { args } }),
  })
  const body = await response.json()
  if (body?.result?.ok !== true) throw new Error(`${ns}/${method} failed: ${JSON.stringify(body).slice(0, 300)}`)
  return body.result.value
}

// ── A. boot the real client, collecting what it actually loads ───────────────
// The running-status markup and its stylesheet live in the ui-chat CLIENT bundle,
// which the module system fetches at runtime — not in the first-screen HTML
// assets — so the anchors are checked against the runtime module table.
console.log('=== A. the served client carries the anchors ===\n')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const consoleErrors = []
const pageErrors = []
const bodies = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('response', (response) => {
  const url = response.url()
  // The module system fetches every client package as ONE comma-joined URL
  // (`plugins/??a/client.js,b/client.js,...`), so match the name, not an extension.
  // ui-chat owns the running row; the shell assets carry the statically-seeded
  // platform modules (ui-primitives owns TextShimmer and its attribute).
  if (!url.includes('dsh-client-ui-chat') && !/\/assets\/[^/]*\.js(?:\?|$)/.test(url)) return
  bodies.push(Promise.race([
    response.text().then(text => ({ url, text })),
    new Promise((resolve) => setTimeout(() => resolve(null), 30000)),
  ]).catch(() => null))
})

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(12000)
check('app root rendered', await page.evaluate(() => (document.getElementById('root')?.childElementCount ?? 0) > 0))

const fetched = (await Promise.all(bodies)).filter(entry => entry !== null)
const uiChat = fetched.find(entry => entry.url.includes('dsh-client-ui-chat'))
check('the ui-chat client bundle was fetched at runtime', uiChat !== undefined,
  fetched.map(e => e.url.replace(BASE, '').slice(0, 60)).slice(0, 4).join(' | '))
const uiChatText = uiChat === undefined ? '' : uiChat.text
const allLoadedText = fetched.map(entry => entry.text).join('\n')

check('ui-chat bundle emits data-chat-running', uiChatText.includes('data-chat-running'))
check('ui-chat bundle styles the whale animation', uiChatText.includes('runningWhaleAnimated'))
// TextShimmer (and therefore the `data-shimmer-text` attribute the CSS ::after
// reads) is owned by the statically-seeded ui-primitives platform module.
check('the served client carries data-shimmer-text (ui-primitives)', allLoadedText.includes('data-shimmer-text'))

/** The hashed CSS-module class names the live page actually applied. */
const CLASS = await page.evaluate(() => {
  const found = {}
  const claim = (key, needles) => {
    if (found[key] !== undefined) return
    for (const rule of document.styleSheets) {
      let rules
      try { rules = rule.cssRules } catch { continue }        // cross-origin sheet
      for (const entry of rules) {
        const selector = entry.selectorText ?? ''
        for (const match of selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
          const local = match[1]
          if (needles.some(needle => local.includes(needle))) { found[key] = local; return }
        }
      }
    }
  }
  claim('root', ['running'])
  claim('whaleAnimated', ['runningWhaleAnimated'])
  claim('whaleStill', ['runningWhaleStill'])
  claim('divider', ['runningDivider'])
  claim('content', ['runningContent'])
  claim('text', ['runningText'])
  claim('icon', ['runningIcon'])
  claim('visuallyHidden', ['visuallyHidden'])
  return found
})
console.log(`  (hashed classes: ${JSON.stringify(CLASS)})\n`)

// ── B. inject a faithful running row, then drive the plugin's real chain ─────
console.log('=== B. live client: paint, sync, restore ===\n')

await page.evaluate((CLASS) => {
  const el = (tag, className) => { const node = document.createElement(tag); if (className) node.className = className; return node }
  const host = el('div')
  host.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#fff;padding:12px 16px;border:1px solid #ddd;border-radius:8px;font:14px/22px sans-serif'
  const root = el('div', CLASS.root)
  root.setAttribute('data-chat-running', '')
  const status = el('span', CLASS.visuallyHidden); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true')
  status.textContent = '深度求索中'
  const divider = el('span', CLASS.divider); divider.setAttribute('aria-hidden', 'true')
  const content = el('span', CLASS.content)
  const icon = el('span', CLASS.icon); icon.setAttribute('aria-hidden', 'true')
  icon.appendChild(el('span', CLASS.whaleAnimated))
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', CLASS.whaleStill); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none')
  svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742')
  path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1')
  svg.appendChild(path); icon.appendChild(svg)

  const OFFICIAL = '深度求索中，用时1分14秒 ···'
  const shimmer = el('span', CLASS.text)
  shimmer.setAttribute('data-shimmer', 'true')
  const inner = el('span', 'content')
  const textEl = el('span', 'text')
  textEl.textContent = OFFICIAL
  inner.appendChild(textEl)
  const decoration = el('span'); decoration.setAttribute('aria-hidden', 'true')
  const sweep = el('span'); const highlight = el('span'); const decoText = el('span')
  decoText.className = 'text'; decoText.setAttribute('data-shimmer-text', OFFICIAL)
  highlight.appendChild(decoText); sweep.appendChild(highlight); decoration.appendChild(sweep)
  shimmer.appendChild(inner); shimmer.appendChild(decoration)

  content.appendChild(icon); content.appendChild(shimmer)
  root.appendChild(status); root.appendChild(divider); root.appendChild(content)
  host.appendChild(root); document.body.appendChild(host)
}, CLASS)

/** Read back the four anchors from the injected row. */
const READ = () => {
  const root = document.querySelector('[data-chat-running]')
  const realEl = [...root.querySelectorAll('[data-shimmer] *')].find(el =>
    !el.hasAttribute('data-shimmer-text')
    && [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.length > 0))
  return {
    real: realEl === undefined ? null : realEl.textContent,
    copy: root.querySelector('[data-shimmer-text]')?.getAttribute('data-shimmer-text') ?? null,
    announcement: root.querySelector('[role="status"]')?.textContent ?? null,
    svgPaths: root.querySelectorAll('svg path').length,
    iconHidden: root.querySelector('[aria-hidden="true"] > span') !== null,
    dividerChildren: root.querySelectorAll('[aria-hidden="true"]')[0]?.childElementCount ?? -1,
  }
}

const before = await page.evaluate(READ)
check('injected row starts on the official text', before.real === '深度求索中，用时1分14秒 ···', String(before.real))
await page.screenshot({ path: SHOT_BEFORE, clip: { x: 0, y: 540, width: 900, height: 180 } })

// Host writes liveUi: real broadcast → mirror → derive → paintTurnStatus.
await rpc('settings', 'update', { ns: NS, patch: { liveUi: { phase: 'working', text: '正在驯服混沌', textId: 'working.11' } } })
await page.waitForTimeout(2500)
const painted = await page.evaluate(READ)
check('real text node carries the plugin phrase + official clock', painted.real === '正在驯服混沌，用时1分14秒 ···', String(painted.real))
check('shimmer ::after copy kept in sync', painted.copy === '正在驯服混沌，用时1分14秒 ···', String(painted.copy))
check('role=status announcement untouched', painted.announcement === '深度求索中', String(painted.announcement))
check('whale icon + SVG still present', painted.svgPaths === 1 && painted.iconHidden)
check('divider still childless', painted.dividerChildren === 0, String(painted.dividerChildren))

// Replay React's per-second rewrite: the observer must re-apply with the fresh clock.
const reApplied = await page.evaluate(() => new Promise((resolve) => {
  const root = document.querySelector('[data-chat-running]')
  const realEl = [...root.querySelectorAll('[data-shimmer] *')].find(el =>
    !el.hasAttribute('data-shimmer-text')
    && [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.length > 0))
  const deco = root.querySelector('[data-shimmer-text]')
  const NEXT = '深度求索中，用时1分15秒 ···'
  realEl.firstChild.nodeValue = NEXT
  deco.setAttribute('data-shimmer-text', NEXT)
  setTimeout(() => resolve({ real: realEl.textContent, copy: deco.getAttribute('data-shimmer-text') }), 400)
}))
check('observer re-applies after a React rewrite', reApplied.real === '正在驯服混沌，用时1分15秒 ···', String(reApplied.real))
check('observer re-applies to the shimmer copy', reApplied.copy === '正在驯服混沌，用时1分15秒 ···', String(reApplied.copy))

await page.screenshot({ path: SHOT, clip: { x: 0, y: 540, width: 900, height: 180 } })

// Conversation end (idle) clears: the official text comes back in both copies.
await rpc('settings', 'update', { ns: NS, patch: { liveUi: { phase: 'end', text: '', textId: 'end' } } })
await page.waitForTimeout(2000)
const restored = await page.evaluate(READ)
check('end clear restores the official text', restored.real === '深度求索中，用时1分15秒 ···', String(restored.real))
check('end clear restores the shimmer copy', restored.copy === '深度求索中，用时1分15秒 ···', String(restored.copy))

check('no console errors on the live client', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

await browser.close()
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
console.log(`screenshot: ${SHOT}`)
if (failures.length !== 0) { for (const f of failures) console.log(`  ${f}`); process.exit(1) }
