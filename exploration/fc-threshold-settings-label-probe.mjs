// Probe: the Settings section must present 自动压缩阈值 as the DEFAULT that the
// per-session chip overrides. The label reads 默认值 and the hint explains where
// to override it. The other two fields must be untouched.
//
// Run: node exploration/fc-threshold-settings-label-probe.mjs   (needs 3080 up)
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

try {
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(11000)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((c) => (c.textContent || '').trim() === '继续'); if (b) b.click() })
  await sleep(2000)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((c) => (c.textContent || '').trim() === '设置')
    if (b) b.click()
  })
  await sleep(3000)

  const rows = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] nav button')].map((b) => (b.textContent || '').trim()))
  check(rows.includes('强制压缩'), 'the settings nav lists 强制压缩', rows.join(' / '))
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[role="dialog"] nav button')].find((c) => (c.textContent || '').trim() === '强制压缩')
    if (b) b.click()
  })
  await sleep(2500)

  const pane = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    return d ? (d.innerText || d.textContent || '') : ''
  })
  check(pane.includes('自动压缩阈值'), 'the section renders 自动压缩阈值')
  check(pane.includes('默认值'), 'its label was retitled to 默认值 (the section no longer reads as the single source)')
  check(/覆盖|会话/.test(pane), 'the hint points at where the override lives')
  check(pane.includes('保留最新上下文'), '保留最新上下文 is untouched')
  check(pane.includes('最大摘要数'), '最大摘要数 is untouched')
  if (failed > 0) console.log('\n--- pane text ---\n' + pane.slice(0, 1200))

  await page.screenshot({ path: 'D:/AI/deepseek-harness-plugins/exploration/fc-threshold-settings-label.png' })
  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '))
} finally {
  if (browser) await browser.close()
}

console.log('')
console.log(`${passed} ok, ${failed} failed`)
if (failed > 0) process.exitCode = 1