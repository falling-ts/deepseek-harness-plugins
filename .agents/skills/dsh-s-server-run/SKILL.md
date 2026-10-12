---
name: dsh-s-server-run
description: Use when starting, restarting, or stopping the harness web instance on 3080, understanding the two DSH_HOME locations, or relying on hot-reload vs restart. Covers harness-server.sh behavior, the two homes, profile HMR, session write-lease conflicts, and session-level authorization for this workspace.
---

# 起停 web 实例 / 两个 home / HMR / 会话授权（dsh-s 约定）

## harness-server.sh（3080 = 本工作区默认开发实例）

- 用法：`bash harness-server.sh`（Linux 或 Windows Git Bash 均可）；环境变量覆盖：`PORT`（默认 `3080`）、`BIND_HOST`（默认 `127.0.0.1`）、`WAIT`（默认 `10` 秒；未命中视为启动失败退出非零，慢机可覆写 `WAIT=<秒>`）。
- **3080 可随时重启/停掉**。承载 GUI 的是**桌面应用**（`DeepSeek Harness.exe`，19387，home `~/.dsh`）；本工作区只有这一个 web 实例。
- 脚本第 1 步引导 profile 插件（`[1/4]`）：检查 `$DSH_HOME/profiles/web/package.json` 是否含四个工作区插件，缺了才 `dsh plugin --profile web add` 一次（`link:` 指向工作树，改源码即生效）。幂等、约 600ms。这一步不能省——web home 独立于桌面应用，没有它新 home 起出来是空 profile（免鉴权插件不在 → 浏览器报 authentication required）。脚本把 `[web] DSH_HOME / port / plugin src / log` 四行打到 stdout 供核对。
- `echo Y |` 前缀修复 pnpm 交互式重装提示（`Proceed? (Y/n)`）：后台进程无 stdin 时会永久挂死。
- 日志写入**脚本调用时的当前目录**：`dsh-web-<PORT>.log`（故根目录忽略 `*.log`）。

## ⚠️ 从 agent 的工具 shell 调脚本必须摘掉继承的 DSH_HOME

本会话 shell 由桌面应用派生，环境带 `DSH_HOME=C:\Users\<u>\.dsh`，脚本 `${DSH_HOME:-…}` 会照单全收 → 在**桌面应用的家**里建 `~/.dsh/profiles/web` 并按那个 home 起实例（正是"两个 home 串台"）。正确姿势：`bash -lc 'unset DSH_HOME; ./harness-server.sh'`（或 `DSH_HOME='C:/…/…'` 显式指定，Git Bash 里给 Node 用正斜杠 Windows 路径，别给 `/c/...`）。脚本打印的第一行 `[web] DSH_HOME = …` 是唯一判据，**先看它再往下走**。

## ⚠️ 脚本第 2 步 taskkill 可能被拒

受限 shell 里停不掉的进程，第 4 步端口探测会把**旧进程**当成"启动成功"（旧实例仍在监听、新进程绑定失败自行退出，却打了 `OK: port 3080 is up`）。判据：日志尾部有没有 `[ELIFECYCLE] Command failed with exit code 1`，以及 `netstat` 里 LISTENING 的 PID 是否变过。干净做法：换端口 + 换 home 起隔离验证实例（`PORT=3099 DSH_HOME='D:/…/.dsh-verify'`），与 3080 互不抢会话租约，验证完随手删。

## 两个 home，一个 host 一个

| home | 归属 | 谁在用 |
|------|------|--------|
| `~/.dsh` | 桌面应用（内置默认） | `DeepSeek Harness.exe`，也是 GUI 19387 |
| `~/.dsh-web` | `harness-server.sh` 的 web 实例 | 3080（默认开发实例） |

分开理由：**session 写租约**（单写者，内核级）——两个 host 共用 home 时后来者被 `session/writer-held` 拒掉，界面显示"当前会话已被占用"。

## 装插件不必重启运行中的实例（profile HMR）

