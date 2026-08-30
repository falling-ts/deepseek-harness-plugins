/**
 * wd-browser-probe.mjs — REAL browser verification of the web-ding client half
 * on the live 3080 instance.
 *
 * What it answers concretely:
 *   1. does the web-ding client module materialize without errors in a real
 *      browser (no "missed the module table" / "Failed to load plugins")?
 *   2. after a real agent turn (driven over the wire), does the turn-end
 *      signal reach the browser and does the toast + notify cache appear?
 *
 * Run:  node exploration/wd-browser-probe.mjs [port]
 */
import { createRequire } from 'node:module'
const require = createRequire('D:/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function dshRpc(method, args) {
  // method is the SLASH endpoint form ('session/create'), matching both the
  // URL path and the envelope `method` field verbatim (current gateway).
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      method,
      payload: { args },
    }),
  })
  const json = await res.json()
  if (!json || !json.result || json.result.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(json)}`)
  }
  return json.result.value
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const consoleLogs = []
  const pageErrors = []
  page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  console.log(`== open ${BASE}/ ==`)
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(10000) // let client-modules assemble

  // initial state
  const initial = await page.evaluate(() => {
    let notify = null
    try { notify = JSON.parse(localStorage.getItem('falling-ts-web-ding.notify.v1')) } catch {}
    return {
      title: document.title,
      notifyCount: Array.isArray(notify) ? notify.length : -1,
      bodyHasQuestionKey: document.querySelectorAll('[data-question-key]').length,
    }
  })
  console.log('initial:', JSON.stringify(initial))
  const errText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : '')
  if (/Failed to load plugins|missed the module table/i.test(errText)) {
    console.log('!! ERROR BANNER PRESENT IN BODY')
  }

  // arm a MutationObserver BEFORE the turn so we never miss the toast (it
  // auto-dismisses after ~6s — a late probe would find nothing)
  await page.evaluate(() => {
    window.__dshToastSnapshots = []
    const snap = (node) => {
      const s = window.getComputedStyle(node)
      return {
        at: Date.now(),
        text: (node.textContent || '').slice(0, 120),
        pos: s.position,
        bg: s.backgroundColor,
        z: s.zIndex,
      }
    }
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (n.__dshSeen) continue
            n.__dshSeen = true
            const s = window.getComputedStyle(n)
            if (s.position === 'fixed' && (n.textContent || '').trim().length > 0) {
              window.__dshToastSnapshots.push(snap(n))
            }
          }
        }
      }
    })
    mo.observe(document.body, { childList: true, subtree: true })
    window.__dshToastObserver = mo
  })

  // drive one real turn
  console.log('== drive one agent turn over the wire ==')
  const { sessionId } = await dshRpc('session/create', { request: {} })
  console.log('session:', sessionId)
  await dshRpc('session/prompt', {
    request: {
      requestId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Say exactly: ping' }],
    },
  })
  let idle = false
  for (let i = 0; i < 40 && !idle; i++) {
    await sleep(5000)
    const list = await dshRpc('session/list', { _request: {} })
    const me = list.items.find((it) => it.sessionId === sessionId)
    if (me && !me.running && !me.blank) idle = true
  }
  console.log('turn idle:', idle)
  // poll the DOM for the live toast (do NOT wait past its 6s auto-dismiss)
  let liveToast = null
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    liveToast = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('div'))
      for (const el of all) {
        const s = window.getComputedStyle(el)
        if (s.position === 'fixed' && el.textContent && el.textContent.trim()) {
          if (/回合结束|Turn|Say Exactly|ding|Ding/i.test(el.textContent) ||
              el.getBoundingClientRect().top > window.innerHeight - 160) {
            return { text: el.textContent.slice(0, 160), style: `${s.position} / ${s.backgroundColor}` }
          }
        }
      }
      return null
    })
    if (liveToast) break
  }
  // post-turn state
  const after = await page.evaluate(() => {
    let notify = null
    try { notify = JSON.parse(localStorage.getItem('falling-ts-web-ding.notify.v1')) } catch {}
    return { notify }
  })
  console.log('after-turn notify:', JSON.stringify(after.notify))
  console.log('live toast observed:', JSON.stringify(liveToast))
  console.log('all fixed-added DOM snapshots:', JSON.stringify(await page.evaluate(() => window.__dshToastSnapshots)))

  // errors
  const errors = consoleLogs.filter((l) => /error|fail|missed|exception/i.test(l))
  console.log('--- console errors (' + errors.length + ') ---')
  errors.slice(0, 15).forEach((l) => console.log('   ' + l))
  console.log('--- pageerrors (' + pageErrors.length + ') ---')
  pageErrors.slice(0, 10).forEach((l) => console.log('   ' + l.slice(0, 300)))

  await browser.close()
  console.log('== done ==')
}

main().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1) })