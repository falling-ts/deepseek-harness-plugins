/**
 * web-020-headless-probe.mjs — headless browser smoke for a running `dsh web`.
 *
 * Opens the loopback instance, waits for the client to boot, and reports every
 * signal that would tell us 0.2.0 broke something:
 *
 *   - HTTP status of `/` and of each plugin client bundle fetch
 *   - `console.error` / `console.warn` lines and uncaught `pageerror`s
 *   - failed / aborted network requests (the classic broken-link signature)
 *   - whether the app root actually rendered (a blank root = a client crash)
 *   - presence of the two plugin settings sections (`falling-ts-web-ding`,
 *     `falling-ts-force-compact`) by asking the live client for its config
 *     form namespaces through the RPC describe surface
 *   - screenshots (light + the dark-theme attribute) for eyeballing
 *
 * Usage: node exploration/web-020-headless-probe.mjs [port]   (default 3080)
 */
import { createRequire } from 'node:module'
const require = createRequire('D:/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
// `dsh web` gates every route behind an auth token that is regenerated on each
// start; pass it in via DSH_TOKEN (grep it out of the server log) or the probe
// only ever sees 401s. An empty token keeps the old bare-URL behaviour.
const TOKEN = (process.env.DSH_TOKEN ?? '').trim()
const BASE = `http://127.0.0.1:${PORT}`
const APP = TOKEN === '' ? `${BASE}/` : `${BASE}/?token=${encodeURIComponent(TOKEN)}`
const OUT = 'D:/deepseek-harness-plugins/exploration'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const consoleErrors = []
const consoleWarns = []
const pageErrors = []
const failedRequests = []
const pluginBundles = []

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('console', (msg) => {
  const text = msg.text()
  if (msg.type() === 'error') consoleErrors.push(text)
  else if (msg.type() === 'warning') consoleWarns.push(text)
})
page.on('pageerror', (error) => pageErrors.push(String(error && error.stack ? error.stack : error)))
page.on('requestfailed', (request) => {
  failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? '?'}`)
})
page.on('response', (response) => {
  const url = response.url()
  if (url.includes('/plugins/') && url.endsWith('.js')) {
    pluginBundles.push(`${response.status()} ${url.replace(BASE, '')}`)
  }
  if (response.status() >= 400) failedRequests.push(`HTTP ${response.status()} ${url}`)
})

const report = {}
const nav = await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
report.indexStatus = nav?.status()
report.title = await page.title()

// Give the client bundle time to boot, mount, and open its RPC connection.
await sleep(15000)

report.rootRendered = await page.evaluate(() => {
  const root = document.getElementById('root')
  return root === null ? 'NO #root' : String(root.childElementCount)
})
report.bodyTextLength = await page.evaluate(() => (document.body.innerText || '').length)
report.darkThemeAttr = await page.evaluate(() => document.body.getAttribute('data-ds-dark-theme'))

// Ask the live server which settings namespaces exist — proof the plugin
// Config exports survived the loader, and that the client can reach them.
try {
  const describe = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/settings/describe`, { method: 'GET' })
    return { status: res.status, body: (await res.text()).slice(0, 600) }
  }, BASE)
  report.settingsDescribe = describe
} catch (error) {
  report.settingsDescribe = { error: String(error) }
}

await page.screenshot({ path: `${OUT}/web-020-probe-light.png`, fullPage: false })
await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
await sleep(1200)
await page.screenshot({ path: `${OUT}/web-020-probe-dark.png`, fullPage: false })

await browser.close()

const line = (label, value) => console.log(`${label.padEnd(22)} ${value}`)
console.log('— web 0.2.0 headless probe —')
line('base', BASE)
line('index HTTP', String(report.indexStatus))
line('title', report.title)
line('#root children', report.rootRendered)
line('body text length', String(report.bodyTextLength))
line('dark attr', String(report.darkThemeAttr))
console.log('')
console.log(`plugin client bundles (${pluginBundles.length}):`)
for (const b of pluginBundles) console.log(`  ${b}`)
console.log('')
console.log(`console.error (${consoleErrors.length}):`)
for (const e of consoleErrors.slice(0, 25)) console.log(`  ${e.slice(0, 400)}`)
console.log(`console.warn (${consoleWarns.length}):`)
for (const w of consoleWarns.slice(0, 15)) console.log(`  ${w.slice(0, 300)}`)
console.log(`pageerror (${pageErrors.length}):`)
for (const p of pageErrors.slice(0, 15)) console.log(`  ${p.slice(0, 600)}`)
console.log(`failed requests (${failedRequests.length}):`)
for (const f of failedRequests.slice(0, 25)) console.log(`  ${f.slice(0, 300)}`)
console.log('')
console.log('settings describe:', JSON.stringify(report.settingsDescribe).slice(0, 800))
console.log(`screenshots: ${OUT}/web-020-probe-light.png, ${OUT}/web-020-probe-dark.png`)
