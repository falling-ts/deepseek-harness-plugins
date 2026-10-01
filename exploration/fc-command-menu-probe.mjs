/**
 * fc-command-menu-probe.mjs -- live proof that the `/force-compact` slash-menu
 * row renders with the official first-party row face: a glyph from the shared
 * icon set, the localized label, the raw command name, and the localized
 * description (see fc-command-face-probe.mjs for the offline half).
 *
 * The offline probe pins the wrapper; this one pins what the real client
 * actually paints, through the real module table, the real locale service and
 * the real MenuView. It reads the expected copy out of the plugin's own
 * dictionaries, so it passes in any active language without hardcoding zh.
 *
 * Usage: node exploration/fc-command-menu-probe.mjs [port]   (default 3080)
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire('D:/AI/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'D:/AI/deepseek-harness-plugins/exploration'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// The plugin's own dictionaries are the source of the expected row copy.
const SRC = readFileSync(new URL('../dsh-force-compact/web/client.js', import.meta.url), 'utf8')
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
const expectedFaces = ['zh', 'en', 'ja', 'ko'].map((l) => extractDict(SRC, l))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
const consoleErrors = []
const pageErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)))

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(9000)
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '继续')
  if (btn) btn.click()
})
await sleep(1500)

const composer = await page.evaluate(() => {
  const el = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]')
  if (el === null) return false
  el.setAttribute('data-probe-composer', '1')
  return true
})
check('composer found', composer === true)

let row = null
if (composer) {
  await page.click('[data-probe-composer]')
  await page.type('[data-probe-composer]', '/', { delay: 60 })
  await sleep(2500)
  row = await page.evaluate(() => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const hit = options.find((o) => (o.innerText || '').includes('force-compact'))
    if (hit === undefined) return null
    const spans = Array.from(hit.querySelectorAll('span'))
      .map((s) => (s.innerText || '').trim())
      .filter((t) => t !== '')
    return {
      text: (hit.innerText || '').replace(/\s+/g, ' ').trim(),
      spans,
      svg: hit.querySelectorAll('svg').length,
      // The section heading is the nearest preceding non-row text block.
      section: (() => {
        let node = hit
        while (node !== null && node.previousElementSibling !== null) {
          node = node.previousElementSibling
          const text = (node.innerText || '').trim()
          if (text !== '') return text
        }
        return ''
      })(),
    }
  })
}

check('the /force-compact row is in the menu', row !== null)
if (row !== null) {
  console.log(`       row: ${JSON.stringify(row)}`)
  check('row carries an icon glyph', row.svg >= 1, `svg=${row.svg}`)
  const face = expectedFaces.find((f) => row.text === `${f.cmdLabel} force-compact ${f.cmdDescription}`)
  check('row shows "<localized label> force-compact <localized description>"', face !== undefined, row.text)
  check('label and name are separate cells (official row layout)', row.spans.length >= 3, JSON.stringify(row.spans))
  check('the row keeps the host description out of the label cell',
    row.spans[0] !== 'force-compact', JSON.stringify(row.spans))
}

// The official rows must keep their own faces -- the wrapper only touches ours.
const official = await page.evaluate(() => {
  const options = Array.from(document.querySelectorAll('[role="option"]'))
  return ['compact', 'permission', 'export'].map((name) => {
    // innerText separates the row's cells with newlines, so match on the
    // normalized text and require the name as its own cell.
    const hit = options.find((o) => ` ${(o.innerText || '').replace(/\s+/g, ' ').trim()} `.includes(` ${name} `))
    return hit === undefined ? null : { name, svg: hit.querySelectorAll('svg').length, text: (hit.innerText || '').replace(/\s+/g, ' ').trim() }
  })
})
for (const entry of official) {
  check(`official /${entry === null ? '?' : entry.name} row still renders`, entry !== null)
  if (entry !== null) check(`official /${entry.name} row keeps its icon`, entry.svg >= 1, `svg=${entry.svg}`)
}

await page.screenshot({ path: `${OUT}/fc-command-menu-${PORT}.png` })
await browser.close()

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} -- ${passed} passed, ${failures.length} failed`)
console.log(`screenshot: ${OUT}/fc-command-menu-${PORT}.png`)
if (failures.length !== 0) process.exit(1)
