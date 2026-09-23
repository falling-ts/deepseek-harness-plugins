# harness node_modules 适配性审计（2026-09-23）

对象：`D:\deepseek-harness-plugins\deepseek-harness`
- HEAD = `00102833dfaee1da9f48a3a8eae9d34005a75218`，tag `dsh-v0.1.7-alpha.2`
- 与 `origin/master` 差分 `0 0`（即正好在上游 master 尖端），子模块工作树干净
- 承载本 GUI 的 3080 与开发端口 3180 都由**这棵树**直接启动（`node --import tsx/esm apps/cli/src/bin.ts web`），所以下面的结论就是在跑的那份 node_modules

## 结论速览

| 问题 | 结论 | 依据（一句话） |
|------|------|----------------|
| node_modules 全部适配 harness 依赖声明吗 | **是** | 330 个工程 / 5534 条 dependencies+peers 边全部按 Node 解析规则命中且满足声明范围，0 缺失 0 越界 |
| 需要删除重新安装吗 | **不需要** | lockfile 与已安装快照逐字节一致 + `pnpm install --frozen-lockfile` 报 "Lockfile is up to date / Already up to date"；只在工作区图**之外**存在陈旧残留（可选定向清理） |
| 需要执行 update 吗 | **不需要** | 仓库侧已在上游尖端；依赖侧 `pnpm update` 只会让 checkout 偏离发布态，且 50 项可升项里含 koffi/sharp/esbuild/electron 等原生包 |

## 证据

### 1. lockfile ↔ 已安装快照：逐字节一致

pnpm 会把安装时用的 lockfile 快照留在虚拟存储里，可与仓库 lockfile 直接对比：

```
node_modules/.pnpm/lock.yaml  996882 bytes  SHA256 B86256BE…42C8D40
pnpm-lock.yaml                996882 bytes  SHA256 B86256BE…42C8D40   → 相同
```

即：当前 node_modules 就是从这份 `pnpm-lock.yaml` 装出来的。

### 2. `pnpm install --frozen-lockfile`（CI 模式，退出码 0）

```
Scope: all 330 workspace projects
✓ Lockfile passes supply-chain policies (verified 3h ago)
Lockfile is up to date, resolution step is skipped
Already up to date
packages/subprocess/subprocess-local postinstall: Done
. postinstall: Done
Done in 6s using pnpm v11.7.0
```

这一步同时证明了两件事：`pnpm-lock.yaml` 与全部 manifest 同步（否则 `ERR_PNPM_OUTDATED_LOCKFILE`），
且 node_modules 无需增删任何包。执行后子模块 `git status` 仍干净（未改 lockfile，未改工作树）。

### 3. 独立审计：不信 pnpm 的自我报告，按 Node 解析规则重走一遍

脚本：`exploration/node-modules-fit-audit.mjs`（结果 `exploration/nm-fit-audit.txt`）

```
workspace packages: 330        （= pnpm 报的 "all 330 workspace projects"）
dependency edges  : 5534       （dependencies + optionalDependencies + devDependencies + peerDependencies）
OK: every declared dependency/peer resolves from its own package and satisfies its range.
```

对每条边：从该包目录向文件系统根逐级尝试 `<dir>/node_modules/<spec>/package.json`，
用 `semver.satisfies(installed, declared, {includePrerelease:true})` 校验；
`workspace:*` 校验目标工程存在，`link:` 校验目标目录存在，`npm:`/git 别名跳过。

### 4. 插件 / profile 侧（这也是「适配 harness 依赖声明」的一部分）

- `~/.dsh/profiles/web/pnpm-lock.yaml` 与 `~/.dsh/profiles/web/node_modules/.pnpm/lock.yaml`
  **逐字节一致**（各 646 bytes），profile 侧同样无漂移；
  `autoInstallPeers: false`，三个插件是 `link:` 指向工作区源目录（junction 目标正确）。
