/**
 * Verify that a DSH profile's installed @falling-ts plugins publish resolvable display metadata.
 *
 * Mirrors what the host does in `packages/boot/app-boot/src/package-meta.ts` (`readPluginMeta`):
 * resolve `<specifier>/locale/en.json` and `<specifier>/package.json` through Node's own resolver
 * from the profile directory, then read each locale file's `meta` and the manifest's `icon`.
 * A plugin whose manifest lacks the `./locale/*.json` export or the top-level `icon` resolves to
 * nothing here, which is exactly the silent fallback the GUI shows as an unresolved name/icon.
 *
 * Usage: node exploration/desktop-plugin-meta-probe.mjs [profileDir]
 * Defaults to `<home>/.dsh/profiles/desktop`.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PACKAGES = ['@falling-ts/dsh-force-compact', '@falling-ts/dsh-web-ding']
const ICON_LIMIT_BYTES = 256 * 1024

const profileDir = resolve(process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop'))
const require = createRequire(join(profileDir, 'package.json'))

/** Resolve one plugin resource exactly as the host's `optionalResourcePath` does, or undefined. */
function resourcePath(specifier) {
  try {
    return require.resolve(specifier)
  } catch {
    return undefined
  }
}

let failures = 0
console.log(`profile: ${profileDir}`)
console.log(`manifest: ${join(profileDir, 'package.json')}`)

const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
console.log(`bundles: ${JSON.stringify(profileManifest.dsh?.profile?.bundles ?? [])}`)
console.log(`dependencies: ${JSON.stringify(profileManifest.dependencies ?? {})}`)

for (const name of PACKAGES) {
  console.log(`\n=== ${name} ===`)
  const manifestPath = resourcePath(`${name}/package.json`)
  if (manifestPath === undefined) {
    console.log('  FAIL package.json is not exported (readPluginMeta would return undefined)')
    failures += 1
    continue
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const installedDir = dirname(manifestPath)
  console.log(`  installed: ${installedDir}`)
  console.log(`  version:   ${manifest.version}`)
  console.log(`  declared:  ${JSON.stringify(profileManifest.dependencies?.[name] ?? null)}`)
  console.log(`  dsh.bundle: ${JSON.stringify(manifest.dsh?.bundle ?? null)}`)
  console.log(`  exports[./locale/*.json]: ${JSON.stringify(manifest.exports?.['./locale/*.json'] ?? null)}`)

  const englishPath = resourcePath(`${name}/locale/en.json`)
  if (englishPath === undefined) {
    console.log('  FAIL locale/en.json is not reachable (title/description fall back to package.json)')
    failures += 1
  } else {
    const localeDir = dirname(englishPath)
    console.log(`  locale dir: ${localeDir}`)
    for (const file of readdirSync(localeDir).filter(entry => entry.endsWith('.json')).sort()) {
      const parsed = JSON.parse(readFileSync(join(localeDir, file), 'utf8'))
      const meta = parsed.meta ?? {}
      console.log(`    ${file}: title=${JSON.stringify(meta.title ?? null)} description.length=${meta.description === undefined ? 'missing' : String(meta.description).length}`)
      if (meta.title === undefined) {
        console.log(`    FAIL ${file} has no meta.title`)
        failures += 1
      }
    }
  }

  if (manifest.icon === undefined) {
    console.log('  FAIL manifest declares no top-level icon (GUI shows no icon)')
    failures += 1
  } else {
    const iconPath = resolve(installedDir, manifest.icon)
    if (!existsSync(iconPath)) {
      console.log(`  FAIL icon file missing: ${iconPath}`)
      failures += 1
    } else {
      const bytes = statSync(iconPath).size
      console.log(`  icon: ${manifest.icon} (${bytes} bytes, ${bytes <= ICON_LIMIT_BYTES ? 'within' : 'OVER'} the 256 KiB limit)`)
      if (bytes > ICON_LIMIT_BYTES) failures += 1
    }
  }
}

console.log(`\n${failures === 0 ? 'OK: every plugin publishes resolvable title/description/icon' : `FAIL: ${failures} metadata problem(s)`}`)
process.exitCode = failures === 0 ? 0 : 1
