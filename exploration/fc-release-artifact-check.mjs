// Release-artifact check for @falling-ts/dsh-force-compact.
//
// Usage: node exploration/fc-release-artifact-check.mjs <installed package dir>
//
// Verifies the SHIPPED copy (not the working tree): the live-badge working
// lines in all four dictionaries carry no trailing ellipsis, the host's
// canonical WORKING_TEXTS match, and the retired swish stylesheet is absent.
import { existsSync, readFileSync } from 'node:fs'

const base = process.argv[2]
if (!base) throw new Error('usage: node fc-release-artifact-check.mjs <installed package dir>')
const read = (rel) => readFileSync(`${base}/${rel}`, 'utf8')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const pkg = JSON.parse(read('package.json'))
const client = read('web/client.js')
const host = read('src/core/ui-signal.js')

console.log(`artifact: ${pkg.name}@${pkg.version} at ${base}`)

const badgeLines = client.split('\n').filter((line) => /^\s*badgeWorking\d+: "/.test(line))
const dottedBadge = badgeLines.filter((line) => line.includes('...'))
check('20 working lines per language (80 total)', badgeLines.length === 80, `got ${badgeLines.length}`)
check('no working line ends with an ellipsis', dottedBadge.length === 0, dottedBadge.join(' | '))

const hostTexts = host.match(/WORKING_TEXTS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1].match(/'[^']*'/g) ?? []
check('host WORKING_TEXTS has 20 entries', hostTexts.length === 20, `got ${hostTexts.length}`)
check('no host entry ends with an ellipsis', hostTexts.every((s) => !s.endsWith("...'")), hostTexts.filter((s) => s.endsWith("...'")).join(' | '))

// zh must mirror the host array exactly (the i18n probe owns this too, but the
// published artifact must be checked on its own).
const zhBlock = client.match(/const zh = \{([\s\S]*?)\n    \};/)[1]
const zhBadge = [...zhBlock.matchAll(/badgeWorking(\d+): "([^"]*)"/g)].map((m) => `'${m[2]}'`)
const zhMirrorsHost = zhBadge.join(',') === hostTexts.join(',')
check('zh badge texts mirror the host order/content', zhMirrorsHost,
  zhMirrorsHost ? `${zhBadge.length} entries` : `length ${zhBadge.length} vs ${hostTexts.length}`)

for (const lang of ['en', 'ja', 'ko']) {
  const block = client.match(new RegExp(`const ${lang} = \\{([\\s\\S]*?)\\n    \\};`))?.[1] ?? ''
  const entries = [...block.matchAll(/badgeWorking\d+: "([^"]*)"/g)].map((m) => m[1])
  check(`${lang} has 20 non-empty working lines`, entries.length === 20 && entries.every((v) => v.length > 0), `got ${entries.length}`)
  check(`${lang} working lines carry no ellipsis`, entries.every((v) => !v.endsWith('...')), entries.filter((v) => v.endsWith('...')).join(' | '))
}

check('retired web/swish.css is absent', !existsSync(`${base}/web/swish.css`))

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${failed} failed`)
if (failed !== 0) process.exit(1)