- 三个插件的 peer 下界（基线 `>=0.1.7-alpha.1` / cordis `>=4.0.4` / schemastery `>=3.18.4`）
  对当前 checkout 实测全部满足：`vendor/cordis@4.0.4`、`vendor/schemastery@3.18.4`、
  `@deepseek-ai/dsh-*@0.1.7-alpha.2`。
- `node exploration/plugin-manifest-check.mjs` → 3 个 manifest 全部 `[OK]`。
- 运行时复核（`POST /api/pluginInventory/list`，3080）：186 个 entry，
  `@falling-ts/dsh-local-no-auth`、`@falling-ts/dsh-force-compact`、`@falling-ts/dsh-web-ding`
  三个 bundle 均 `enabled=true fiber=active`——整棵依赖图端到端可用。

### 5. 陈旧残留（唯一「不干净」的地方，但在依赖图之外）

`exploration/node-modules-link-integrity.mjs`（结果 `exploration/nm-link-integrity.txt`）：
15972 个目录、8604 个链接，其中 **26 个悬空 junction**。逐条核对后全部是**历史版本残留**，
不参与当前 330 个工程的解析：

| 位置 | 目标 | 性质 |
|------|------|------|
| `examples/node_modules/@deepseek-ai/dsh-acp-demo` 等 9 条 | `packages/examples/*`、`packages/e2b/*`、`packages/code-runtime/*`、`packages/workflow/*` 等 | `examples/` 已不是 workspace 成员（`pnpm-workspace.yaml` 无 examples glob），`examples/package.json` 不存在，目录里只剩 `node_modules` |
| `node_modules/.pnpm/node_modules/@deepseek-ai/*` 13 条 | 如 `dsh-tool-present → packages/fs/tool-present`（现址是 `packages/deliverables/tool-present`） | 改名/迁移后遗留的 hoist 别名 |
| `native/landlock-run/packages/entry/node_modules/@deepseek-ai/node-addon-landlock-run-linux-*` 2 条 | Linux 平台包 | Windows 上本就装不上 |
| `packages/session/session-persistence-jsonl/node_modules/{fs-ext,@types/fs-ext}` 2 条 | — | **两包既不在该包 manifest 也不在 lockfile**（grep 只命中 fs-extra），纯旧世代残留 |

关键点：`packages/examples`、`packages/e2b`、`packages/code-runtime`、`packages/settings/settings-file`
等目录在当前 HEAD 中**不存在或为空**，而 `examples/` 里只有残留的 junction 树
（`examples/node_modules/@deepseek-ai/* → vendor/*`、`packages/*`，彼此成环），
这也是 `git status --ignored` / `git clean -n` 扫到那些路径时会刷
`Filename too long` 警告的原因（git 会把 junction 当目录递归进 `vendor/hmr ↔ vendor/cordis` 的环）。

这些残留对解析零影响（见第 3 条 0 问题），只占盘、并在递归型工具下产生噪音。

## 关于 `pnpm update` 的取舍

`pnpm outdated -r`：**104 项**有更新版本（`exploration/nm-outdated-all.txt`）；
`pnpm outdated -r --compatible`（只列仍满足 package.json 范围的，即 `pnpm update` 不带 `--latest` 会做的事）：
**50 项**（`exploration/nm-outdated-compatible.txt`），例如

```
zod 4.4.3→4.6.5      tsx 4.22.4→4.23.15   vitest 4.1.8→4.1.11   ws 8.21.0→8.21.3
js-yaml 4.2.0→4.3.2  undici 8.10.0→8.10.2 yaml 2.9.0→2.9.1      picomatch 4.0.4→4.0.7
koffi 3.1.1→3.3.1    sharp 0.35.3→0.35.4  esbuild 0.28.1→0.28.2  electron 44.0.0→44.4.3
playwright 1.61.1→1.63.0                   lightningcss 1.32.0→1.33.0
```

不建议在此 checkout 上执行 `pnpm update`：

1. 这棵树 = 上游发布 tag + 已提交 lockfile；update 会让子模块变 dirty，
   `git status` 出现 lockfile 改动，移动子模块指针/发布前必须先还原。
