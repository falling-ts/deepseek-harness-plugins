/**
 * wd-ding-trigger-probe.mjs — split the web-ding failure surface in a REAL browser.
 *
 * It answers, without needing a model turn:
 *   A. does the web-ding client half materialize (no module-table error)?
 *   B. does a Host-side `settings/update` of the `signal` field reach the page and
 *      make the client schedule the turn-end ding (oscillators + toast + cache),
 *      carrying the session title the host put in that signal?
 *   C. does a newly inserted `[data-question-key]` node make the client schedule
 *      the question ding?
 *
 * Oscillator scheduling is observed by patching AudioContext BEFORE page load,
 * so "no sound" is separated from "never asked to play".
 *
 * Usage: node exploration/wd-ding-trigger-probe.mjs [port]   (default 3080)
 */
import { createRequire } from 'node:module'
const require = createRequire('D:/AI/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const consoleLogs = []
const pageErrors = []
page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)))

// Patch AudioContext before any page script runs.
await page.addInitScript(() => {
  window.__wdDing = { osc: 0, ctxCreated: 0, resume: 0, patched: false }
  const patch = (Ctor) => {
    if (typeof Ctor !== 'function') return Ctor
    window.__wdDing.patched = true
    return class extends Ctor {
      constructor(...a) { super(...a); window.__wdDing.ctxCreated += 1 }
      createOscillator() { window.__wdDing.osc += 1; return super.createOscillator() }
      resume() { window.__wdDing.resume += 1; return super.resume() }
    }
  }
  const orig = window.AudioContext
  window.AudioContext = patch(orig)
  if (window.webkitAudioContext) window.webkitAudioContext = patch(window.webkitAudioContext)
})

console.log(`== open ${BASE}/ ==`)
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(9000)

const initial = await page.evaluate(() => ({
  ding: JSON.parse(JSON.stringify(window.__wdDing ?? {})),
  questionKeys: document.querySelectorAll('[data-question-key]').length,
  bodyHead: (document.body?.innerText || '').slice(0, 200),
}))
console.log('initial:', JSON.stringify(initial))
if (/Failed to load plugins|missed the module table/i.test(initial.bodyHead)) {
  console.log('!! ERROR BANNER PRESENT')
}

// ── B. host write → browser ding ───────────────────────────────────────────
// +1s only: a future-dated `at` would poison the real GUI window's lastAt baseline
// for as long as the skew lasts, silencing genuine dings there.
const at = Date.now() + 1000
// The title rides the signal (the host reads the sessionProjections 'title' unit);
// the client half must render it WITHOUT any RPC of its own.
const TITLE = '探针会话'
console.log(`== host settings/update signal at=${at} title=${TITLE} ==`)
const write = await page.evaluate(async ({ atValue, title }) => {
  const res = await fetch(location.origin + '/api/settings/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: 'settings/update',
      payload: { args: { ns: 'falling-ts-web-ding', patch: { signal: { phase: 'done', at: atValue, sessionId: 'ding-probe', title } } } },
    }),
  })
  return { status: res.status, ok: (await res.json())?.result?.ok }
}, { atValue: at, title: TITLE })
console.log('write:', JSON.stringify(write))

let turnEndSeen = null
for (let i = 0; i < 20; i++) {
  await sleep(500)
  turnEndSeen = await page.evaluate(() => {
    const ding = JSON.parse(JSON.stringify(window.__wdDing ?? {}))
    let notify = null
    try { notify = JSON.parse(localStorage.getItem('falling-ts-web-ding.notify.v1')) } catch {}
    const fixed = Array.from(document.querySelectorAll('div'))
      .filter((el) => getComputedStyle(el).position === 'fixed' && el.textContent && el.textContent.trim())
      .map((el) => el.textContent.slice(0, 60))
    return {
      ding,
      notifyAt: Array.isArray(notify) ? notify.slice(0, 2).map((m) => m.at) : null,
      notifyTitle: Array.isArray(notify) ? notify[0]?.title : null,
      fixed,
    }
  })
  if (turnEndSeen.ding.osc > 0) break
}
console.log('after host write:', JSON.stringify(turnEndSeen))

// ── C. question anchor → question ding ─────────────────────────────────────
const beforeQ = await page.evaluate(() => window.__wdDing.osc)
console.log('== insert [data-question-key] node ==')
await page.evaluate(() => {
  const d = document.createElement('div')
  d.setAttribute('data-question-key', 'probe-key-' + Date.now())
  d.textContent = 'probe question'
  document.body.appendChild(d)
})
let questionSeen = null
for (let i = 0; i < 10; i++) {
  await sleep(400)
  questionSeen = await page.evaluate(() => JSON.parse(JSON.stringify(window.__wdDing ?? {})))
  if (questionSeen.osc > 0) break
}
console.log(`question ding: osc before=${beforeQ} after=${questionSeen.osc} (delta=${questionSeen.osc - beforeQ})`)

// ── console / errors ───────────────────────────────────────────────────────
const errs = consoleLogs.filter((l) => /error|fail|missed|exception|warn/i.test(l))
console.log(`--- console error/warn (${errs.length}) ---`)
errs.slice(0, 20).forEach((l) => console.log('   ' + l.slice(0, 300)))
console.log(`--- pageerrors (${pageErrors.length}) ---`)
pageErrors.slice(0, 10).forEach((l) => console.log('   ' + l.slice(0, 400)))

// ── verdict ────────────────────────────────────────────────────────────────
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`)
  else { failures.push(name); console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}
check('plugin client half materialized', !/Failed to load plugins|missed the module table/i.test(initial.bodyHead), initial.bodyHead.slice(0, 120))
check('host signal write accepted', write.ok === true, JSON.stringify(write))
check('turn-end ding scheduled oscillators', (turnEndSeen?.ding?.osc ?? 0) > 0, JSON.stringify(turnEndSeen?.ding))
check('turn-end record cached', Array.isArray(turnEndSeen?.notifyAt) && turnEndSeen.notifyAt.length > 0, JSON.stringify(turnEndSeen?.notifyAt))
check('the signal title reached the cached record', turnEndSeen?.notifyTitle === TITLE, `${JSON.stringify(turnEndSeen?.notifyTitle)} != ${TITLE}`)
check('turn-end toast rendered', (turnEndSeen?.fixed?.length ?? 0) > 0, JSON.stringify(turnEndSeen?.fixed))
check('question ding scheduled oscillators', (questionSeen?.osc ?? 0) - beforeQ > 0, `${beforeQ} -> ${questionSeen?.osc}`)
check('no page error', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

await browser.close()
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\nFAILURES PRESENT — ${failures.join(', ')}`)
console.log('== done ==')
if (failures.length > 0) process.exit(1)
