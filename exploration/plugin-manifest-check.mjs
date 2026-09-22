/**
 * 严格校验三个自有插件的 package.json 与 peer 基线。
 *
 * 存在的理由：PowerShell 5.1 的字符串 cmdlet 往返会以 ANSI 解码 UTF-8（无 BOM）
 * 文件，把多字节字符截断成非法 UTF-8；文件仍"看起来正常"、`ConvertFrom-Json`
 * 也照样解析，但 Node 的 `JSON.parse` 直接拒绝。本探针用 JSON.parse 作为唯一判据，
 * 并断言 peer 基线为 dsh-v0.1.7-alpha.1 列车（cordis 4.0.4 / schemastery 3.18.4）。
 *
 * 用法：node exploration/plugin-manifest-check.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 三个自有插件目录名。 */
const PLUGINS = ['dsh-force-compact', 'dsh-local-no-auth', 'dsh-web-ding']

/** 必须已被替换掉的旧基线字面量。 */
const STALE = ['0.1.6-alpha.1', '"4.0.2"']

/** 所有 `@deepseek-ai/dsh-*` peer 的下界（harness tag dsh-v0.1.7-alpha.1）。 */
const DSH_BASELINE = '>=0.1.7-alpha.1'

/** 非 dsh 命名空间的 peer 下界。 */
const OTHER_RANGES = {
  '@deepseek-ai/cordis': '>=4.0.4',
  '@deepseek-ai/schemastery': '>=3.18.4',
}

/** 唯一允许是 required 的 peer；其余 dsh-* 一律 optional（由 dsh 安装提供）。 */
const REQUIRED = new Set(['@deepseek-ai/cordis'])

let failures = 0
const fail = (message) => {
  console.log(`  [!!] ${message}`)
  failures += 1
}

for (const plugin of PLUGINS) {
  const raw = readFileSync(join(ROOT, plugin, 'package.json'), 'utf8')
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    fail(`${plugin}/package.json 不是合法 UTF-8 JSON：${error.message}`)
    continue
  }
  console.log(`${plugin.padEnd(20)} v${manifest.version}`)
  const peers = manifest.peerDependencies ?? {}
  const meta = manifest.peerDependenciesMeta ?? {}
  for (const [name, range] of Object.entries(peers)) {
    const expected = name.startsWith('@deepseek-ai/dsh-') ? DSH_BASELINE : OTHER_RANGES[name]
    const optional = meta[name]?.optional === true
    const okRange = expected === undefined ? true : range === expected
    const okOptional = REQUIRED.has(name) ? !optional : optional
    const mark = okRange && okOptional ? ' [OK]' : ' [!!]'
    console.log(`    ${name.padEnd(42)} ${range}${optional ? ' (optional)' : ''}${mark}`)
    if (!okRange) fail(`${plugin}: ${name} 应为 "${expected}"，实为 "${range}"`)
    if (!okOptional) fail(`${plugin}: ${name} 的 optional 应为 ${!REQUIRED.has(name)}`)
  }
  for (const stale of STALE) {
    if (raw.includes(stale)) fail(`${plugin}/package.json 仍残留旧基线字面量 ${stale}`)
  }
}

console.log('')
if (failures === 0) {
  console.log(`全部 ${PLUGINS.length} 个 manifest 干净：严格 JSON + peer 已切到 dsh-v0.1.7-alpha.1 列车`)
} else {
  console.log(`${failures} 处失败`)
}
process.exit(failures === 0 ? 0 : 1)
