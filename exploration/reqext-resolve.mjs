// Replicate dsh_plugin_packages' barePackageManifest() with the REAL anchors and test
// which third-party plugin package.json each anchor can resolve.
// Run: node D:/deepseek-harness-plugins/exploration/reqext-resolve.mjs
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const PROFILE_DIR = `C:/Users/zghyu/.dsh/profiles/web`
const HARNESS_DIR = 'D:/deepseek-harness-plugins/deepseek-harness'
const PLUGIN_PKG = 'D:/deepseek-harness-plugins/deepseek-harness/packages/llm/plugin-package-inventory-deepseek/src/index.ts'

const anchors = {
  'profileBase (host-tree treeBase)': pathToFileURL(PROFILE_DIR + '/').href,
  'harnessBase (preset-tree treeBase)': pathToFileURL(HARNESS_DIR + '/').href,
  'dsh_plugin_packages url (hostBaseUrl/import.meta)': pathToFileURL(PLUGIN_PKG).href,
}

const plugins = [
  // third-party (only in profile node_modules)
  'dshmarket',
  '@falling-ts/dsh-force-compact',
  '@falling-ts/dsh-local-no-auth',
  '@falling-ts/dsh-web-ding',
  '@hytime/dsh-thinking-effort',
  '@max-null/dsh-chinese-thinking',
  '@michengai/dsh-archive-manager',
  // official workspace packages (in harness packages/*, maybe not in node_modules)
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  '@deepseek-ai/cordis-plugin-loader',
]

// Exact copy of the source's barePackageManifest
function barePackageManifest(packageName, anchorUrl) {
  for (const anchor of [anchorUrl]) {
    const searchPaths = createRequire(anchor).resolve.paths(packageName)
    if (searchPaths === null) continue
    for (const searchPath of searchPaths) {
      const manifest = join(searchPath, packageName, 'package.json')
      if (existsSync(manifest)) return manifest
    }
  }
  return undefined
}

console.log('anchor resolution matrix (found? / manifest path):')
console.log('plugin'.padEnd(34), '| profileBase'.padEnd(12), '| harnessBase'.padEnd(12), '| pluginUrl')
console.log('-'.repeat(90))
for (const p of plugins) {
  const prof = barePackageManifest(p, anchors['profileBase (host-tree treeBase)'])
  const har = barePackageManifest(p, anchors['harnessBase (preset-tree treeBase)'])
  const plu = barePackageManifest(p, anchors['dsh_plugin_packages url (hostBaseUrl/import.meta)'])
  const cell = (v) => (v ? 'FOUND' : 'MISSING')
  console.log(p.padEnd(34), '|', cell(prof).padEnd(12), '|', cell(har).padEnd(12), '|', cell(plu))
  if (prof) console.log('      profileBase -> ' + prof)
  if (plu) console.log('      pluginUrl   -> ' + plu)
}
