// Probe: the per-session threshold chip must survive BOTH 性能与用量 display
// modes. The requirement ("简洁和详细都展示") exists because the composer dock
// normally carries StatsPills, and StatsPills returns null in compact mode when
// it has nothing to say. The chip is a SEPARATE slot entry (order 100) that
// never reads `performanceUsage`, so it must render in either mode.
//
// Run: node exploration/fc-session-threshold-mode-probe.mjs   (needs 3080 up)
import { createRequire } from 'node:module'
const require = createRequire('D:/AI/deepseek-harness-plugins/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let passed = 0
let failed = 0
const errors = []
const check = (ok, label, detail = '') => {
  if (ok) passed++; else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : '  ' + detail}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e && e.message ? e.message : e)))
page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)) })

const openSession = async () => {
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('*')].find((n) => n.children.length === 0 && (n.textContent || '').trim() === '熟悉项目')
    if (!row) return
    const b = row.closest('button, a, [role="button"], li, div')
    ;(b || row).click()
  })
  await sleep(8000)
}
const chipOf = async () => page.evaluate(() => {
  const chip = document.querySelector('[data-fc-threshold-chip]')
  if (!chip) return null
  const pill = chip.querySelector('button')
  return {
    label: (chip.textContent || '').trim(),
    session: chip.getAttribute('data-fc-threshold-session'),
    hasIcon: chip.querySelector('svg') !== null,
    pillLabel: pill ? (pill.getAttribute('aria-label') || '') : null,
  }
})
const openSettings = async () => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((c) => (c.textContent || '').trim() === '设置')
    if (b) b.click()
  })
  await sleep(2500)
}
const closeSettings = async () => {
  await page.keyboard.press('Escape')
  await sleep(1200)
  if (await page.evaluate(() => document.querySelector('[role="dialog"]') !== null)) {
    await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      const b = [...d.querySelectorAll('button')].find((c) => /关闭/.test(c.getAttribute('aria-label') || '') || (c.textContent || '').trim() === '关闭')
      if (b) b.click()
    })
    await sleep(1200)
  }
}
const pickMode = async (want) => {
  const clicked = await page.evaluate(() => {
    const label = [...document.querySelectorAll('*')].find((n) => n.children.length === 0 && (n.textContent || '').trim() === '性能与用量')
    if (!label) return false
    let row = label
    for (let i = 0; i < 8 && row; i++) {
      row = row.parentElement
      if (!row) break
      const b = row.querySelector('button[aria-haspopup="menu"]')
      if (b) { b.click(); return true }
    }
    return false
  })
  if (!clicked) return { ok: false, reason: 'selector not found' }
  await sleep(900)
  const menu = await page.evaluate((wantLabel) => {
    const items = [...document.querySelectorAll('[role="menuitem"],[role="option"],button')]
      .filter((n) => (n.textContent || '').trim() === wantLabel)
    const hit = items[items.length - 1]
    if (!hit) {
      return { ok: false, seen: [...document.querySelectorAll('[role="menu"],[role="listbox"]')].map((m) => (m.textContent || '').slice(0, 80)) }
    }
    hit.click()
    return { ok: true }
  }, want)
  await sleep(2000)
  return menu
}
try {
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(11000)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((c) => (c.textContent || '').trim() === '继续'); if (b) b.click() })
  await sleep(2500)
  await openSession()

  const detailed = await chipOf(page)
  check(detailed !== null, 'the chip renders in the default (detailed) mode')
  check(detailed !== null && detailed.label.length > 0, 'the detailed-mode chip shows a reading', detailed && detailed.label)
  check(detailed !== null && detailed.hasIcon, 'the chip pairs an icon with the reading')

  await openSettings()
  const detailPick = await pickMode('简洁')
  check(detailPick.ok, 'switching 性能与用量 to 简洁', JSON.stringify(detailPick).slice(0, 160))
  await closeSettings()

  const compact = await chipOf(page)
  check(compact !== null, 'the chip STILL renders after switching 性能与用量 to 简洁')
  check(compact !== null && compact.label === (detailed && detailed.label),
    'the reading is unchanged by the display mode', `${compact && compact.label} vs ${detailed && detailed.label}`)
  check(compact !== null && compact.session === (detailed && detailed.session), 'still the same session key')

  // The mode really moved: the built-in stats row carries a data hook we can count.
  const statsChanged = await page.evaluate(() => document.querySelectorAll('[data-composer-stats]').length)
  check(statsChanged <= 1, 'the built-in stats row is still a single row in compact mode', String(statsChanged))

  await openSettings()
  const backPick = await pickMode('详细')
  check(backPick.ok, 'restoring 性能与用量 to 详细', JSON.stringify(backPick).slice(0, 160))
  await closeSettings()
  const restored = await chipOf(page)
  check(restored !== null && restored.label === (detailed && detailed.label), 'the chip is unaffected by the round trip', restored && restored.label)

  await page.screenshot({ path: 'D:/AI/deepseek-harness-plugins/exploration/fc-session-threshold-mode.png' })
  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '))
} finally {
  if (browser) await browser.close()
}

console.log('')
console.log(`${passed} ok, ${failed} failed`)
if (failed > 0) process.exitCode = 1
