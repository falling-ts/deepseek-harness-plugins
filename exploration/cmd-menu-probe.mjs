/**
 * cmd-menu-probe.mjs — dump the live `/` command menu of a running `dsh web`
 * (or the desktop app's loopback server) so the *rendered* row face of every
 * registered command can be compared row by row: label, description, icon
 * presence, group/section heading.
 *
 * Usage: node exploration/cmd-menu-probe.mjs [port] [query]
 *   port   default 3080
 *   query  extra text typed after the slash (e.g. "compact"); default "" (empty
 *          query lists the sectioned menu).
 *
 * Artifacts: exploration/cmd-menu-<port>.png and exploration/cmd-menu-<port>.html
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const require = createRequire('D:/AI/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const QUERY = process.argv[3] ?? ''
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'D:/AI/deepseek-harness-plugins/exploration'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const consoleErrors = []
const pageErrors = []
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)))

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(9000)

await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === '继续')
  if (btn) btn.click()
})
await sleep(1500)

// Locate the composer: prefer a textarea, fall back to a contenteditable host.
const composer = await page.evaluate(() => {
  const ta = document.querySelector('textarea')
  if (ta) {
    ta.setAttribute('data-probe-composer', '1')
    return { kind: 'textarea', placeholder: ta.placeholder || '' }
  }
  const ce = document.querySelector('[contenteditable="true"]')
  if (ce) {
    ce.setAttribute('data-probe-composer', '1')
    return { kind: 'contenteditable', placeholder: ce.getAttribute('data-placeholder') || '' }
  }
  return null
})

let rows = []
let raw = ''
if (composer !== null) {
  await page.click('[data-probe-composer]')
  await page.type('[data-probe-composer]', `/${QUERY}`, { delay: 60 })
  await sleep(2500)
  const dump = await page.evaluate(() => {
    const pick = (el) => {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
      const iconCount = el.querySelectorAll('svg, img, [class*="icon" i]').length
      const aria = el.getAttribute('aria-label') || ''
      return { text, iconCount, aria }
    }
    const optionish = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] > *, li'))
      .map(pick)
      .filter((r) => r.text !== '')
    return {
      optionish,
      html: document.body.innerHTML.length > 400000 ? '' : document.body.innerHTML,
    }
  })
  rows = dump.optionish
  raw = dump.html
}

await page.screenshot({ path: `${OUT}/cmd-menu-${PORT}.png` })
if (raw !== '') writeFileSync(`${OUT}/cmd-menu-${PORT}.html`, raw, 'utf8')
await browser.close()

console.log(`— command menu probe (port ${PORT}, query "/${QUERY}") —`)
console.log('composer:', JSON.stringify(composer))
console.log(`rows (${rows.length}):`)
for (const r of rows) {
  console.log(`  icons=${String(r.iconCount).padEnd(2)} aria="${r.aria}" | ${r.text.slice(0, 160)}`)
}
console.log(`console.error (${consoleErrors.length}):`)
for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e.slice(0, 300)}`)
console.log(`pageerror (${pageErrors.length}):`)
for (const p of pageErrors.slice(0, 5)) console.log(`  ${p.slice(0, 400)}`)
console.log(`screenshot: ${OUT}/cmd-menu-${PORT}.png`)
