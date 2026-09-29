/**
 * repair-empty-node-modules-links.mjs — 修复 pnpm 增量安装漏建的依赖链接。
 *
 * 背景（2026-09-29，harness 0.1.7-alpha.2 → 0.2.0-rc.1）：
 * `pnpm install` 在 Windows 上偶发地把某些 workspace 包的
 * `node_modules/<scope>` 建成**真实空目录**（不是 junction，不是 symlink），
 * 而 .pnpm 虚拟存储里其实有完整内容。后果：
 *   - `pnpm build` 的 `tsc -b` 报 `TS2307: Cannot find module '@earendil-works/pi-ai'`；
 *   - 运行时 Node 解析同样会失败。
 * 而且 pnpm 自己修不了：`pnpm install --force` 与删掉
 * `node_modules/.modules.yaml` 后重跑都只回 "Already up to date"，
 * 因为它的完成态判断不检查这些链接是否真的存在。
 *
 * 本脚本按 pnpm-lock.yaml 的 importers 段**自己算**每个缺失依赖该指向哪里：
 *   - `version: link:<path>` → 工作区目录（相对该包目录解析）；
 *   - `version: 0.85.1(patch_hash=…)(…)` → 虚拟存储目录
 *     `node_modules/.pnpm/<编码名>@<版本前缀>.<hash>/node_modules/<spec>`
 *     （Windows 长路径下 pnpm 会把目录名截断成 `<编码名>@<maj.min>._<hash>`，
 *      故只按 `<编码名>@<maj.min>` 前缀匹配；同 spec 多版本时会打印并跳过）。
 * 然后创建 Windows junction（pnpm isolated linker 用的就是 junction）。
 *
 * 用法：
 *   node exploration/repair-empty-node-modules-links.mjs          # dry-run，只列计划
 *   node exploration/repair-empty-node-modules-links.mjs --apply  # 真正建链接
 */
import { readFileSync, existsSync, readdirSync, lstatSync, mkdirSync, rmdirSync, symlinkSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'deepseek-harness'))
const APPLY = process.argv.includes('--apply')

/** 极简 pnpm-lock importers 段解析：返回 { '<pkgDir>': { '<spec>': '<version>' } }。 */
function parseImporters(lockText) {
  const lines = lockText.split(/\r?\n/)
  let inImporters = false
  const out = {}
  let pkg = null
  let section = null
  let spec = null
  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) { inImporters = true; continue }
    if (inImporters && /^\S/.test(line)) break           // 下一个顶层键
    if (!inImporters) continue
    const mPkg = line.match(/^ {2}([A-Za-z0-9_./@-][^\s:]*):\s*$/)
    if (mPkg) { pkg = mPkg[1]; section = null; spec = null; out[pkg] ??= {}; continue }
    if (!pkg) continue
    const mSec = line.match(/^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/)
    if (mSec) { section = mSec[1]; spec = null; continue }
    const mSpec = line.match(/^ {6}'?([^':]+?)'?:\s*$/)
    if (mSpec && section) { spec = mSpec[1]; continue }
    const mVer = line.match(/^ {8}version:\s*(.+)$/)
    if (mVer && spec) { out[pkg][spec] = mVer[1].trim(); spec = null; continue }
  }
  return out
}

/** 找 workspace 包目录（含 package.json 且被 lockfile importers 收录）。 */
function workspacePkgs(importers) {
  return Object.keys(importers).filter((p) => existsSync(join(ROOT, p, 'package.json')))
}

/** 收集一个包 node_modules 下的空链接目录（scope 级或 name 级）。 */
function emptyDirs(pkgDir) {
  const nm = join(ROOT, pkgDir, 'node_modules')
  const found = []
  if (!existsSync(nm)) return found
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith('.')) continue
    const p = join(nm, entry)
    let st
    try { st = lstatSync(p) } catch { continue }
    if (!st.isDirectory() || st.isSymbolicLink()) continue
    let inner
    try { inner = readdirSync(p) } catch { continue }
    if (inner.length === 0) { found.push({ path: p, scope: entry, names: null }); continue }
    if (entry.startsWith('@')) {
      const emptyNames = []
      for (const name of inner) {
        const q = join(p, name)
        let st2
        try { st2 = lstatSync(q) } catch { continue }
        if (!st2.isDirectory() || st2.isSymbolicLink()) continue
        let sub
        try { sub = readdirSync(q) } catch { continue }
        if (sub.length === 0) emptyNames.push(name)
      }
      if (emptyNames.length > 0) found.push({ path: p, scope: entry, names: emptyNames })
    }
  }
  return found
}

/**
 * 在 .pnpm 下定位一个依赖的虚拟存储目录。
 *
 * 目录名在 Windows 上会被 pnpm 截断成 `<名字前缀>_<hash>`（长路径兜底），
 * 所以只按名字前缀匹配是不可靠的（实测 `@opentelemetry+otlp-exporter-base`
 * 被截成 `@opentelemetry+otlp-exporte_063bc33…`，连 `@0.220` 都没留下）。
 * 做法：用名字的前 12 个字符粗筛，再逐个读候选里 `node_modules/<spec>/package.json`
 * 的 `version` 与 lockfile 记录的裸版本**实测比对** —— 名字 + 版本双条件才是判据。
 */
