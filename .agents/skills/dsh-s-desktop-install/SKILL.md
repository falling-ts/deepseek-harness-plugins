---
name: dsh-s-desktop-install
description: Use when installing a falling-ts plugin into the Desktop app (home ~/.dsh) and it keeps resolving to an old version, or icon/name fail to resolve after install. Covers pnpm 11 minimumReleaseAge 24h gate and the exact-version / exclusion workaround.
---

# 桌面版装插件总拿到旧版：pnpm 11 的 minimumReleaseAge 闸门

## 症状

桌面版（home `~/.dsh`）从 GUI 或 `dsh plugin add` 装 `@falling-ts/*`，无论重装几次、换不换 registry，都停在旧版本（实测 0.7.0 / 0.6.0），插件界面 **icon 与名称解析不出来**（静默回退到 package.json 的 `name`/`description`）；而 web home 用 `link:` 指向工作树，永远最新源码、元数据正常。别去查 registry——当时 npmmirror 与 registry.npmjs.org 的 `dist-tags.latest` 都已是最新。

## 根因

pnpm 11 默认启用供应链策略 **`minimumReleaseAge = 1440`（分钟，即 24 小时）**——发布不足 24 小时的版本**不会被解析选中**，不带版本的 `pnpm add <包>` 静默退回窗口外最新的那个版本。桌面应用内置正是 **pnpm 11.7.0**（`resources/runtime/pnpm`，版本记在 `versions.json`）；`app.asar` 里 grep 不到 `minimumReleaseAge`，DSH 代码不参与，1440 是 pnpm 自己的默认值（[pnpm 11.0 发布说明](https://pnpm.io/blog/releases/11.0)）。判据：两处直接可查——`%LOCALAPPDATA%\pnpm-cache\lockfile-verified.jsonl` 每次安装追加一条 `policy` 记录（含 `"minimumReleaseAge":1440`）并带 `verifiedAt`；同次安装的 pnpm 输出里有 `✓ Lockfile passes supply-chain policies`。实测当时 force-compact 0.7.2 发布 0.7 小时前、web-ding 0.6.1 发布 0.8 小时前（都被挡），而 0.7.0 / 0.6.0 刚过 26 小时——正好是窗口外最新可选版本。

## 解法（二者择一）

- **写死精确版本**（显式版本不受窗口限制，实测装上且"通过供应链策略"）：
  `dsh plugin --profile desktop add "@falling-ts/dsh-force-compact@0.7.2" "@falling-ts/dsh-web-ding@0.6.1" --registry=https://registry.npmjs.org/`
  注意 `pnpm remove` **不接受** `--registry=`（报 `[ERROR] Unknown option: 'registry'`，退出码 1 且什么都没做，别当成"卸载失败"）。
- **精确豁免**（推荐，与 DSH 对自研新发布包的处理一致）：在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: ['<包>@<版本>']`。只豁免列出的版本，其余仍受 24 小时窗口保护；不加豁免时锁文件里那条"太新"的 entry 在后续校验中仍可能被判不通过。

## 动手顺序（先备份）

`~/.dsh` 是用户主目录数据，先备份：`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` → `dsh plugin --profile desktop remove <两个包>`（`dsh.profile.bundles` 会自动回收）→ 删 `node_modules` 与 `pnpm-lock.yaml`（remove 之后 `node_modules\@falling-ts` 会留**空壳目录**，即"pnpm 链接空洞"那一类）→ 加豁免 → 精确版本重装。profile 的 `cordis.patch.yml` 是自己的调参（补丁层按包名引用），卸载不该也不必要改它；卸载到重装之间那两条 entry 会短暂悬空，重装即恢复。

## 校验不必碰 GUI

`node exploration/desktop-plugin-meta-probe.mjs [profileDir]` 按宿主 `readPluginMeta` 同一条路径复核 `exports['./locale/*.json']`、各语言 `meta.title`、顶层 `icon` 的存在与体积，退出码 0 才算元数据合格。

## 但 icon/名称要重启桌面应用才显示

该解析走 Node ESM 解析器，`@falling-ts/<包>/locale/*.json` 在旧版本里**不是** export，那次失败已被记忆化——DSH 的 `ParentRoutes.requests` 按请求串缓存解析路由，Node 也缓存 package.json 内容，且**生产路径里没有任何地方调用 `pluginPackages.replace()`**（全仓 grep：只有测试与它自己的定义），缓存与路由永不刷新。这与"装插件不必重启"（那条讲**激活**）**不矛盾**：本条讲**清单内容**（exports 表在这条路径上是进程级快照）。

## 相关技能

- `dsh-s-plugin-collection`：插件清单/exports 与规范评审。
- `dsh-s-server-run`：HMR 与清单快照的关系。
