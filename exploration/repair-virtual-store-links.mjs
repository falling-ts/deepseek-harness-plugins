/**
 * repair-virtual-store-links.mjs — 修复 pnpm 虚拟存储（node_modules/.pnpm）内部漏建的依赖链接。
 *
 * 背景（2026-09-29，harness 0.1.7-alpha.2 → 0.2.0-rc.1，pnpm 11.7.0 / Windows）：
 * `pnpm install` 报成功，但 `.pnpm/<包>/node_modules/` 下**大量依赖链接没建出来**。
 * 例：`node_modules/.pnpm/got@14.6.6/node_modules/` 只剩 `@sindresorhus` 与 `got` 两项，
 * 其 15 个依赖（含 `p-cancelable`）全缺 —— 于是 `got` 的 `CancelableRequest extends
 * PCancelable` 解析不到，`tsc -b` 报 TS2339（`request.cancel` / `response.statusCode`
 * / `response.body` 不存在）。包级链接由姊妹脚本 repair-empty-node-modules-links.mjs 修。
 *
 * 本脚本按 pnpm-lock.yaml 的 `snapshots:` 段自己算每条边：
 *   1. 扫 `.pnpm/*`，用「目录名以该包编码名前辍开头」判定每个目录装的是哪个包，
 *      再读它的 package.json 拿版本 —— 目录名在 Windows 长路径下会被 pnpm 截断成
 *      `<名字前缀>_<32位hash>`（版本都可能被截没），所以不能只靠目录名解析版本。
 *   2. 对每个目录，取 lockfile 里 `spec@version` 对应的 snapshot（带 peer 后缀的
 *      `spec@version(peer@x)` 也算），读它的 dependencies / optionalDependencies。
 *   3. 逐条检查 `.pnpm/<目录>/node_modules/<依赖>` 是否存在；不存在就指向该依赖自己
 *      的虚拟存储目录（同 spec 同版本；多候选时优先"无 peer 后缀"的那份主副本）。
 *
 * 未安装的可选依赖（平台不匹配等）会被跳过，不计入缺失。
 *
 * 用法：
 *   node exploration/repair-virtual-store-links.mjs          # dry-run
 *   node exploration/repair-virtual-store-links.mjs --apply  # 真正建 junction
 */
import { readFileSync, existsSync, readdirSync, lstatSync, mkdirSync, rmdirSync, symlinkSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'deepseek-harness'))
const PNPM_DIR = join(ROOT, 'node_modules', '.pnpm')
const APPLY = process.argv.includes('--apply')
const encode = (spec) => spec.replace('/', '+')

/** 读一个目录下的叶子包路径：scope 目录要展开一层，否则 `@algolia` 会误匹配。 */
function leafSpecs(nmDir) {
  const out = []
  let entries
  try { entries = readdirSync(nmDir) } catch { return out }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      let subs
      try { subs = readdirSync(join(nmDir, entry)) } catch { continue }
      for (const sub of subs) {
        if (sub.startsWith('.')) continue
        out.push(`${entry}/${sub}`)
      }
    } else {
      out.push(entry)
    }
  }
  return out
}

function readVersion(pkgJsonPath) {
  try { return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version } catch { return undefined }
}

/** 扫虚拟存储：得到 { dirName -> { spec, version } } 与 { 'spec@version' -> [dirName] }。 */
function indexVirtualStore() {
  const byDir = new Map()
  const bySpecVersion = new Map()
  const dirs = readdirSync(PNPM_DIR).filter((d) => !d.startsWith('.'))
  for (const dir of dirs) {
    const nm = join(PNPM_DIR, dir, 'node_modules')
    if (!existsSync(nm)) continue
    const leaves = leafSpecs(nm)
    // 目录名（去掉 peer 后缀 / 截断 hash 后）以"该包编码名"开头的那个叶子，就是本目录装的包
    let best = null
    for (const spec of leaves) {
      const enc = encode(spec)
      if (!dir.startsWith(enc)) continue
      if (best === null || enc.length > best.enc.length) best = { spec, enc }
    }
    if (best === null) continue
    const version = readVersion(join(nm, best.spec, 'package.json'))
    if (version === undefined) continue
    byDir.set(dir, { spec: best.spec, version })
    const key = `${best.spec}@${version}`
    const list = bySpecVersion.get(key)
    if (list) list.push(dir)
    else bySpecVersion.set(key, [dir])
  }
  return { byDir, bySpecVersion }
}

