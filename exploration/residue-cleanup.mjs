#!/usr/bin/env node
// 安全清理 harness checkout 里「工作区依赖图之外」的历史残留。
//
// 为什么不直接用 Remove-Item -Recurse / syscall rm -rf：
//   本机 shell 是 Windows PowerShell 5.1，其 Remove-Item -Recurse 会**跟随 junction**
//   递归删除，而这些残留树里塞满了指向 vendor/* 与 packages/* 真实源码的 junction
//   （examples/node_modules/@deepseek-ai/*）。用它会删掉真实源码。
//   cmd 的 rd /s 与 Node 的 rimraf 语义更好，但为可审计起见，这里自己走 lstat：
//   遇到 reparse point（junction/符号链接）只摘链接本身，绝不下降。
//
// 用法：
//   node exploration/residue-cleanup.mjs            # 干跑，只列清单
//   node exploration/residue-cleanup.mjs --apply    # 真删
//   node exploration/residue-cleanup.mjs --apply --dangling-in node_modules/.pnpm/node_modules
//
// 安全闸门：
//   - 只允许删 HARNESS 根之内、且列在 ROOTS / 显式 dangling 扫描根内的路径；
//   - 每个 ROOT 先断言 git 未跟踪（`git ls-files` 为空）；
//   - 删除前后打印统计，删除后请自行复跑 node-modules-fit-audit.mjs 与 git status。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HARNESS = 'D:\\deepseek-harness-plugins\\deepseek-harness'
const APPLY = process.argv.includes('--apply')

// 残留根：源文件在上游发布版里已被删除，目录里只剩旧世代的 node_modules。
const ROOTS = [
  'examples',
  'packages\\examples',
  'packages\\e2b',
  'packages\\code-runtime',
  'native\\landlock-run',
]

// 额外的悬空链接扫描根（只删「目标不存在」的链接，真实链接一律保留）。
const danglingIn = []
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--dangling-in') danglingIn.push(process.argv[i + 1])
}
// 默认扫这两个已知有旧世代悬空链接的位置。
if (danglingIn.length === 0) {
  danglingIn.push(
    'packages\\session\\session-persistence-jsonl\\node_modules',
    'node_modules\\.pnpm\\node_modules',
  )
}

function guard(p) {
  const abs = path.resolve(p)
  const rootAbs = path.resolve(HARNESS)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`拒绝：路径在 harness 之外 -> ${abs}`)
  }
  return abs
}

function trackedUnder(rel) {
  try {
    const out = execFileSync('git', ['-C', HARNESS, 'ls-files', '--', rel], { encoding: 'utf8' })
    return out.split(/\r?\n/).filter(Boolean)
  } catch (e) {
    throw new Error(`git ls-files 失败（${rel}）：${e.message}`)
  }
}

function stats(p, acc, depth = 0) {
  let st
  try { st = fs.lstatSync(p) } catch { return }
  if (st.isSymbolicLink()) {
    let target = null
    try { target = fs.readlinkSync(p) } catch {}
    const exists = fs.existsSync(p)
    acc.links++
    if (!exists) { acc.broken++; acc.brokenList.push({ p, target }) }
    return // 绝不下钻 reparse point
  }
  if (st.isDirectory()) {
    acc.dirs++
    let entries = []
    try { entries = fs.readdirSync(p) } catch (e) { acc.errors.push(`${p}: ${e.code}`); return }
    for (const e of entries) stats(path.join(p, e), acc, depth + 1)
    return
  }
  acc.files++
  acc.bytes += st.size
}

// 收集删除顺序：先文件/链接，再目录（深度从深到浅）。
function collect(p, out) {
  let st
  try { st = fs.lstatSync(p) } catch { return }
  if (st.isSymbolicLink()) { out.links.push(p); return }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) collect(path.join(p, e), out)
    out.dirs.push(p)
    return
  }
  out.files.push(p)
}

function removeLink(p) {
  for (const fn of [
    () => fs.rmdirSync(p),
    () => fs.unlinkSync(p),
    () => fs.rmSync(p, { force: true }),
  ]) {
    try { fn(); return 'ok' } catch {}
  }
  return 'failed'
}

