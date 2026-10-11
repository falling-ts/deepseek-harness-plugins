// Release-artifact check for @falling-ts/dsh-force-compact.
//
// Usage: node exploration/fc-release-artifact-check.mjs <installed package dir>
//
// Verifies the SHIPPED copy (not the working tree): the host publishes one phase
// per kind of agent action, every phase has a badge in all four dictionaries,
// the retired random working texts are gone, and the retired swish stylesheet is
// absent.
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

// The host's phase union is the fact source; the client map must cover it.
const hostPhases = [...host.match(/PHASE_TEXTS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/)[1]
  .matchAll(/\[PHASE_[A-Z]+\]:\s*'([^']*)'/g)].map((m) => m[1])
check('host defines the six agent-action phases', hostPhases.length === 6, `got ${hostPhases.length}`)

const clientMap = client.match(/const PHASE_KEYS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
const mapped = [...clientMap.matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => m[2])
check('client phase map covers the host union', mapped.length === hostPhases.length, `got ${mapped.length}`)

for (const lang of ['en', 'ja', 'ko']) {
  const block = client.match(new RegExp(`const ${lang} = \\{([\\s\\S]*?)\\n    \\};`))?.[1] ?? ''
  const missing = mapped.filter((k) => !new RegExp(`\\b${k}:\\s*"`).test(block))
  check(`${lang} defines every phase badge`, missing.length === 0, `missing=[${missing}]`)
}

const zhBlock = client.match(/const zh = \{([\s\S]*?)\n    \};/)[1]
const zhMissing = mapped.filter((k) => !new RegExp(`\\b${k}:\\s*"`).test(zhBlock))
check('zh defines every phase badge', zhMissing.length === 0, `missing=[${zhMissing}]`)

// The random working one-liners are retired in BOTH halves; the client keeps
// only the locales' non-badge copy.
check('host no longer defines WORKING_TEXTS', !/WORKING_TEXTS/.test(host))
check('client no longer defines badgeWorking<N>', !/badgeWorking\d/.test(client))

check('retired web/swish.css is absent', !existsSync(`${base}/web/swish.css`))

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${failed} failed`)
if (failed !== 0) process.exit(1)
