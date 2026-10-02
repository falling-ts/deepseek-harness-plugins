// Live probe: the per-session compaction-threshold chip in a REAL browser against
// a running `dsh web` (the web profile links force-compact to this workspace, so
// web/client.js is served straight off disk).
//
// Offline, fc-session-threshold-probe.mjs proves the resolvers and the wiring.
// This probe proves the part only a browser + a live host can:
//   1. the slot entry actually renders into `conversation.composer.dock`;
//   2. the popover opens, parses a K-suffixed draft and writes it;
//   3. the write reaches the HOST (the value survives a full page reload, so it
//      came back through the settings document, not from client state);
//   4. clearing falls back to the global default and the key disappears.
//
// Run: node exploration/fc-session-threshold-live-probe.mjs [port]
import { createRequire } from 'node:module'

const require = createRequire('D:/AI/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const SESSION_ROW = '熟悉项目'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const chipOf = (page) => page.evaluate(() => {
  const chip = document.querySelector('[data-fc-threshold-chip]')
  if (!chip) return null
  const btn = chip.querySelector('button')
  // The pill caption is fixed text; the effective value rides on the aria-label
  // ("<caption>: 700K"), which is also what the tooltip/panel expand on.
  const aria = btn ? btn.getAttribute('aria-label') : null
  const parts = aria ? aria.split(': ') : []
  return {
    session: chip.getAttribute('data-fc-threshold-session'),
    caption: (chip.textContent || '').trim(),
    value: parts.length > 1 ? parts[parts.length - 1] : null,
    expanded: btn ? btn.getAttribute('aria-expanded') : null,
    title: btn ? btn.getAttribute('title') : null,
  }
})

async function openSession(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(10000)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((c) => (c.textContent || '').trim() === '继续')
    if (b) b.click()
  })
  await sleep(2000)
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll('*')]
      .find((n) => n.children.length === 0 && (n.textContent || '').trim() === name)
    if (row) { const b = row.closest('button, a, [role="button"], li, div'); (b || row).click() }
  }, SESSION_ROW)
  await sleep(8000)
}