function rmTree(absRoot, label) {
  const out = { files: [], dirs: [], links: [] }
  collect(absRoot, out)
  let stat = 0
  if (APPLY) {
    for (const f of out.files) { try { fs.rmSync(f, { force: true }); stat++ } catch (e) { console.log(`  ! 文件删除失败 ${f}: ${e.code}`) } }
    for (const l of out.links) { const r = removeLink(l); if (r === 'ok') stat++ }
    // 目录按深度降序
    out.dirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
    for (const d of out.dirs) { try { fs.rmdirSync(d); stat++ } catch (e) { console.log(`  ! 目录删除失败 ${d}: ${e.code}`) } }
  }
  console.log(`${APPLY ? '已删除' : '将删除'} ${label}: 文件 ${out.files.length} / 目录 ${out.dirs.length} / 链接 ${out.links.length}` +
    (APPLY ? `（实际删除 ${stat}）` : ''))
  console.log(`  剩余存在？ ${fs.existsSync(absRoot) ? '是' : '否'}`)
  return out
}

console.log(`== harness: ${HARNESS}`)
console.log(`== 模式: ${APPLY ? 'APPLY（真删）' : 'DRY-RUN（干跑）'}\n`)

const acc = { files: 0, dirs: 0, links: 0, broken: 0, brokenList: [], bytes: 0, errors: [] }
let toDelete = 0

console.log('--- 1. 残留根（源文件已不存在，仅剩旧世代 node_modules）---')
for (const rel of ROOTS) {
  const abs = guard(path.join(HARNESS, rel))
  if (!fs.existsSync(abs)) { console.log(`跳过（不存在）: ${rel}`); continue }
  const tracked = trackedUnder(rel)
  if (tracked.length > 0) {
    console.log(`拒绝：${rel} 有 ${tracked.length} 个 git 跟踪文件，不是残留 -> 跳过`)
    continue
  }
  const sub = { files: 0, dirs: 0, links: 0, broken: 0, brokenList: [], bytes: 0, errors: [] }
  stats(abs, sub)
  console.log(`[未跟踪 ✓] ${rel}: 文件 ${sub.files} / 目录 ${sub.dirs} / 链接 ${sub.links}（其中悬空 ${sub.broken}）/ ${(sub.bytes / 1048576).toFixed(2)} MiB 常规文件`)
  for (const b of sub.brokenList.slice(0, 40)) console.log(`    - 悬空: ${path.relative(HARNESS, b.p)} -> ${b.target}`)
  for (const k of ['files', 'dirs', 'links', 'broken', 'bytes']) acc[k] += sub[k]
  acc.brokenList.push(...sub.brokenList)
  toDelete++
  rmTree(abs, rel)
}

console.log('\n--- 2. 悬空链接扫描（只摘目标不存在的链接）---')
const linkTargets = []
for (const rel of danglingIn) {
  const abs = guard(path.join(HARNESS, rel))
  if (!fs.existsSync(abs)) { console.log(`跳过（不存在）: ${rel}`); continue }
  const walk = (p) => {
    let entries = []
    try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(p, e.name)
      let st
      try { st = fs.lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) {
        if (!fs.existsSync(full)) {
          let target = null
          try { target = fs.readlinkSync(full) } catch {}
          linkTargets.push({ p: full, target })
        }
      } else if (st.isDirectory()) walk(full)
    }
  }
  walk(abs)
  console.log(`扫描 ${rel}`)
}
console.log(`发现悬空链接 ${linkTargets.length} 个`)
for (const t of linkTargets) {
  console.log(`  ${APPLY ? '摘除' : '待摘'}: ${path.relative(HARNESS, t.p)} -> ${t.target}`)
  if (APPLY) removeLink(t.p)
}

console.log('\n--- 汇总 ---')
console.log(`根目录: 计划处理 ${toDelete} 个；文件 ${acc.files} / 目录 ${acc.dirs} / 链接 ${acc.links}（悬空 ${acc.broken}）/ 常规文件 ${(acc.bytes / 1048576).toFixed(2)} MiB`)
console.log(`悬空链接: ${linkTargets.length}`)
if (acc.errors.length) console.log(`读取错误: ${acc.errors.slice(0, 5).join('; ')}`)
