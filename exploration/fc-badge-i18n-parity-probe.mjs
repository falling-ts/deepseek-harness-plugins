// Probe: does the client half's zh badge list match the host's canonical
// WORKING_TEXTS element-for-element (index -> text)? A mismatch would mean a
// `working.N` textId renders a different one-liner than the host picked.
// Run: node exploration/fc-badge-i18n-parity-probe.mjs
import fs from 'node:fs'

const root = new URL('../dsh-force-compact/', import.meta.url)

const host = fs.readFileSync(new URL('src/core/ui-signal.js', root), 'utf8')
const client = fs.readFileSync(new URL('web/client.js', root), 'utf8')

const hostBlock = host.match(/WORKING_TEXTS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)
const hostTexts = [...hostBlock[1].matchAll(/'([^']*)'/g)].map((m) => m[1])

const zhBlock = client.match(/const zh = \{([\s\S]*?)\n {4}\};/)
const enBlock = client.match(/const en = \{([\s\S]*?)\n {4}\};/)
const pick = (block, prefix) =>
  [...block.matchAll(new RegExp(`${prefix}(\\d+):\\s*"([^"]*)"`, 'g'))]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[2])

const zh = pick(zhBlock[1], 'badgeWorking')
const en = pick(enBlock[1], 'badgeWorking')

console.log(`host WORKING_TEXTS count = ${hostTexts.length}`)
console.log(`client zh badgeWorking = ${zh.length}`)
console.log(`client en badgeWorking = ${en.length}`)

console.log('\nindex | zh matches host?')
let mismatches = 0
for (let i = 0; i < Math.max(hostTexts.length, zh.length); i++) {
  const same = hostTexts[i] === zh[i]
  if (!same) mismatches++
  if (!same) console.log(`  [${i}] MISMATCH host=${JSON.stringify(hostTexts[i])} zh=${JSON.stringify(zh[i])}`)
}
console.log(mismatches === 0 ? '  all 20 zh entries match the host order/content' : `  ${mismatches} mismatch(es)`)

// The client's zh entries shadow the host canonical text (t() wins over
// liveUi.text), so drift here silently replaces what the host intended.
console.log(`\nzh entries are the source of truth for zh users (shadowing host text): ${zh.length > 0}`)