/** 极简解析 lockfile 的 snapshots 段：{ 'spec@version': { dep: version } }。 */
function parseSnapshots(lockText) {
  const lines = lockText.split(/\r?\n/)
  let start = lines.findIndex((l) => l === 'snapshots:')
  if (start === -1) throw new Error('lockfile 里找不到 snapshots: 段')
  const out = {}
  let key = null
  let section = null
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\S/.test(line)) break                                  // 下一个顶层段
    // 键必须顶在第 2 列且首字符非空白，否则 `    dependencies:` 这类 4 空格行也会被当成键
    const mKey = line.match(/^ {2}'?(\S.*?)'?:\s*(\{\s*\})?\s*$/)
    if (mKey) {
      key = mKey[1]
      section = null
      out[key] = {}
      continue
    }
    if (!key) continue
    const mSec = line.match(/^ {4}(dependencies|optionalDependencies):\s*$/)
    if (mSec) { section = mSec[1]; continue }
    if (/^ {4}\S/.test(line)) { section = null; continue }       // transitivePeerDependencies 等
    if (section === null) continue
    const mDep = line.match(/^ {6}'?([^':]+?)'?:\s*([^\s].*)$/)
    if (mDep) out[key][mDep[1]] = mDep[2].trim()
  }
  return out
}

/** 取某目录应装的依赖表：优先精确 key，再取所有 peer 变体的并集。 */
function depsOf(snapshots, spec, version) {
  const exact = `${spec}@${version}`
  const keys = snapshots[exact] !== undefined
    ? [exact]
    : Object.keys(snapshots).filter((k) => k.startsWith(`${exact}(`))
  const merged = {}
  for (const k of keys) Object.assign(merged, snapshots[k])
  return { keys, merged }
}

/** 选依赖该指向的虚拟存储目录：同 spec 同版本，优先"无 peer 后缀"的主副本。 */
function pickTarget(bySpecVersion, spec, version) {
  const cands = bySpecVersion.get(`${spec}@${version}`)
  if (cands === undefined || cands.length === 0) return undefined
  const plain = `${encode(spec)}@${version}`
  const exact = cands.find((d) => d === plain)
  if (exact !== undefined) return exact
  const prefixed = cands.filter((d) => d.startsWith(`${plain}(`) || d.startsWith(`${plain}_`))
  return (prefixed.length > 0 ? prefixed[0] : cands[0])
}

const { byDir, bySpecVersion } = indexVirtualStore()
const snapshots = parseSnapshots(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'))

const plan = []
const stats = { dirs: 0, edges: 0, missing: 0, noSnapshot: 0, unresolved: 0 }
for (const [dir, own] of byDir) {
  stats.dirs += 1
  const { merged } = depsOf(snapshots, own.spec, own.version)
  if (Object.keys(merged).length === 0) { stats.noSnapshot += 1; continue }
  for (const [depSpec, depVersion] of Object.entries(merged)) {
    stats.edges += 1
    const linkPath = join(PNPM_DIR, dir, 'node_modules', depSpec)
    if (existsSync(linkPath)) continue                 // 存在就不管（哪怕是空壳，另行处理）
    const targetDir = pickTarget(bySpecVersion, depSpec, depVersion)
    if (targetDir === undefined) { stats.unresolved += 1; continue }
    plan.push({ dir, depSpec, link: linkPath, target: join(PNPM_DIR, targetDir, 'node_modules', depSpec) })
    stats.missing += 1
  }
}

console.log(
  `虚拟存储：${stats.dirs} 个目录 | 检查 ${stats.edges} 条边 | 缺失 ${stats.missing} 条` +
  ` | 无 snapshot ${stats.noSnapshot} | 依赖未安装 ${stats.unresolved}`
)
console.log(`${APPLY ? '（--apply，将实际创建）' : '（dry-run）'}`)
for (const p of plan.slice(0, 40)) console.log(`  ${p.dir}\n    ${p.depSpec} -> ${relative(PNPM_DIR, p.target)}`)
if (plan.length > 40) console.log(`  … 另有 ${plan.length - 40} 条`)
if (!APPLY) {
  console.log('\n（加 --apply 真正创建 junction）')
  process.exit(0)
}

let created = 0
for (const p of plan) {
  try {
    if (existsSync(p.link)) {
      // 空壳目录（pnpm 的另一半症状）：删掉重建
      let st = lstatSync(p.link)
      if (st.isDirectory() && !st.isSymbolicLink() && readdirSync(p.link).length === 0) rmdirSync(p.link)
      else continue
    }
    mkdirSync(dirname(p.link), { recursive: true })
    symlinkSync(p.target, p.link, 'junction')
    created += 1
  } catch (error) {
    console.log(`  [!!] ${p.dir}: ${p.depSpec} 建链接失败 — ${error.message}`)
  }
}
console.log(`\n已创建 ${created} 个 junction`)
