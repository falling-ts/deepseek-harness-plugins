/**
 * chat-output-view-probe.mjs — final demonstration for "where is the command output?"
 *
 *   1. open the session, scroll to a pwsh row, capture the COLLAPSED state
 *   2. click the row (data-disclosure-row) and capture the EXPANDED state,
 *      proving the output text actually appears
 *   3. click the "轨迹" (trajectory) tab and report what that view contains
 *
 * Run: node exploration/chat-output-view-probe.mjs [port]
 */
import { createRequire } from 'node:module'
const require = createRequire('D:/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = 'D:/deepseek-harness-plugins/exploration'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(14000)

await page.evaluate(() => {
  const title = Array.from(document.querySelectorAll('span, div'))
    .find((el) => el.children.length === 0 && (el.textContent || '').trim() === '熟悉项目代码结构')
  let el = title ?? null
  for (let i = 0; i < 6 && el !== null; i += 1) {
    if (el.getAttribute('role') === 'treeitem') { el.click(); return }
    el = el.parentElement
  }
})
await sleep(8000)

// --- collapsed: scroll to the LAST pwsh row and screenshot -------------------
const collapsed = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-disclosure-row="true"]'))
  const row = rows.at(-6) ?? rows.at(-1)
  if (row === undefined) return { rows: 0 }
  row.scrollIntoView({ block: 'center' })
  return {
    rows: rows.length,
    expandedCount: rows.filter((r) => r.getAttribute('aria-expanded') === 'true').length,
    rowText: (row.textContent || '').trim().slice(0, 90),
    containerTextLen: row.parentElement ? (row.parentElement.textContent || '').length : 0,
  }
})
console.log('=== 折叠态（滚动到某个 pwsh 行）===')
console.log(JSON.stringify(collapsed, null, 2))
await sleep(500)
await page.screenshot({ path: `${OUT}/out-1-collapsed.png` })

// --- expanded: click that row, prove output appears --------------------------
const expanded = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-disclosure-row="true"]'))
  const row = rows.at(-6) ?? rows.at(-1)
  if (row === undefined) return { ok: false }
  const holder = row.parentElement
  const before = (holder?.textContent ?? '').length
  row.click()
  return { ok: true, ariaExpanded: row.getAttribute('aria-expanded'), before }
})
await sleep(1500)
const after = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-disclosure-row="true"]'))
  const row = rows.at(-6) ?? rows.at(-1)
  if (row === undefined) return null
  const holder = row.parentElement
  const text = holder?.textContent ?? ''
  return {
    ariaExpanded: row.getAttribute('aria-expanded'),
    afterLen: text.length,
    newText: text.replace(/\s+/gu, ' ').slice(0, 600),
    terminals: holder ? holder.querySelectorAll('pre, [class*="terminal"], [class*="Terminal"]').length : 0,
  }
})
console.log('=== 点击该行后 ===')
console.log(JSON.stringify({ ...expanded, ...after }, null, 2))
await page.screenshot({ path: `${OUT}/out-2-expanded.png` })

// --- the 轨迹 tab ------------------------------------------------------------
const tab = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('button, [role="tab"], a, div'))
    .find((n) => n.children.length === 0 && (n.textContent || '').trim() === '轨迹')
  if (el === undefined) return { found: false }
  const clickable = el.closest('button, [role="tab"], a') ?? el
  clickable.click()
  return { found: true, tag: clickable.tagName }
})
await sleep(3000)
const traj = await page.evaluate(() => {
  const scroll = document.querySelector('[data-conversation-scroll]')
  return {
    hash: location.href,
    bodyHead: (document.body.innerText || '').replace(/\s+/gu, ' ').slice(0, 700),
    toolRows: document.querySelectorAll('[data-disclosure-row="true"]').length,
    railItems: document.querySelectorAll('[data-turn-process], [class*="rail"], [class*="Rail"]').length,
  }
})
console.log('=== 轨迹 视图 ===')
console.log(JSON.stringify({ tab, traj }, null, 2))
await page.screenshot({ path: `${OUT}/out-3-trajectory.png` })

await browser.close()
console.log('== done ==')
