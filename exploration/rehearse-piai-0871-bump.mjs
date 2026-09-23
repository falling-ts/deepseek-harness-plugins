// Rehearsal edit for the pi-ai 0.85.1 -> 0.87.1 bump, applied to a throwaway clone.
// Writes are done here (never through shell string cmdlets) so UTF-8 files stay intact.
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node rehearse-piai-0871-bump.mjs <clone-root>')
  process.exit(2)
}
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const write = (p, s) => fs.writeFileSync(path.join(root, p), s)

const pkgPath = 'packages/llm/llm-pi-ai/package.json'
const oldRange = '"@earendil-works/pi-ai": "^0.85.1"'
let pkg = read(pkgPath)
if (!pkg.includes(oldRange)) throw new Error(`range not found in ${pkgPath}`)
pkg = pkg.replace(oldRange, '"@earendil-works/pi-ai": "^0.87.1"')
write(pkgPath, pkg)

const wsPath = 'pnpm-workspace.yaml'
const oldPatch = "'@earendil-works/pi-ai@0.85.1': patches/@earendil-works__pi-ai@0.85.1.patch"
let ws = read(wsPath)
if (!ws.includes(oldPatch)) throw new Error('patchedDependencies key not found')
ws = ws.replace(oldPatch, "'@earendil-works/pi-ai@0.87.1': patches/@earendil-works__pi-ai@0.87.1.patch")
const oldAiExcl = "  - '@earendil-works/pi-ai@0.85.1'\n"
const oldTeleExcl = "  - '@earendil-works/pi-telemetry@0.85.1'\n"
if (!ws.includes(oldAiExcl) || !ws.includes(oldTeleExcl)) throw new Error('release-age exclusions not found')
ws = ws.replace(oldAiExcl, `${oldAiExcl}  - '@earendil-works/pi-ai@0.87.1'\n`)
ws = ws.replace(oldTeleExcl, `${oldTeleExcl}  - '@earendil-works/pi-telemetry@0.87.1'\n`)
write(wsPath, ws)

const oldPatchFile = path.join(root, 'patches', '@earendil-works__pi-ai@0.85.1.patch')
const newPatchFile = path.join(root, 'patches', '@earendil-works__pi-ai@0.87.1.patch')
if (!fs.existsSync(oldPatchFile)) throw new Error('patch file missing')
fs.renameSync(oldPatchFile, newPatchFile)

console.log('[bump] range ^0.87.1, patchedDependencies re-keyed, exclusions appended, patch renamed')