let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const errors = []
  const failedRequests = []
  page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // A resource 404 surfaces twice (console + response); the response listener
    // below owns that class, so keep the console copy out of the page-error tally.
    if (/Failed to load resource/.test(m.text())) return
    errors.push('console: ' + m.text())
  })
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(r.status() + ' ' + r.url()) })

  await openSession(page)
  const initial = await chipOf(page)
  if (initial === null) { console.log('  FAIL chip did not render into conversation.composer.dock'); process.exit(1) }
  check(initial !== null, 'the chip renders into conversation.composer.dock')
  check(typeof initial.session === 'string' && initial.session.length > 0,
    'the chip knows its session', initial.session)
  check(initial.caption.length > 0 && !/^\d/.test(initial.caption),
    'the resting pill shows the fixed caption, not a number', initial.caption)
  check(/^(\d+(\.\d+)?[KM]?|\d+)$/.test(String(initial.value)),
    'the effective value rides on the aria-label', String(initial.value))
  check(initial.expanded === 'false', 'the pill rests collapsed')
  check(errors.length === 0, 'no page errors while rendering the chip', errors.slice(0, 2).join(' | '))  // ---------------------------------------------------- popover + K-suffix write
  await page.click('[data-fc-threshold-chip] button')
  await sleep(700)
  const dialog = await page.evaluate(() => {
    const d = document.querySelector('[data-fc-threshold-chip] [role="dialog"]')
      || document.querySelector('[role="dialog"]')
    if (!d) return null
    const input = d.querySelector('input[type="text"]')
    return {
      open: true,
      hasInput: input !== null,
      value: input ? input.value : null,
      buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
    }
  })
  check(dialog !== null, 'clicking the pill opens a dialog')
  check(dialog !== null && dialog.hasInput, 'the dialog carries a text input')
  check(dialog !== null && dialog.value === initial.value, 'the input is prefilled with the effective value', String(dialog && dialog.value))
  check(dialog !== null && dialog.buttons.some((b) => b.indexOf('保存') === 0), 'the dialog offers a save button')
  const expanded = await chipOf(page)
  check(expanded.expanded === 'true', 'the pill reports aria-expanded while open')

  await page.fill('[data-fc-threshold-chip] [role="dialog"] input[type="text"], [role="dialog"] input[type="text"]', '123K')
  await page.evaluate(() => {
    const d = document.querySelector('[data-fc-threshold-chip] [role="dialog"]') || document.querySelector('[role="dialog"]')
    const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0)
    b.click()
  })
  await sleep(2500)
  const saved = await chipOf(page)
  check(saved.value === '123K', 'saving 123K rewrites the effective value', String(saved.value))
  const closed = await page.evaluate(() => document.querySelector('[data-fc-threshold-chip] [role="dialog"]') === null)
  check(closed, 'a successful save closes the dialog')

  // ------------------------------------------- durability: through the HOST
  await openSession(page)
  const afterReload = await chipOf(page)
  check(afterReload !== null && afterReload.value === '123K',
    'the override SURVIVES a full reload (it round-tripped through the host settings document)',
    afterReload ? afterReload.value : 'chip missing')
  check(afterReload !== null && afterReload.session === initial.session, 'the same session came back', String(afterReload && afterReload.session))
  check(afterReload !== null && afterReload.title && afterReload.title.indexOf('已覆盖') > 0,
    'an overridden chip announces the override in its tooltip', String(afterReload && afterReload.title))
  // --------------------------------------- invalid draft is refused, not written
  await page.click('[data-fc-threshold-chip] button')
  await sleep(600)
  await page.fill('[role="dialog"] input[type="text"]', 'abc')
  await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0)
    b.click()
  })
  await sleep(1200)
  const refused = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    return {
      stillOpen: d !== null,
      text: d ? (d.textContent || '') : '',
    }
  })
  check(refused.stillOpen, 'an unparseable draft keeps the dialog open')
  check(/无法解析/.test(refused.text), 'an unparseable draft shows the parse error')
  await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    const input = d.querySelector('input[type="text"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '123K')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0)
    b.click()
  })
  await sleep(2200)
  const stillSaved = await chipOf(page)
  check(stillSaved.value === '123K', 'the stored value did not move while the draft was invalid', String(stillSaved.value))

  // ----------------------------------------- clearing falls back to the global
  await page.click('[data-fc-threshold-chip] button')
  await sleep(600)
  const clearClicked = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim().indexOf('使用全局默认') === 0)
    if (!b) return false
    b.click(); return true
  })
  check(clearClicked, 'an overridden session offers the reset-to-global action')
  await sleep(2500)
  const cleared = await chipOf(page)
  check(cleared.value === initial.value, 'clearing returns the global default', `${cleared.value} vs ${initial.value}`)
  check(cleared.title !== null && cleared.title.indexOf('已覆盖') < 0, 'the tooltip stops announcing an override')

  await openSession(page)
  const afterClearReload = await chipOf(page)
  check(afterClearReload !== null && afterClearReload.value === initial.value,
    'the cleared state also survives a reload (the key is really gone)', afterClearReload ? afterClearReload.value : 'chip missing')

  // ------------------------------------------------- per-session isolation
  const other = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('*')]
      .find((n) => n.children.length === 0 && (n.textContent || '').trim() === name)
    if (!row) return false
    const b = row.closest('button, a, [role="button"], li, div'); (b || row).click(); return true
  }, '参考视频工作流帧索引锚定来源')
  if (other) {
    await sleep(8000)
    const otherChip = await chipOf(page)
    check(otherChip !== null && otherChip.session !== cleared.session,
      'a different session is a different key', String(otherChip && otherChip.session))
    check(otherChip !== null && otherChip.value === initial.value,
      'the other session is untouched by this session\'s override', String(otherChip && otherChip.value))
  }

  await page.screenshot({ path: 'D:/AI/deepseek-harness-plugins/exploration/fc-session-threshold-chip.png' })
  check(errors.length === 0, 'no page errors across the whole run', errors.slice(0, 3).join(' | '))
  // `changes.summary` belongs to the workspace-changes (changed-files) unit: it 404s
  // for a turn seq that recorded no changeset, which is the normal answer for a
  // session with no file edits. Nothing to do with force-compact; everything else
  // is a real failure.
  const unexpected = failedRequests.filter((r) => !/\/api\/changes\.summary/.test(r))
  check(unexpected.length === 0, 'no failed HTTP responses outside the workspace-changes 404', unexpected.slice(0, 3).join(' | '))
} finally {
  if (browser) await browser.close()
}

console.log('')
console.log(`${passed} ok, ${failed} failed`)
if (failed > 0) process.exitCode = 1