2. `pnpm-workspace.yaml` 有供应链闸门（`minimumReleaseAge` + `allowBuilds` + `minimumReleaseAgeExclude`
   白名单）。update 会重新解析 → 必须重新过闸，且 koffi / sharp / esbuild / electron / playwright
   这些原生包会被重建（install 脚本只白名单了 esbuild/lefthook/node-pty/koffi 等）。
3. 收益为零：当前 0 缺失 0 越界，且 `Lockfile passes supply-chain policies`。
4. 想要新依赖，正路是等上游 bump 后 `git submodule update --remote`（当前已在上游尖端），
   而不是本地 `pnpm update`。

`dsh` 本身**没有** `update`/`upgrade` 自更新子命令：`apps/cli/src/args.ts` 只有默认 profile 运行、
`plugin`（转发 pnpm）、`dump-config`、`dump-config-schema` 四种模式。

## 残留清理（2026-09-23 已执行）

**不要**用 `Remove-Item -Recurse` 或 `git clean -xfd` 清这些残留：PowerShell 5.1 的
`Remove-Item -Recurse` 会**跟随 junction** 递归，而这些残留树里塞满了指向 `vendor/*`、`packages/*`
真实源码的 junction（`examples/node_modules/@deepseek-ai/*`），会删掉真源码；
`git clean` 也会顺着 junction 递归并报 `Filename too long`。

改用 `node exploration/residue-cleanup.mjs`（`lstat` 遍历，遇 reparse point 只摘链接、绝不下降；
每个根先断言 `git ls-files` 为空；默认干跑，`--apply` 才真删）：

```
node exploration/residue-cleanup.mjs            # 干跑
node exploration/residue-cleanup.mjs --apply    # 真删
```

已删除（全部为未跟踪残留）：

| 路径 | 内容 | 说明 |
|------|------|------|
| `examples/` | 3 文件 / 4 目录 / 111 链接（9 悬空） | `examples/` 已不是 workspace 成员，只剩旧安装树 |
| `packages/examples`、`packages/e2b`、`packages/code-runtime` | 各 1 个空目录 | 源文件在上游发布版已删除 |
| `native/landlock-run/` | 12 文件 / 10 目录 / 6 链接（2 悬空） | 真身已迁到 `native/system/packages/entry`（包名 `@deepseek-ai/node-addon-system@0.1.2`） |
| `packages/session/session-persistence-jsonl/node_modules/{fs-ext,@types/fs-ext}` | 2 悬空链接 | 两包既不在 manifest 也不在 lockfile |
| `node_modules/.pnpm/node_modules/@deepseek-ai/*` | 13 悬空 hoist 别名 | 改名/迁移后遗留 |
| `packages/{experimental/webworker-runtime,sandbox/sandbox-local,shell/bash-sandbox}/node_modules/@deepseek-ai/node-addon-landlock-run` | 3 悬空链接 | 指向已废弃的 `native/landlock-run` 路径；全仓无任何 manifest 声明该包名 |

清理后复核（全部通过）：

```
悬空链接          : 26 -> 0        (node exploration/node-modules-link-integrity.mjs)
依赖适配          : OK（330 工程 / 5534 边）
pnpm install --frozen-lockfile : Scope: all 330 workspace projects / Already up to date (678ms)
git status --short: 0 行；tracked files 13244 -> 13244（未丢任何跟踪文件）
vendor/cordis、packages/core/agent : 完好
```

## 复现命令

```
cd D:\deepseek-harness-plugins\deepseek-harness
$env:CI='true'; pnpm install --frozen-lockfile
node D:\deepseek-harness-plugins\exploration\node-modules-fit-audit.mjs
node D:\deepseek-harness-plugins\exploration\node-modules-link-integrity.mjs
pnpm outdated -r --format list              # 104 项
pnpm outdated -r --compatible --format list # 50 项（范围内可升）
node D:\deepseek-harness-plugins\exploration\plugin-manifest-check.mjs
```
