/**
 * web-020-plugin-sections-probe.mjs — open each workspace plugin's settings
 * section and dump what rendered. This is the real 0.2.0 regression check for
 * the client halves: `ctx.configForms.get(ns)` (values + write path),
 * `ctx.slots.inject('settings.section')` (mount), and `ctx.locale.bind`
 * (labels) all have to work for the section to show anything at all.
 *
 * Usage: node exploration/web-020-plugin-sections-probe.mjs [port]  (default 3080)
 */
import { createRequire } from 'node:module'
const require = createRequire('D:/AI/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'D:/AI/deepseek-harness-plugins/exploration'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SECTIONS = [
  { label: '强制压缩', shot: `${OUT}/web-020-section-force-compact.png` },
  { label: '提示音配置', shot: `${OUT}/web-020-section-web-ding.png` },
]

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
await sleep(1200)
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
    .find((n) => n.children.length === 0 && (n.textContent || '').trim() === '设置')
  if (el) el.click()
})
await sleep(4000)

const results = []
for (const section of SECTIONS) {
  const clicked = await page.evaluate((label) => {
    const el = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
      .find((n) => n.children.length === 0 && (n.textContent || '').trim() === label)
    if (el) { el.click(); return true }
    return false
  }, section.label)
  await sleep(4000)
  await page.screenshot({ path: section.shot })
  const text = await page.evaluate(() => {
    // The section panel is the wide content column; take its text if we can find it.
    const dialog = document.querySelector('[role="dialog"]') ?? document.body
    return (dialog.innerText || '').slice(0, 2200)
  })
  results.push({ label: section.label, clicked, text })
}

await browser.close()

for (const r of results) {
  console.log(`— ${r.label} — (clicked: ${r.clicked})`)
  console.log(r.text.slice(0, 1800))
  console.log('')
}
console.log(`console.error (${consoleErrors.length}):`)
for (const e of consoleErrors.slice(0, 20)) console.log(`  ${e.slice(0, 300)}`)
console.log(`pageerror (${pageErrors.length}):`)
for (const p of pageErrors.slice(0, 10)) console.log(`  ${p.slice(0, 500)}`)
console.log(`shots: ${SECTIONS.map((s) => s.shot).join(', ')}`)
