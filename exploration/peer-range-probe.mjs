// Probe: do the plugins' peer ranges actually admit the harness we ship against?
//
// A peer range is a promise, and a wrong one fails silently in two directions:
// too narrow and the plugin is un-installable on the harness the user actually
// runs; too loose and it loads onto an API surface it was never written for.
// This probe resolves the ranges with the SAME semver implementation the
// harness vendors (pnpm store), against the versions declared by the upstream
// packages in deepseek-harness/, and reports both directions.
//
// Baseline (2026-09-23): the plugins target the dsh-v0.1.7-alpha.2 train, whose
// client settings service is `configForms` (the old `settingsScope` is gone) and
// whose vendored cordis is 4.0.4. Every peer floor is therefore asserted to be
// exactly `>=<the version this checkout declares>` -- for cordis that is the
// vendor copy, not the dsh release train.
//
// It also parses every package.json with Node's JSON.parse rather than a lenient
// reader: this workspace was once bitten by a shell round-trip that replaced an
// em dash with a bare 0x3F byte, which ConvertFrom-Json happily accepted while
// Node refused it -- the plugin then failed to import and its host half silently
// never loaded.
//
// Run: node exploration/peer-range-probe.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))

// The harness vendors several semver majors; use the newest (what npm itself uses).
const store = path.join(root, 'deepseek-harness/node_modules/.pnpm')
const semverDir = fs.readdirSync(store)
  .filter((d) => /^semver@\d/.test(d))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .pop()
if (!semverDir) throw new Error('no vendored semver found under deepseek-harness/node_modules/.pnpm')
const require_ = createRequire(import.meta.url)
const semver = require_(path.join(store, semverDir, 'node_modules/semver'))

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`) }
}

console.log(`semver ${require_(path.join(store, semverDir, 'node_modules/semver/package.json')).version}` +
  `  (vendored by the harness at ${semverDir})`)

// ── what the harness actually declares ───────────────────────────────────────
// cordis is read from vendor/ (its own pin), everything else from the workspace.
const UPSTREAM = {
  '@deepseek-ai/dsh-settings': 'deepseek-harness/packages/settings/settings/package.json',
  '@deepseek-ai/dsh-client-connection': 'deepseek-harness/packages/client/connection/package.json',
  '@deepseek-ai/dsh-host-webserver': 'deepseek-harness/packages/host/webserver/package.json',
  '@deepseek-ai/cordis': 'deepseek-harness/vendor/cordis/package.json',
}
const upstreamVersion = {}
for (const [name, rel] of Object.entries(UPSTREAM)) {
  try { upstreamVersion[name] = readJson(rel).version } catch { upstreamVersion[name] = undefined }
}
console.log('\nupstream versions in this checkout:')
for (const [name, v] of Object.entries(upstreamVersion)) {
  console.log(`  ${name.padEnd(38)} ${v ?? '<not present>'}`)
}

const PLUGINS = ['dsh-force-compact', 'dsh-web-ding', 'dsh-local-no-auth']
const harnessVersion = upstreamVersion['@deepseek-ai/dsh-settings']

for (const plugin of PLUGINS) {
  console.log(`\n=== ${plugin} ===`)
  const pkg = readJson(`${plugin}/package.json`)   // strict parse = the em-dash gate
  check(true, `package.json parses strictly as JSON (${pkg.name} ${pkg.version})`)

  const peers = pkg.peerDependencies ?? {}
  const meta = pkg.peerDependenciesMeta ?? {}
  check(Object.keys(peers).length > 0, 'declares peer dependencies')
  check(/^\d+\.\d+\.\d+/.test(pkg.version), `version is plain semver (${pkg.version})`)

  for (const [name, range] of Object.entries(peers)) {
    const actual = upstreamVersion[name]
    const optional = meta[name]?.optional === true
    if (actual === undefined) {
      check(!name.startsWith('@deepseek-ai/dsh-'),
        `${name} ${range} [${optional ? 'optional' : 'required'}] -- no upstream copy to compare`)
      continue
    }
    check(semver.satisfies(actual, range),
      `${name} ${range} [${optional ? 'optional' : 'required'}] admits the shipped ${actual}`)

    // Every peer floor names the exact version this checkout ships: a pure lower
    // bound of that package's own release train (cordis included, from vendor/).
    check(range.trim() === `>=${actual}`,
      `${name} range is exactly >=${actual}`,
      `got ${range}`)
  }

  // npm refuses to publish a package whose own version is below a peer floor it names.
  check(semver.valid(pkg.version) !== null, 'publishable version')
}

// ── the boundary semantics the range relies on ───────────────────────────────
console.log('\n=== range boundary semantics ===')
const FLOOR = `>=${harnessVersion}`
check(semver.satisfies(harnessVersion, FLOOR), `${harnessVersion} satisfies ${FLOOR} (we are installable here)`)
check(!semver.satisfies('0.1.6-alpha.2', FLOOR), `0.1.6-alpha.2 is excluded by ${FLOOR} (no configForms there)`)
check(!semver.satisfies('0.1.7-alpha.1', FLOOR), `0.1.7-alpha.1 (earlier prerelease of the tuple) is excluded by ${FLOOR}`)
check(semver.satisfies('0.1.7-alpha.2', FLOOR), `the baseline itself (0.1.7-alpha.2) is admitted`)
check(semver.satisfies('0.1.7', FLOOR), `0.1.7 (release) is admitted (>= has no upper cap)`)
check(semver.satisfies('0.1.8', FLOOR), `0.1.8 is admitted (>= has no upper cap)`)
check(!semver.satisfies('0.1.5', FLOOR), `0.1.5 (release) is excluded by ${FLOOR}`)

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} -- ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