`packages/boot/hmr/src/index.ts` 的 profile HMR 监视三样：profile 的 `package.json` 清单（只看 `dsh.profile.bundles` 是否变）、profile 自己的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`。任一变化即调 `reconcileProfilePatches` 进程内重新装配补丁层。所以 `dsh plugin --profile <p> add <包>` 写完清单瞬间，运行实例就热加载该插件（实测 3080 在 `add @falling-ts/dsh-local-no-auth` 后几秒内日志出现 `[dsh-local-no-auth] active: ...`，`/` 由 401 变 200）。"改 profile 要重启才生效"是**错的**；老笔记的 `patchReload: live` 在 0.2.0 源码已不存在，真正干活的是上面 HMR 监视器。

## 客户端 bundle 的 rev 跟着文件走（非 dev-only）

改完 `web/client.js` **不需要重启实例**，页面刷新即取新字节。机制在 `packages/client/hmr`（`fs.watchFile` 轮询 + `ctx.clientModules.rebuilt(id)`，`artifactRevision` 按文件元数据算 rev）——`harness-server.sh` 起的 3080 与线上 `pnpm dsh web --no-open` 实例都如此。"客户端半部改动要重启才生效"是**错的**；只有**清单内容**（exports/icon/locale 的解析表）才是启动期快照。

## 装到哪个 home 是常见坑

`dsh web` 的 profile 目录是 `$DSH_HOME/profiles/web`。两个 host 各一个 home。若手工 `pnpm dsh web` 时 `DSH_HOME` 指到别处（继承机器级 `DSH_HOME=~/.dsh`），那里是全新空 `web` profile（无任何插件）→ 浏览器报 `dsh web authentication required; reopen the URL printed by dsh web`（免鉴权插件不在），且因落在桌面版家，左栏出现桌面版会话列表与账号（工作区根残留的 `.dsh-home/` 正是这种空 profile 现场，别照它起服务）。排查第一步确认实例用哪个 home：`netstat -ano | findstr :<port>` 拿 PID，再看 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`；对照 `~/.dsh-web` / `~/.dsh` 两个 `sessions/` 目录能立刻看出串没串台。

## 会话级授权（本工作区约定，长期生效）

- 用户在**本工作区**授予：开发过程**无需逐步请示**直接推进；遇到多选一**默认采用推荐方案**并在结果标注所选为何；仅在不可逆/破坏性动作（推送、删除、改用户主目录数据）前简短说明。
- **文件沙箱策略：本会话 `danger-full-access`**（不受限读写）；审批弹窗已禁用——需审批的动作会被自动拒绝，因此**不要**发起 `sandbox_permissions` 升级，直接执行。
- 配套经验：预设平面晚挂载（`agent-presets:*` 提供的 `fs`/`compaction` 等服务在插件 boot-time `ctx.effect` 之后才就位；启动期 `ctx.get('fs')` 恒为 `undefined` → 依赖这些服务的副作用应惰性幂等安装 `ensureXxx(ctx)`，进程内闩锁保证至多一次）。顶层 `tool-fs`/`compaction-basic` 标 disabled ≠ 服务缺失（`agent-presets:` 前缀的常 enabled+active，运行时 `ctx.get` 走后者）。受沙箱 `fs` 服务有 workspace 围栏（`workspace-write` 模式拒写 workspace 外绝对路径）；要写共享用户主目录（`~/.dsh/logs/…`）改用 Node 原生 `import('node:fs/promises')` 直写绝对路径绕开围栏。跨用户可移植路径：绝不硬编码 `C:\Users\<x>\…`，默认用 `~/…` 模板经 `node:os.homedir()`（Windows 读 `USERPROFILE`）解析。

## 相关技能

- `dsh-s-pnpm-build`：起实例的构建/前台跑细节、删除保护。
- `dsh-s-plugin-collection`：插件清单/补丁层变化走 HMR 的机制背景。
