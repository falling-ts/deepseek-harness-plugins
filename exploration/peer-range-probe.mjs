// Probe: do the plugins' peer ranges actually admit the harness we ship against?
//
// A peer range is a promise, and a wrong one fails silently in two directions:
// too narrow and the plugin is un-installable on the harness the user actually
// runs; too loose and it loads onto an API surface it was never written for.
// This probe resolves the ranges with the SAME semver implementation the
// harness vendors (pnpm store), against the versions declared by the upstream
// packages in deepseek-harness/, and reports both directions.
//
// Baseline (2026-09-29, was 2026-09-23): the plugins target the dsh-v0.2.0-rc.1
// train (0.1.7-alpha.2 → 0.2.0-rc.1, 763 commits). 0.2.0 adds a boot-time peer
// compatibility preflight (app-boot `plugin-compatibility.ts`) that DISABLES a
// profile row whose `@deepseek-ai/dsh*` peers are not satisfied by the running
// runtime (semver, includePrerelease), unless an exact-version exemption is
// granted via `dsh plugin allow-version` -- so a wrong floor is no longer just
// "un-installable", it silently disables the plugin. The floor stays the pure
// lower bound of the train we ship against; cordis is still the vendor pin
// (4.0.4), schemastery the vendor pin (3.18.4).
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
// Scan the whole checkout for every published package name → version, so ANY
// `@deepseek-ai/dsh-*` peer resolves (0.2.0's preflight checks every dsh peer,
// so the probe must too). Vendor copies (cordis, schemastery) win over any
// workspace row of the same name, since that is the pin the harness ships.
const upstreamVersion = {}
const scanRoots = [
  'deepseek-harness/packages',
  'deepseek-harness/apps',
  'deepseek-harness/examples',
]
const scanDir = (dir, depth = 0) => {
  if (depth > 4) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  const manifest = path.join(dir, 'package.json')
  if (fs.existsSync(manifest)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string' && !pkg.private) {
        upstreamVersion[pkg.name] ??= pkg.version
      }
    } catch { /* an unreadable manifest is not this probe's subject */ }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    scanDir(path.join(dir, entry.name), depth + 1)
  }
}
for (const rel of scanRoots) scanDir(path.join(root, rel))
for (const vendor of ['vendor/cordis', 'vendor/schemastery']) {
  try {
    const pkg = readJson(`deepseek-harness/${vendor}/package.json`)
    if (typeof pkg.name === 'string') upstreamVersion[pkg.name] = pkg.version
  } catch { /* vendor copy absent */ }
}
console.log('\nupstream versions in this checkout:')
const peerNames = new Set()
for (const plugin of ['dsh-force-compact', 'dsh-web-ding', 'dsh-local-no-auth']) {
  for (const name of Object.keys(readJson(`${plugin}/package.json`).peerDependencies ?? {})) peerNames.add(name)
}
for (const name of [...peerNames].sort()) {
  console.log(`  ${name.padEnd(38)} ${upstreamVersion[name] ?? '<NOT FOUND IN CHECKOUT>'}`)
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
check(semver.satisfies(harnessVersion, FLOOR, { includePrerelease: true }),
  `${harnessVersion} satisfies ${FLOOR} with includePrerelease (what the 0.2.0 preflight uses)`)
check(!semver.satisfies('0.1.6-alpha.2', FLOOR, { includePrerelease: true }),
  `0.1.6-alpha.2 is excluded by ${FLOOR}`)
check(!semver.satisfies('0.1.7-alpha.2', FLOOR, { includePrerelease: true }),
  `0.1.7-alpha.2 is excluded by ${FLOOR} (previous baseline, pre-0.2.0 surface)`)
check(!semver.satisfies('0.2.0-rc.0', FLOOR, { includePrerelease: true }),
  `0.2.0-rc.0 (earlier prerelease of the tuple) is excluded by ${FLOOR}`)
check(semver.satisfies('0.2.0', FLOOR, { includePrerelease: true }),
  `0.2.0 (release) is admitted (>= has no upper cap)`)
check(semver.satisfies('0.2.1', FLOOR, { includePrerelease: true }),
  `0.2.1 is admitted (>= has no upper cap)`)
check(!semver.satisfies('0.1.7', FLOOR, { includePrerelease: true }),
  `0.1.7 (release) is excluded by ${FLOOR}`)

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} -- ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
