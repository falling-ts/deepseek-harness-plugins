/**
 * dou-browser-probe.mjs — REAL browser diagnosis of why the
 * @wingsky-1/dsh-opencode-usage floating pill is not visible in the top-right
 * corner of the 3080 GUI.
 *
 * Answers concretely:
 *   1. did the client module mount at all (`.dou-float` present, style tag injected)?
 *   2. where is the pill actually positioned, and is it inside the viewport?
 *   3. what is its containing block / is it covered by another element?
 *   4. does the harness own a competing top-right element (official StatsPills)?
 *
 * Run: node exploration/dou-browser-probe.mjs [port]
 */
import { createRequire } from 'node:module'
const require = createRequire('D:/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const consoleLogs = []
const pageErrors = []
page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => pageErrors.push(String(e)))

console.log(`== open ${BASE}/ ==`)
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(12000)

const report = await page.evaluate(() => {
  const out = {}
  const rect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })

  out.douStyleTagInjected = document.querySelector('style[data-dou-style]') !== null
  out.bodyChildren = document.body.children.length
  out.bootModuleMentionsDou = /dsh-opencode-usage/.test(document.documentElement.innerHTML)

  // the harness conversation scrollport the plugin looks for
  const hostEl = document.querySelector('[data-conversation-scroll]')
  out.conversationHost = hostEl === null ? null : (() => {
    const s = getComputedStyle(hostEl)
    return {
      tag: hostEl.tagName,
      cls: String(hostEl.className).slice(0, 90),
      position: s.position,
      overflow: s.overflow,
      hasDouAttribute: hostEl.hasAttribute('dou-conversation'),
      rect: rect(hostEl.getBoundingClientRect()),
    }
  })()
  out.hasDouConversationAttrAnywhere = document.querySelectorAll('[dou-conversation]').length
  out.hasDataPaneConversation = document.querySelectorAll('[data-pane="conversation"]').length

  // the plugin pill itself
  const pill = document.querySelector('.dou-float')
  if (pill === null) {
    out.douFloat = null
  } else {
    const s = getComputedStyle(pill)
    const r = pill.getBoundingClientRect()
    const cx = Math.round(r.left + r.width / 2)
    const cy = Math.round(r.top + r.height / 2)
    let top = null
    if (cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) {
      const t = document.elementFromPoint(cx, cy)
      top = t === null ? null : {
        tag: t.tagName,
        cls: String(t.className).slice(0, 80),
        isThePill: t === pill || pill.contains(t),
      }
    }
    out.douFloat = {
      text: pill.textContent,
      title: pill.title,
      style: {
        position: s.position, top: s.top, right: s.right, left: s.left,
        zIndex: s.zIndex, display: s.display, visibility: s.visibility, opacity: s.opacity,
      },
      rect: rect(r),
      inViewport: r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0,
      parent: pill.parentElement === null ? null : {
        tag: pill.parentElement.tagName,
        cls: String(pill.parentElement.className).slice(0, 90),
        position: getComputedStyle(pill.parentElement).position,
      },
      topElementAtCenter: top,
    }
  }
  const panel = document.querySelector('.dou-panel')
  out.douPanel = panel === null ? null : { hidden: panel.hidden, rect: rect(panel.getBoundingClientRect()) }

  // anything else competing for the top-right corner
  const contenders = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.top > 90 || r.right < innerWidth - 360) continue
    const s = getComputedStyle(el)
    if (s.position === 'absolute' || s.position === 'fixed' || s.position === 'relative') {
      contenders.push({
        tag: el.tagName,
        cls: String(el.className).slice(0, 70),
        pos: s.position,
        z: s.zIndex,
        rect: rect(r),
        text: (el.textContent || '').trim().slice(0, 40),
      })
    }
  }
  out.topRightContenders = contenders.slice(0, 30)
  return out
})

console.log(JSON.stringify(report, null, 2))

await page.screenshot({ path: 'D:/deepseek-harness-plugins/exploration/dou-shot-full.png' })
await page.screenshot({
  path: 'D:/deepseek-harness-plugins/exploration/dou-shot-topright.png',
  clip: { x: 900, y: 0, width: 500, height: 220 },
})

const errs = consoleLogs.filter((l) => /error|fail|warn|exception|dou/i.test(l))
console.log(`--- console (errors/warnings/dou) : ${errs.length} ---`)
errs.slice(0, 20).forEach((l) => console.log('   ' + l.slice(0, 240)))
console.log(`--- pageerrors : ${pageErrors.length} ---`)
pageErrors.slice(0, 10).forEach((l) => console.log('   ' + l.slice(0, 300)))

await browser.close()
console.log('== done ==')