function findVirtualStore(spec, version) {
  const bare = version.replace(/\(.*$/, '')                 // 去掉 (patch_hash=…)(…)
  const encoded = spec.replace('/', '+')
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm')
  let names
  try { names = readdirSync(pnpmDir) } catch { return [] }
  const rough = encoded.slice(0, 12)
  const hits = []
  for (const name of names) {
    if (!name.startsWith(rough)) continue
    const pkgJson = join(pnpmDir, name, 'node_modules', spec, 'package.json')
    if (!existsSync(pkgJson)) continue
    try {
      if (JSON.parse(readFileSync(pkgJson, 'utf8')).version !== bare) continue
    } catch { continue }
    hits.push({ name, path: join(pnpmDir, name, 'node_modules', spec) })
  }
  // 同一 spec 可能有多个副本：主副本的目录名（去掉 `@版本` 与 Windows 截断 hash 后）
  // 是该 spec 编码名的前缀，而别的包"内部捎带"的副本目录名是那个别的包的名字
  // （例：`@opentelemetry+otlp-exporte_063bc…` 里也有一份 otlp-transformer），据此区分。
  const baseOf = (name) => {
    const at = name.indexOf('@', 1)
    const withoutVersion = at === -1 ? name : name.slice(0, at)
    return withoutVersion.replace(/_[0-9a-f]{32}$/, '')
  }
  const own = hits.filter((h) => encoded.startsWith(baseOf(h.name)))
  return (own.length > 0 ? own : hits).map((h) => h.path)
}

/**
 * 由 lockfile 的 version 串推出该依赖在磁盘上的真实位置。
 * @returns {string|undefined} 目标绝对路径，无法确定时返回 undefined。
 */
function resolveTarget(pkgDir, spec, version) {
  if (version.startsWith('link:')) {
    const target = resolve(join(ROOT, pkgDir), version.slice('link:'.length))
    return existsSync(target) ? target : undefined
  }
  if (version.startsWith('file:') || version.startsWith('npm:')) return undefined
  const cands = findVirtualStore(spec, version)
  if (cands.length === 0) return undefined        // 未安装（多半是平台不匹配的可选依赖）
  if (cands.length > 1) {
    // 同 spec 多版本并存时无法只凭 major.minor 判定该指向哪一个，宁可不建
    // （建错版本比不建更危险），留给人判断。
    console.log(`  [??] ${pkgDir}: ${spec} 虚拟存储候选 ${cands.length} 个（跳过，需人工判断）`)
    return undefined
  }
  return cands[0]
}

const lockText = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
const importers = parseImporters(lockText)

const plan = []
for (const pkgDir of workspacePkgs(importers)) {
  const deps = importers[pkgDir]
  // 判据一：按依赖声明逐条检查包级 node_modules 是否真的解析得到。
  // （pnpm 漏建链接后目录可能已不存在，也可能留着一个空壳，两种都要修。）
  for (const [spec, version] of Object.entries(deps)) {
    if (spec.startsWith('node:')) continue
    const linkPath = join(ROOT, pkgDir, 'node_modules', spec)
    if (existsSync(linkPath)) continue
    const target = resolveTarget(pkgDir, spec, version)
    if (target === undefined) continue
    plan.push({ pkgDir, spec, link: linkPath, target })
  }
  // 判据二：空壳目录（scope 级为空，或 scope 下的某个 name 为空）。
  for (const hole of emptyDirs(pkgDir)) {
    const specs = hole.names === null
      ? Object.keys(deps).filter((s) => s.startsWith(`${hole.scope}/`))
      : hole.names.map((n) => `${hole.scope}/${n}`)
    for (const spec of specs) {
      const version = deps[spec]
      if (version === undefined) continue
      const linkPath = join(ROOT, pkgDir, 'node_modules', spec)
      if (existsSync(linkPath)) continue
      const target = resolveTarget(pkgDir, spec, version)
      if (target === undefined) continue
      plan.push({ pkgDir, spec, link: linkPath, target })
    }
  }
}

console.log(`空链接目录修复计划：${plan.length} 条${APPLY ? '（--apply，将实际创建）' : '（dry-run）'}`)
for (const p of plan) {
  console.log(`  ${p.pkgDir}\n    ${p.spec} -> ${relative(ROOT, p.target)}`)
}
if (!APPLY) {
  console.log('\n（加 --apply 真正创建 junction）')
  process.exit(plan.length > 0 ? 0 : 1)
}

let created = 0
for (const p of plan) {
  try {
    if (existsSync(p.link)) continue
    mkdirSync(dirname(p.link), { recursive: true })
    symlinkSync(p.target, p.link, 'junction')
    created += 1
  } catch (error) {
    console.log(`  [!!] ${p.pkgDir}: ${p.spec} 建链接失败 — ${error.message}`)
  }
}
console.log(`\n已创建 ${created} 个 junction`)
