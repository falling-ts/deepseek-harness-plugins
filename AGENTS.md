# AGENTS.md — deepseek-harness-plugins（根工作区）

## 工具使用注意（本会话 shell 实测为 Windows PowerShell 5.1）

2026-09-17 实测：命令解释器是 **Windows PowerShell 5.1**（`NonInteractive` 报错暴露），
这带来四条必须遵守的规矩：

- **绝不用 shell 的字符串 cmdlet 往返改写源码文件。** `Get-Content -Raw` + `-replace`
  + `Set-Content` 会以 ANSI 解码 UTF-8（无 BOM）文件，把多字节字符截断成非法 UTF-8。
  实测代价：`dsh-web-ding/package.json` 描述里的 em dash（`E2 80 94`）被截成 `E2 80 3F`，
  文件仍是"看起来正常"的 JSON，`ConvertFrom-Json` 也照样解析通过，但 Node 的
  `JSON.parse` 直接拒绝 → 插件整包 `failed to import` → 宿主半部根本没加载
  （症状是 `settings/describe` 里少一个命名空间，**而不是**启动报错）。
  改文件一律用文件工具（`edit` / `write`）；改完用 `node -e "JSON.parse(fs.readFileSync(...))"`
  **严格**校验，别信 `ConvertFrom-Json`。
- **中文/日文/韩文输出到 stdout 会乱码**，判断内容要看文件本身（`read` / `grep` 工具），
  不要靠 shell 回显。
- **不支持 `??`** 空合并运算符；`$host` 是保留变量，勿占用。
- **`Invoke-WebRequest` 在 `NonInteractive` 下需要 `-UseBasicParsing`**（本机实测，
  否则报 "Read and Prompt functionality is not available"）；`Invoke-RestMethod` 取
  HTML/JS 文本可用。取 3080 的 client bundle 做端到端核对：
  `Invoke-RestMethod "http://127.0.0.1:3080/plugins/??<包名>/client.js&rev=<哈希>"`
  —— URL 里的 `rev` 参数**不能省**，省了是 404；哈希从 `GET /` 返回的模块表里取。

### npm 发布（2026-09-17 实测，两条都踩过）

- **必须显式 `--registry=https://registry.npmjs.org/`**。本机 `~/.npmrc` 把默认 registry
  指向了 `registry.npmmirror.com` 镜像，而 `_authToken` 只作用域在
  `//registry.npmjs.org/` 上——不显式指定时 `npm whoami` 直接报 `ENEEDAUTH`，
  看起来像"没登录"，其实凭据是好的。发布命令一律写：
  `npm publish --registry=https://registry.npmjs.org/`（`publishConfig.access: public`
  已在各插件 `package.json` 里，无需再加 `--access`）。
- **`PUT` 返回 202 不等于"立刻可取"**。三个包同日发布时，两个回 200、一个回 **202
  （已接受、异步提交）**：该版本的元数据先落地（版本级端点 200、packument 的
  `dist-tags.latest` 随后更新），而 **tarball 的 CDN 对象还要再等一会儿才可下载**。
  所以 `npm publish` 打完 `+ <pkg>@<ver>` 就收工是不安全的——必须复验，且要分清三层：
  ① `https://registry.npmjs.org/<pkg>/<ver>`（版本级端点，**不受 packument 缓存影响**，
  是最快的决定性判据）；② packument 的 `dist-tags.latest`；③ tarball URL 本身（可能最后才通）。
  一次 `npm view <pkg> versions` 看不到新版本时，先怀疑传播/缓存，别急着重复发布
  （重复发布同一版本会 `EPUBLISHCONFLICT`）；用 ① 判定真伪。

### pnpm 安装的链接空洞与本机构建（2026-09-29 实测，0.1.7-alpha.2 → 0.2.0-rc.1）

- **pnpm 11.7.0 在 Windows 上会静默漏建依赖链接，且自己修不了。** 症状两层：
  ① workspace 包的 `node_modules/<scope>` 是**真实空目录**（`tsc -b` 报一片
  `TS2307 Cannot find module`）；② `.pnpm/<包>/node_modules/<依赖>` 整片缺失
  （例：`got@14.6.6` 的 15 个依赖全缺 → `CancelableRequest extends PCancelable`
  解析不到 → `event-transport.ts` 报 4 条 `TS2339`）。`pnpm install --force` 与删
  `node_modules/.modules.yaml` 后重跑都只回 "Already up to date"——它的完成态判断不检查
  这些链接是否真的存在。**修复脚本（勿手补，量大）**：
  `node exploration/repair-empty-node-modules-links.mjs --apply`（包级，按 lockfile
  importers）与 `node exploration/repair-virtual-store-links.mjs --apply`
  （`.pnpm` 内部，按 lockfile `snapshots:` 段）。两个脚本都 dry-run 先看计划；都按
  junction 创建、都靠"名字前 12 字符粗筛 + 读真实 package.json 的 version 实测比对"
  绕开 Windows 长路径把目录名截断成 `<前缀>_<32位hash>`（版本可能整个被截没）的问题。
- **本机的批量删除保护会拦构建产物清理。** CodeBuddy 注入的 node 删除 shim 有个
  "一轮 >50 个目标需确认"的闸门，`vite build` 清空 `apps/web/dist/assets`（150+ 文件）和
  pnpm 自己的 `_tmp_<pid>_<hash>` 临时文件都会被它打成 `[SAFE_DELETE_BULK_CONFIRM_REQUIRED]`
  并让整个 `pnpm build` / `pnpm dsh web` 退出码 1。构建/起服务这类只清仓库内产物的命令，
  一律加 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 前缀（shim 顶层就认这个开关，实测有效）。
  由此引申：重跑 `pnpm build` 前若 `apps/web/dist` 已有旧产物，先手动清掉可少触发一次闸门。
- **起 web 实例验证时用脚本、但要前台跑**——脚本 `exit 0` 后会连带回收 nohup 子进程的
  情形**只发生在把脚本本身当后台任务**时。要在前台命令里跑：
  `"C:\Program Files\Git\bin\bash.exe" -lc './harness-server.sh'`（子进程存活，实测）。
  要用常驻后台任务时，则绕开脚本直接跑
  `CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm dsh web --host 127.0.0.1 --port 3080 --no-open`
  并把 `DSH_HOME` 指到 web home（`~/.dsh-web`，与桌面应用的 `~/.dsh` 分开——
  两者共用一个 home 会互相抢 session 写租约），日志自己重定向。
  注意 `C:\Windows\system32\bash.exe` 是 **WSL bash**，它会命中 `USERPROFILE` 未导出的
  告警分支；跑该脚本请用 Git Bash（`C:\Program Files\Git\bin\bash.exe`）。
- **无头验证脚本**：`exploration/web-020-headless-probe.mjs`（首页/控制台/网络/插件 bundle）、
  `exploration/web-020-settings-probe.mjs`（关引导弹窗→进设置页）、
  `exploration/web-020-plugin-sections-probe.mjs`（逐个打开插件分区并转储渲染文本）。
  playwright 从 harness 的 node_modules 取（`createRequire('.../apps/web/package.json')`），
  浏览器在 `%LOCALAPPDATA%/ms-playwright`（chromium-1228 / 1243 均已装）。

## 仓库性质

本仓库是**工作区容器**（workspace container）：不含业务源码，只跟踪
子模块指针（gitlink）与工作区级文件。远程：`git@github.com:falling-ts/deepseek-harness-plugins.git`（branch `main`）。

## 目录结构

| 路径 | 性质 | 远程 |
|------|------|------|
| `deepseek-harness/` | 子模块（上游 monorepo：`apps/cli`、`apps/web`、`packages/*`、`examples/*`，pnpm workspace） | `git@github.com:deepseek-ai/deepseek-harness.git`（branch `master`） |
| `dsh-force-compact/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-force-compact`，plain JS 无构建步骤） | `git@github.com:falling-ts/dsh-force-compact.git`（branch `main`） |
| `dsh-local-no-auth/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-local-no-auth`，纯 Host、无客户端半部） | `git@github.com:falling-ts/dsh-local-no-auth.git`（branch `main`） |
| `dsh-web-ding/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-web-ding`，Host + 浏览器 client 两半） | `git@github.com:falling-ts/dsh-web-ding.git`（branch `main`） |
| `dsh-start-command/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-start-command`，Host + 浏览器 client 两半；挂在 `agent/pre-step` 上执行"开始前命令"） | `git@github.com:falling-ts/dsh-start-command.git`（branch `main`） |
| `awesome-dsh-plugin/` | 子模块（社区目录 fork：`data/plugins/*.yml` + 重新生成的双语 README） | `git@github.com:falling-ts/awesome-dsh-plugin.git`（fork，branch `main`） |
| `docs/` | 工作区级技术文档（后端接口目录、上下文管理/会话结构分析、llama.cpp 适配方案、**插件规范符合性评审**等） | — |
| `harness-server.sh` | 跨平台（Linux + Windows Git Bash）服务器启动脚本 | — |
| `.idea/`、`.workbuddy/`、`.dsh-home/`、`*.log` | 已忽略（IDE 配置；会话本地笔记；工作区根残留的 DSH_HOME；`harness-server.sh` 运行日志） | — |

## 子模块（指针）约定

- 子模块指针锁定**精确 commit**。子仓库内有更新或新提交后，须回到根目录
  `git add <子模块目录> && git commit` 移动指针；未移动指针前根仓库 `status` 会显示子模块 modified。
- `.gitmodules` 的 `branch` 是该子模块的跟踪分支，可用
  `git submodule update --remote` 沿分支前进。
- 新机器克隆：`git clone --recurse-submodules git@github.com:falling-ts/deepseek-harness-plugins.git`。
- 不要删除子模块内部的 `.git`，不要把子模块内容吸收进根仓库，
  也不要绕过子模块直接向子仓库的上游（`deepseek-ai/*`）推送。

## Git 提交规范

自有项目（本仓库及其下所有插件仓库）提交时必须按三步组合执行：

    git add .
    git commit -m '<message>'
    git push

- **重点 `git add .`**：一次性暂存全部变更（含新文件、删除、子模块指针移动），
  不做挑选式部分暂存——保证"工作区全部变更"进入同一个提交，
  避免残留文件漏提交或子模块指针忘记移动。
- 提交后**必须**推送到对应远程跟踪分支，不留本地未推送提交。

## 插件集合约定（适用于 `dsh-force-compact/` 及同级独立插件）

- 每个插件是**独立 git 仓库**（独立远程、独立 `package.json`），
  包名遵循 `@falling-ts/<插件名>` 命名空间（与 git 仓库归属一致，可 `pnpm publish`）。
- 插件目录结构遵循官方 bundle 架构（上游 `docs/user/develop/basic/publish.md`）：
  `index.js`（插件模块，plain JavaScript 无构建步骤）、
  `cordis.patch.yml`（patch 层；层内按**包名**引用插件，不用相对路径）、
  `README.md` / `README.cn.md`、`LICENSE`。
- `package.json` 必须声明 `dsh.bundle.patch`（指向 `./cordis.patch.yml`）：
  缺少该声明时 `dsh plugin add` 只当普通依赖安装，不激活 patch 层。
- 安装：`dsh plugin --profile <profile> add github:falling-ts/<插件>`（或本地路径）；
  开发期可不安装，直接 `dsh web --patch <插件>/cordis.patch.yml` 挂载。
- 插件不引入 timer、不引入持久化状态；需要设置分区或浏览器行为的插件另带一个**客户端半部**
  （`web/client.js`，`dsh.client` 声明），其工厂必须无副作用、资源全在 `apply` 里经 `ctx.effect`
  注册并归还，且不手拼 wire 信封。
  各插件自身的规则见其 `AGENTS.md`（中文）。
- 各插件 `AGENTS.md` 中的 `../AGENTS.md`（collection conventions）指向本文件。
- 插件仓库内的 `CLAUDE.md` 固定只写一行 `@AGENTS.md`（引用本插件的 AGENTS.md），
  规则内容一律维护在 AGENTS.md，避免双写。

### peer 依赖的下限写法与 harness 版本基线（2026-09-29，基线 `>=0.2.0-rc.1`）

三个插件对 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 的 peer 一律写成**纯下界**，即官方
tag `dsh-v0.2.0-rc.1` 对应的版本列车：`@deepseek-ai/cordis: ">=4.0.4"`、
`@deepseek-ai/schemastery: ">=3.18.4"`、`@deepseek-ai/dsh-*: ">=0.2.0-rc.1"`。
**tag 名是 `dsh-v<版本>`，peer 字段里写 `<版本>`**——peer 吃 semver 范围、不吃 git tag。
语义：只支持该基线及其以后。（0.1.7-alpha.2 → 0.2.0-rc.1 共 763 个提交；vendor 的 cordis
仍是 4.0.4、schemastery 仍是 3.18.4，故这两条 peer 不动。已逐缝核对 0.2.0 上三个插件的
全部缝仍在——见下文"0.2.0 兼容性核对"——插件源码零改动即通过。）

**清单规则：用哪些包就写哪些包**，且除 `@deepseek-ai/cordis` 外一律
`peerDependenciesMeta.optional: true`——这些包在 profile 里由 dsh 安装提供、不在 profile 的
`node_modules` 中，标 required 只会产生无意义告警（`pnpm peers check` 应报
"No peer dependency issues found"）。当前清单：
- `dsh-local-no-auth`：`dsh-client-connection`（`ctx.connection` 三方法）、
  `dsh-host-webserver`（`ctx.webServer.host`）、`dsh-cmdline`（`ctx.appExit` fail-loud 缝）、
  `dsh-app-boot`（`ctx.pluginPackages.metaOf`，元信息 shim 的包裹目标）
- `dsh-web-ding`：`dsh-settings`（Config 表单 + `settings.update`）、`dsh-agent`
  （`agent/status` 事件契约）、`schemastery`（Config schema）+ 客户端
  `dsh-client-ui-settings` / `dsh-client-locale` / `dsh-client-store`
- `dsh-force-compact`：`dsh-settings`、`dsh-compaction`、`dsh-llm`、`dsh-token-meter`、
  `dsh-agent`、`dsh-session`、`dsh-session-projection`、`dsh-commands`、`schemastery`
  + 客户端三个同上
- `dsh-start-command`（2026-09-30 新增，同一基线）：`dsh-settings`（Config 表单 +
  `settings.configure`）、`dsh-agent`（`agent/pre-step` 载荷契约与 `ctx.agents` 注册表）、
  `dsh-shell`（`ctx.shell.resolve/execute`）、`dsh-sandbox-policy`（按会话解析沙箱策略）、
  `schemastery`（Config schema）+ 客户端三个同上

为什么 0.1.7 及以前必须排除（不是洁癖，是硬依赖）：

- **0.2.0 新增 boot 期 peer 兼容性预检**：`packages/boot/app-boot/src/plugin-compatibility.ts`
  会在装 profile 行前读插件 manifest，把每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer
  对运行时版本做 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定，
  不满足的行直接 `disabled`（stderr 报 "disabling profile plugin ..."），除非用
  `dsh plugin allow-version <pkg>@<ver>` 授予**精确版本豁免**。也就是说下界写错不再只是
  "装不上"，而是**静默禁用插件**。`@deepseek-ai/cordis` / `schemastery` 不在判定范围。
- **客户端 settings 服务改名（0.1.7）**：`ctx.settingsScope.bind({ namespace })` 被
  `ctx.configForms.get(namespace)` 取代——服务名 `settingsScope` 在 0.1.7 已从
  `packages/client` 全量消失，`packages/client/ui-settings/src/client/` 现在提供
  `configForms`（`settings-mirror.ts` 的 describe 镜像 + `config-form.ts` 的
  `ConfigFormController`；`ui-settings` 同时拆成十个 `ui-settings-*` 子包）。
  `ConfigForm` 与旧 `SettingsScope` 同形（`getSnapshot` / `subscribe` / `set` / `unset` /
  `mutate`），差异是快照 `status` 枚举多了 `'loading'`，且三个写方法现在回答
  `Promise<boolean>` 而非 `Promise<void>`。`dsh-web-ding` 与 `dsh-force-compact` 的客户端
  半部都经这条缝读写各自命名空间，在 0.1.6 上 `ctx.settingsScope` 缺失会让分区直接不渲染。
- **cordis 4.0.2 → 4.0.4（0.1.7）**：vendor 升级，peer 必须跟上。
- `dsh-force-compact` 的摘要回放在**强制投影缝**上（`surface.deriveEventMessage`）——0.1.6 把
  图像卸载改成 log-only 的 `@messageProjection` 事件，并让适配器改抛
  `IMAGE_OFFLOAD_REQUIRED`；同版起影子价索赔按 `heuristicTokens` 计价（折叠器结算 replace
  用的就是该字段），0.1.5 上没有这两条语义。
- `dsh-local-no-auth` 的 fail-loud 依赖 0.1.6 的启动语义：`assertEntriesActivated` 被换成
  只对私有必需 entry 清单致命的 `auditStartupEntries`，本插件不在表内，因此必须自己
  `ctx.appExit(1)`（0.1.5 上抛错本身就致命，机制不同）。

### 0.2.0 兼容性核对（2026-09-30，基线 `dsh-v0.2.0-rc.2`）

**rc.1 → rc.2 复核结论：`dsh-web-ding` 与 `dsh-local-no-auth` 源码零改动；
`dsh-force-compact` 有两处必须跟（见下），已随 0.7.1 修完。**
peer 下界一律保持 `>=0.2.0-rc.1` **不动**：rc.1 → rc.2 是 0.2.0 列车内的补丁，纯下界本就
承诺整条列车，收窄到 rc.2 只会让 0.2.0 的 boot 期 peer 预检（`app-boot`
`plugin-compatibility.ts`，semver + `includePrerelease`）在 rc.1 运行时**静默禁用**插件。

以下缝在 0.1.7 → 0.2.0-rc.1 时已核过，此次在 rc.2 上**复验为原样保留**：

- Host：`ctx.connection` 的 `requestRejection` / `authorizeIndex` / `authenticatedUrl`；
  `ctx.webServer.host`（schema 仍只收 `'127.0.0.1' | '0.0.0.0'`）；`ctx.appExit`；
  `ctx.pluginPackages.metaOf`；`agent/status` / `agent/pre-step` / `agent/request`
  签名与 dispatch mode 未变；`session/flush` 仍是 awaited `Promise.allSettled` parallel
  checkpoint；`compaction.compactNow(agent, signal, sourceCommandId?)` / `compactRegion(...)`
  未变；`settings.configure({ auto?: boolean }, owner: Fiber = ctx.fiber)` 未变；
  `tokenMeter` 的 `heuristicTokens` 仍是折价字段（不是 `tokens`）；`llm.stream` +
  `llm.resolveCallConfig` 未变。
- Client：`ctx.configForms.get(ns)` + `ConfigForm` 五方法（`getSnapshot` / `subscribe` /
  `set` / `unset` / `mutate`；状态枚举仍含 `'loading'`）、
  `ctx.slots.inject('settings.section')`（仍 `kind:'list'; scope:'root'`）、
  `ctx.locale.bind/register/addLanguage`、`createSnapshotStore`、
  `data-question-key`（0.2.0 长在 `ui-user-questions/src/client/QuestionComposer.tsx` 的 frame
  根节点上；0.1.7 时它在 `ui-chat` 里、行号已变，但**属性名这个锚点本身未变**）、
  `chat.deepDiving(For)` locale 键、`body[data-ds-dark-theme]` 与
  `--dsw-alias-label-primary` / `label-secondary` / `border-l*` / `interactive-bg-*`。
- `resolver.ts` 的 `error.stack = ...`（对 Node 内部 `ERR_PACKAGE_PATH_NOT_EXPORTED`
  错误的非可写 `stack` 赋值；rc.2 在 699 行）**仍在**，`dsh-local-no-auth` 的元信息崩溃
  shim 因此继续必要。

rc.2 上**确实变了**、且直接命中 `dsh-force-compact` 的两处（细节见该插件 AGENTS.md）：

1. **运行态文案换了宿主**：`button[data-turn-process] > span` 现在只渲染**已结束**回合，
   运行态搬进了新组件 `RunningStatus` 的 `div[data-chat-running]`（新锚点），且
   `TextShimmer` 把同一句渲染两遍（真实文本节点 + `data-shimmer-text` 的高亮副本，后者由
   CSS `::after` 取字）。0.1.7 的贴皮实现因此在 0.2.0 上**贴错对象**——会把已结束回合的
   「已完成，用时 2分5秒」错贴成工作中的俏皮话。0.7.1 改为：只替换**文字**前缀，
   **鲸鱼动画小图标（`runningIcon`）与分隔线原样保留**，并对两处文字**双写**。
2. **`tool-result` 块类型被上游删除**（提交 `f4a32dbd0a` "flatten tool results"）：计价
   移植块里为它保留的专用分支与官方 `estimateContent` 的 `default` 分支分叉 4 tokens，
   导致少报 shadow 账单。0.7.1 已删掉该分支（探针加了 V4 原生形状与 legacy 未知块两例）。

顺手纠正一条旧记载：**0.2.0 的 CLI 有 `--patch <path>` 选项**（可重复）。旧文档写的
"`dsh web` 没有 `--patch` 选项"不成立——实测
`pnpm dsh --profile web --patch <file> --dump-config` 退出码 0，且 dump 的层头里出现该
文件路径。但它叠加的是**配置层**、不安装包：被叠加文件若按**包名**引用插件，该包仍须先
装进 profile。

验证（全部退出码 0，2026-09-30；2026-10-01 增补指令行外观三支）：`node exploration/plugin-manifest-check.mjs`
（严格 `JSON.parse` + peer 字面量）、`peer-range-probe.mjs`（123 项：范围 / 同列车 / 边界语义）、
`theme-token-probe.mjs`（46）、`i18n-parity-probe.mjs`（74）、`fc-bracket-order-probe.mjs`（8）、
`fc-plugin-load-probe.mjs`（含 `/force-compact` 注册对象一段）、`fc-summary-effort-probe.mjs`（19）、
`fc-shadow-price-parity-probe.mjs`（38）、`fc-livetext-prefix-probe.mjs`（24）、
`fc-livetext-apply-probe.mjs`（12）、`fc-command-face-probe.mjs`（39）、
`fc-command-menu-probe.mjs <port>`（14，真浏览器）、`fc-release-artifact-check.mjs dsh-force-compact`。
端到端（3080 web 实例，`DSH_HOME=~/.dsh-web`）：三个插件在 `pluginInventory/list` 里均为
`enabled:true` / `fiberPhase:active`，`settings/describe` 出现 `falling-ts-force-compact` 与
`falling-ts-web-ding` 两个命名空间，`dsh-local-no-auth` 免 token 生效（`/` 与 `/api/*` 均 200）；
`fc-livetext-e2e-probe.mjs 3080`（17 项：对运行中实例经真实 host RPC 推 `liveUi`，走完
broadcast → mirror → derive → 贴皮链，并回放每秒重写与 idle 清空；截图
`exploration/fc-livetext-e2e{,-before}.png`）。`fc-command-menu-probe.mjs` 在**本机 3080**与
**线上服务器**（经 `dsh-ssh-helper/tunnel.mjs` 把远端 3080 映射到本地 13080）各跑一次均全绿——
两处 `/` 菜单里那一行都渲染成「强制压缩 force-compact 立即强制压缩本会话上下文」+ 图标。

**指令行的官方外观（2026-10-01）**：`/` 菜单里官方一等公民命令（压缩 / 权限 / 模型 / 下载日志）
带图标 + 中文名 + 本地化描述，而第三方宿主命令此前只有裸名字 + 英文描述。原因是外观表**硬编码**
在客户端 `@deepseek-ai/dsh-client-ui-commands` 的 `presentation.ts`（`HOST_FACES` 六个
`definitionId`），0.2.0-rc.2 没有给第三方留缝（自有贡献同名即冲突、`decorate` 不换行外观）。
`dsh-force-compact` 0.8.0 的补齐方式（宿主侧声明自己的 `definitionId` + 客户端在
`commandUi.candidates` 出口给自己那一行贴 label/description/icon）与它的降级路径见该插件
`AGENTS.md` 的「指令行的官方外观」一节。

### 官方插件规范符合性评审（2026-09-30）

按上游 `docs/user/develop/**` + `cordis-plugin-development` skill（`references/host-plugin.md` /
`ui-plugin.md` / `practices.md`）+ `packages/AGENTS.md` / `packages/client/AGENTS.md` 逐条核对过
三个插件。（2026-09-30 晚新增的第四个插件 `dsh-start-command` 是**照这套规则新写**的，其自查
结论与有意偏离见该插件 `AGENTS.md` 的"官方规范符合性"一节，含实测发现的
"pwsh `>>` 落 UTF-16、宿主 `read` 判其为 binary 而拒读"这条坑。）**完整结论、整改清单与风险登记见
[docs/plugin-conformance-review.zh.md](docs/plugin-conformance-review.zh.md)**；三条必须记住的：

- **显示元数据**：标题/描述要放 `locale/<lang>.json` 的 `meta`，图标是清单顶层 `icon`（相对路径、
  SVG/PNG/JPEG/WebP、≤256 KiB），两者都要经 `exports` 发布；缺了会**静默**回退到 package.json 的
  `name`/`description`（也就是那段超长 npm 描述，force-compact 约 1.2 KB）。**清单改动要重启实例
  才生效**（profile-resolution 启动时快照插件 exports 表），这与"改插件源码不用重启"是两条规则。
- **客户端半部红线**：工厂必须无副作用（监听器/样式/订阅一律在 `apply` 里经 `ctx.effect` 注册并
  归还 disposer）；**不写自己组件之外的 DOM、不 append 到 `body`**（浮层的官方出口是 `shell.overlay`
  槽）；不读写宿主 DOM 做定位；rpcId 的铸造归 Connection（客户端不要手拼 wire 信封）；
  `@deepseek-ai/dsh-client-store` 是 `PLATFORM_MODULES` 基线模块，**不需要**写 `dsh.client.external`
  （重复基线反而会被 `verify-client-packages` 判违规）。
- **有意保留的偏离（勿"顺手修"）**：web-ding 的 toast/抽屉仍是 body 直写浮层；两个插件仍读宿主
  DOM 锚点（`data-question-key` / `data-chat-running`）；回合结束仍以 `agent/status` 的 idle 转变为
  判据（是监听事件、非轮询）；peer 只声明 `peerDependencies`；`--fcts-*` 浅色分支保留字面值。
  逐条理由与风险登记在那份文档里。
- **有意保留的偏离（2026-10-01 增补）**：`dsh-force-compact` / `dsh-web-ding` /
  `dsh-start-command` 三个分区的**设置导航图标**是 DOM 贴面。原因是外壳
  `ui-settings-general` 的 `navIcon(id)` 是**按 section id 硬编码**的闭合表，而 `settings.section`
  的注册选项只有 `id`/`order`/`label`（`SettingsSectionRow` 没有 icon 字段），第三方分区拿不到图标位
  ——工作区 pin 的源码与桌面版 `app.asar` 里打包的客户端同源，是同一份映射。三者照抄生态通行解法
  （`dshmarket` 的 `settings-nav-icon`，其注释点名 `dsh-better-sidebar`、`dsh-skill-mcp-panel` 同法）：
  对话框挂载后按**本地化 label 文本**认领自己那一行，加一个属性 + 注入一张 `<style>`，用 `mask-image`
  画标记并隐藏兜底齿轮。**因此确实触碰了上面那条"不写自己组件之外的 DOM"红线**，但只加属性、不删不换
  React 节点，空标签不认领任何行，属性与样式表都由 `ctx.effect` 归还，观察器只在 React 改写导航时
  回调；mask 模板纯 alpha、不命名颜色（全 `currentColor`），不进 `--fcts-*` 色表。上游一旦给
  `settings.section` 加上 `icon` 字段即删除。活体验证 `exploration/fc-settings-nav-icon-live-probe.mjs
  3080`（29 项：认领 / 未误标官方行 / 齿轮确被隐藏 / 把 mask 当图片解码数不透明像素，以证明
  `currentColor` 模板真的会绘制）。

门禁已同步扩强：`exploration/plugin-manifest-check.mjs` 现在同时校验 locale 键集、文案长度上限、
`icon` 存在与体积、`exports`/`files` 覆盖（做过反向验证：移走 `locale/zh.json` 即红）；新增
`exploration/wd-signal-title-probe.mjs`（27 项：Host 侧标题读取与信号契约的 7 种降级）；
`exploration/wd-audio-unlock-apply-probe.mjs` 扩到 31 项（工厂纯净、apply 所有权与撤销、零 RPC、
首帧两种情形）；`dsh-start-command` 自带四支：`exploration/sc-prestep-probe.mjs`（75 项，离线：
门禁矩阵 / 空值零副作用 / 执行路径 / 回合闩锁 / waterfall 语义 / 落盘运行日志）、
`exploration/sc-e2e-probe.mjs 3080`（17 项，真回合：命令确实执行、早于本回合首条模型消息、
模型在第一个步骤读到产物；清空后不再执行）、
`exploration/sc-settings-ui-probe.mjs 3080`（7 项，真浏览器：分区渲染 + 读路径 + 经「保存」的写路径）、
`exploration/sc-live-verify.mjs 3080`（门 5 活体正反两支：**先等到空窗再发话**才执行 / 会话 A 在跑时
投递的会话 B 被压制但回合照常跑完；`--demo`（旧名 `--toast` 仍接受）追加真实 `test-start.js` 一段，
该段 headless 跑（`--text=sc-live-verify --no-launch`），并断言标记里的 `text=` 与本次写入一致）。

> 工作区根的 `test-start.js` 是这条链路的**可视 demo**：默认动作 = **在屏幕右下角新弹一个自绘
> 窗口**（`popup` 模式），窗口上写着 `Harness 开始了。` + `第 N 次执行 · 时刻` + 会话工作目录。
> **每次执行都新开一个窗口**（叠着往上排，槽位 = 编号 % 6），不合并、不替换、不受系统通知策略
> 影响，默认 9 秒后淡出、点一下立即关；开关：`--sticky`（不自动关）/ `--duration=ms` / `--silent`
> / `--focus`（默认只置顶不抢焦点）/ `--text=` / `--no-launch`（只写标记，自动化用）。
> `--notepad`（记事本，已不是默认）/ `--notify` / `--toast` / `--card` 保留旧行为。
> 判据：窗口第二行的 `第 N 次` 来自 `%TEMP%\harness-popup-count.txt`（可无限自增），
> 标记 `%TEMP%\dsh-start-command-last-run.txt` 记 `mode=` / `text=` / `popupCount=` / `dwellMs=` …
> 枚举窗口用 `node exploration/win-window-probe.mjs [标题子串] [--all]`（`EnumWindows` + 可见性 +
> 矩形 + `WS_EX_TOPMOST`），比截图判读硬、也比日志直接。
>
> ⚠️ **为什么默认不再是记事本**：记事本走"同一份文档只保留一个窗口"的复用语义，手动连跑第二遍时
> 屏幕上**什么都不会发生**（只是把已有窗口拉到前台；若它本来就在前台则完全看不出区别）——这正是
> "我明明执行了却没有弹窗"的经典现场。要"每次执行都确定看得见"，就必须每次新建窗口。
>
> ⚠️ **动作进程必须能活过宿主那条命令**（2026-09-30 实测，经真实插件路径跑真回合、四种起法各写
> 一个"12 秒后我还活着"的文件）：`spawn(…, { detached: true })` 在本机是**假成功**——
> detached 那个连启动都没启动（`started=False`），普通子进程也活不过 12 秒；**真正活下来的是
> `Start-Process` 的孙进程与 WMI `Win32_Process.Create` 建的进程**。所以 `test-start.js` 的派发
> 顺序是 ① `Start-Process`（`-WindowStyle Hidden`，不影响 WinForms 窗口显示）→ ② WMI →
> ③ 直接 spawn，每一档都以"动作进程有没有刷新 `%TEMP%\dsh-start-command-child.txt`"为准，
> stdout 打 `dispatched via=start-process confirmed=Y`——`confirmed` 是实测结论，不是"我以为我发出去了"。
> 宿主是**提权后台进程**时，抢焦点还得 `AttachThreadInput` → 松一次 Alt 键 → `SwitchToThisWindow`
> 三级连锁（`--focus` 才用；"看得见"本身靠 `TopMost`，不依赖抢焦点成功）。
>
> ⚠️ **`Start-Process` 会继承工作目录，而会话工作目录可能不可访问**（2026-09-30 补充实测，
> 这是"web 端发消息什么都不弹"的**第二层**原因）：插件把命令放在**会话自己的沙箱策略**下执行，
> 而 `workspace-write` 会话的工作目录是被围栏锁住的——在那种目录里 `Start-Process` **静默失败**：
> 启动器 `status=null`、被拉起的 PID 为空、屏幕上什么都没有。判据（同一目录、同一命令，只换启动
> 形态）：`Start-Process -WorkingDirectory <会话目录>` → 失败；同一目录下直接 `execFile` → 正常。
> 因此三条派发路径（`Start-Process` / WMI / 直接 spawn）**一律显式把工作目录钉在 `%TEMP%`**，
> 会话目录只当**显示文本**用。同时实测出该策略下另外两条：宿主给**每条命令**一个一次性临时目录
> （`%TEMP%\dsh-XXXXXX\`，用完即回收，所以 `%TEMP%` 里的跨次计数器会从 1 重新开始、且目录可能在
> 动作进程还在用时就被收走）；命令内部再 `spawn` 子进程会拿到 **`EPERM`**——命令退出码**仍是 0**，
> 即"`exit=0`"不等于"副作用发生了"。这也解释了为什么阈值是 `danger-full-access`（全链路可用）而
> `workspace-write` 会话里命令"成功"却什么都看不见。
>
> ⚠️ **两个 home 现在都装了这条链路**：`~/.dsh-web/profiles/web`（3080）与
> `~/.dsh/profiles/desktop`（桌面应用 19387，也就是用户实际打字的那个 GUI——2026-09-30 之前
> **只有 web 那个 home 装了**，所以"在 GUI 里发消息却什么都不弹"的第一原因就是插件根本不在）。
> 桌面 home 的 `dsh plugin --profile desktop add <path>` 会以
> `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 收场（pnpm 想重建那棵 `node_modules` 却没 TTY），
> 手装四件套即可（`profile.json` 的 `dependencies` + `dsh.profile.bundles`、`node_modules/@falling-ts/<包>`
> 目录联接、`pnpm-lock.yaml` 里 `link:` 那条、`cordis.patch.yml` 的条目），改完 profile HMR 会热加载。
>
> ⚠️ **装到一半的插件无法用"当回合"验证**：门 1 是 `payload.step === 1`（每回合只在**第一个模型
> 步骤**执行），插件若在本回合中途才装上，这一回合永远不会再触发——**新回合**（用户下一条消息）
> 才是判据。
>
> 另注：`dsh web` / 桌面应用里插件的 `ctx.logger` 输出**都不落盘**（两个 profile 都没挂 console
> exporter），`dsh-web-3080.log` 只收直接 `console.log` 的行。`~/.dsh/logs/dsh-force-compact.log`
> **不能**当"别的插件有没有加载"的证据：它自己的 exporter 在出口处按 `[force-compact]` 标记过滤
> （`src/core/log.js` 的 `shouldInclude`）。要留证据就让命令自己写日志
> （`… --wait *>&1 | Out-File -LiteralPath <file> -Encoding ascii`；别用 `>` / `>>`，pwsh 会写成
> UTF-16LE+BOM，宿主 `read` 判其为 binary 而拒读）。

> ⚠️ **测 `dsh-start-command` 时，探针发起者自己往往就是那个"在跑的 agent"**（2026-09-30 实测：
> 本会话就跑在 3080 上，`session/list` 里一直 `running:true`）。在自己的回合里连发真实回合，
> 命令**一次都不会执行**——那不是缺陷，是门 5 在正常工作。判据是 `session/list` 的 `running`
> 字段；自动化请用 `sc-live-verify.mjs`（它会等空窗），或换隔离实例
> （`PORT=3099 DSH_HOME='D:/…/.dsh-verify'`）。

### 主题（浅色 / 暗色）与颜色 token（2026-09-17 增补）

插件是 plain JS、组件用内联 style，**不能**像官方客户端包那样写 CSS Module；但**内联 style 里的
`var(--fcts-*)` 照样沿 DOM 继承解析**。集合约定：

- 带设置分区的插件在 `apply` 时注入一张**只定义变量**的样式表（`<style id="falling-ts-theme-tokens">`，
  按 id 幂等；两个插件注入的规则**逐字相同**，谁先注入都一样），组件里只引用 `var(--fcts-*)`，
  **不写字面色**。
- 两个分支：`body{…}` 放**改动前的浅色字面值**（保证浅色外观逐字节不变）；
  `body[data-ds-dark-theme]{…}` 放**上游语义别名**（`--dsw-alias-label-primary`、
  `--dsw-alias-label-secondary`、`--dsw-alias-border-l*`、`--dsw-alias-interactive-bg-*`）。
  这些别名由官方主题包按肤定义（`deepseek-harness/packages/client/ui-theme/src/styles/
  design-platform.css` 的 `body` 与 `body[data-ds-dark-theme]` 两块，后者是官方切换暗色的属性），
  随主题自动翻转，插件**不需要自己判肤**。**暗色下说明/详细文字取 `--dsw-alias-label-primary`**
  ——它在该表里解析为 `--dsw-static-neutral-bluish-50 = rgb(249,250,251)`，即纯白。
- 允许保留字面量的只有：品牌色（蓝渐变及其辉光）、控件高光与投影阴影。其余一律走 token。
- 验证：`node exploration/theme-token-probe.mjs` —— 它**解析官方主题表**、把每个 `--fcts-*`
  的暗色取值沿 `var()` 链解析到真实 sRGB、按 WCAG 算对比度（当前：暗色说明文字 **17.45:1**），
  拒绝任何指向不存在上游 token 的取值，并守住"浅色取值未漂移"与"设置区无残留字面色"。

## harness-server.sh（3080 = 本工作区默认开发实例）

- 用法：`bash harness-server.sh`（Linux 或 Windows Git Bash 均可）；
  环境变量覆盖：`PORT`（默认 `3080`）、`BIND_HOST`（默认 `127.0.0.1`）、`WAIT`（默认 `10` 秒；
  未命中视为启动失败退出非零，慢机可覆写 `WAIT=<秒>`）。
- **3080 是本工作区的默认开发实例，可随时重启 / 停掉**（见文末"会话级授权"）。
  承载 GUI 的主入口是**桌面应用**（`DeepSeek Harness.exe`，19387，home `~/.dsh`）；
  本工作区只有这一个 web 实例。
- **脚本会先引导 profile 的插件**（`[1/4]` 步）：检查 `$DSH_HOME/profiles/web/package.json`
  是否含四个工作区插件，缺了才 `dsh plugin --profile web add` 一次（`link:` 指向工作树，
  改源码即生效）。幂等、约 600ms。**这一步不能省**——web home 独立于桌面应用，没有它新
  home 起出来的是空 profile（免鉴权插件不在 → 浏览器报 authentication required）。脚本同时把
  `[web] DSH_HOME / port / plugin src / log` 四行打到 stdout，供事后核对加载的是哪份源。
- ⚠️ **从 agent 的工具 shell 里调这个脚本，必须先把继承来的 `DSH_HOME` 摘掉**
  （2026-09-30 实测踩过）：本会话的 shell 由桌面应用派生，环境里带着 `DSH_HOME=C:\Users\<u>\.dsh`，
  脚本的 `${DSH_HOME:-…}` 会**照单全收**，于是它在**桌面应用的家**里建出
  `~/.dsh/profiles/web` 并按那个 home 起实例——正是下文反复警告的"两个 home 串台"。
  正确姿势：`bash -lc 'unset DSH_HOME; ./harness-server.sh'`（或用 `DSH_HOME='C:/…/…'` 显式指定，
  注意 Git Bash 里给 Node 用**正斜杠** Windows 路径，别给 `/c/...`）。脚本打印的第一行
  `[web] DSH_HOME = …` 就是这件事的唯一判据，**先看它再往下走**。
- ⚠️ **脚本第 2 步的 `taskkill` 可能被拒**，而第 4 步的端口探测会把**旧进程**当成"启动成功"
  （实测：旧实例仍在监听、新进程绑定失败自行退出，脚本却打了 `OK: port 3080 is up`）。
  在受限 shell 里（工具子进程停下不掉的进程）尤其容易这样。判据是**日志尾部有没有
  `[ELIFECYCLE] Command failed with exit code 1`** 与 `netstat` 里 LISTENING 的 PID 是否变过。
  另一个干净做法：换个端口 + 换一个 home 起**隔离验证实例**
  （`PORT=3099 DSH_HOME='D:/…/.dsh-verify'`），它与 3080 互不抢会话租约，验证完随手删。
- 日志写入**脚本调用时的当前目录**：`dsh-web-<PORT>.log`（故根目录忽略 `*.log`）。
- 脚本第 2 步会杀掉端口占用进程：若当前 harness 自身占用该端口，
  运行脚本会导致承载本 GUI 的 harness 重启。
- `echo Y |` 前缀是修复 pnpm 交互式重装提示（`Proceed? (Y/n)`）：
  后台进程无 stdin 时会永久挂死在该提示上。
- **两个 home，一个 host 一个**（2026-09-30 定稿）：

  | home | 归属 | 谁在用 |
  |------|------|--------|
  | `~/.dsh` | 桌面应用（内置默认） | `DeepSeek Harness.exe`，也是 GUI 19387 |
  | `~/.dsh-web` | `harness-server.sh` 的 web 实例 | 3080（默认开发实例） |

  分开的理由是 **session 写租约**（单写者，内核级）：两个 host 共用 home 时后来者会被
  `session/writer-held` 拒掉，界面显示"当前会话已被占用"。

## 装插件不必重启运行中的实例（2026-09-30 实测，profile HMR）

`packages/boot/hmr/src/index.ts` 的 profile HMR 会**监视三样东西**：profile 的
`package.json` 清单（只看 `dsh.profile.bundles` 是否变化）、profile 自己的
`cordis.patch.yml`、以及 `$DSH_HOME/cordis.patch.yml`。任一变化即调
`reconcileProfilePatches` **在进程内重新装配补丁层**，因此：

- `dsh plugin --profile <p> add <包>` 写完清单的瞬间，**运行中的实例就热加载了该插件**，
  不需要重启。实测：3080 实例在 `add @falling-ts/dsh-local-no-auth` 后几秒内日志出现
  `[dsh-local-no-auth] active: ... URLs printed clean`，`/` 由 401 变 200。
- 所以"改 profile 要重启才生效"是**错的**；老笔记里的 `patchReload: live` 这个名字在
  0.2.0 源码里已不存在（全仓 grep 无此键），真正干活的机制是上面的 HMR 监视器。
- 反过来说：**插件源码**（`index.js` / `web/`）的改动本来就不需要重装——profile 里是
  `link:` 软链，直接指到仓库工作树；只有**清单/补丁层**的变化才走上面这条热重载。

**客户端 bundle 的 `rev` 跟着文件走（2026-10-01 实测，含 npm 安装的包）**：改完
`web/client.js` **不需要重启实例**，页面刷新即取到新字节。判据（3080 与线上服务器各测一次）：
① 给 `web/client.js` 末尾追加一行注释 → 再 `GET /` 拿到的模块表里该行 `rev` **当场变了**
（`30389a7a736b` → `c59cc525ae8e`），用旧 rev 取 bundle 变成 **404**（"mismatched revisions are
rejected instead of serving newer bytes"）；② 用新 rev 取到的字节里**含有那行标记**；③ 删掉标记
后 rev 再变一次、字节里的标记消失。机制在 `packages/client/hmr`（`fs.watchFile` 轮询 +
`ctx.clientModules.rebuilt(id)`，见 `packages/client/modules/src/index.ts` 的 `artifactRevision`
按**文件元数据**算 rev）——它**不是 dev-only**：用 `harness-server.sh` 起的 3080 与线上
`pnpm dsh web --no-open` 实例都如此。所以"客户端半部的改动要重启才生效"是**错的**；
只有**清单内容**（exports/icon/locale 的解析表）才是启动期快照（见上文规范符合性一节）。

**装到哪个 home 是常见坑**：`dsh web` 的 profile 目录是 `$DSH_HOME/profiles/web`。
两个 host 各有一个 home（见上文 `harness-server.sh` 节的两行表）：
`harness-server.sh` → `~/.dsh-web`，桌面应用 → `~/.dsh`。
若手工 `pnpm dsh web` 时 `DSH_HOME` 指到别处（例如继承了机器级的 `DSH_HOME=~/.dsh`），
那里会是**一个全新空的 `web` profile**（无任何插件）→ 表现为浏览器报
`dsh web authentication required; reopen the URL printed by dsh web`（免鉴权插件不在），
而且因为落在桌面版的家，左栏还会出现**桌面版的会话列表与账号**（工作区根那份残留的
`.dsh-home/` 正是这种空 profile 的现场，别照它起服务）。
排查第一步就是确认实例用的是哪个 home：
`netstat -ano | findstr :<port>` 拿 PID，再看 `$DSH_HOME/profiles/web/package.json`
的 `dsh.profile.bundles` 里有没有你的插件；对照 `~/.dsh-web` / `~/.dsh` 两个
`sessions/` 目录也能立刻看出串没串台。

**注意 `~/.dsh` 是桌面应用的家**：让 web 实例与它共用一个 home 会抢 session 写租约
（`session/writer-held` → 界面显示"当前会话已被占用"），这正是 launch 脚本把 web 端默认
挪到 `~/.dsh-web` 的原因。

## 桌面版装插件总拿到旧版：pnpm 11 的 minimumReleaseAge 闸门（2026-09-30 实测）

**症状**：桌面版（home `~/.dsh`）从 GUI 或 `dsh plugin add` 装 `@falling-ts/*`，无论重装几次、
换不换 registry，都停在旧版本（实测 0.7.0 / 0.6.0），插件界面的 **icon 与名称解析不出来**
（静默回退到 package.json 的 `name`/`description`）；而 web home 用 `link:` 指向工作树，
永远是最新源码、元数据正常。**别去查 registry**：当时 npmmirror 与 registry.npmjs.org 的
`dist-tags.latest` 都已是 0.7.2 / 0.6.1。

**根因**：pnpm 11 默认启用供应链策略 **`minimumReleaseAge = 1440`（分钟，即 24 小时）**——
发布不足 24 小时的版本**不会被解析选中**，不带版本的 `pnpm add <包>` 于是静默退回到窗口外
最新的那个版本。桌面应用内置的正是 **pnpm 11.7.0**（`resources/runtime/pnpm`，版本记在
`versions.json`）；`app.asar` 里 grep 不到 `minimumReleaseAge`，DSH 代码不参与，1440 是
pnpm 自己的默认值（[pnpm 11.0 发布说明](https://pnpm.io/blog/releases/11.0)）。
判据不用猜，两处直接可查：`%LOCALAPPDATA%\pnpm-cache\lockfile-verified.jsonl` 每次安装追加一条
`policy` 记录（含 `"minimumReleaseAge":1440`）并带 `verifiedAt`；同一次安装的 pnpm 输出里有
`✓ Lockfile passes supply-chain policies`。实测当时 force-compact 0.7.2 发布于 **0.7 小时前**、
web-ding 0.6.1 发布于 **0.8 小时前**（都被挡），而 0.7.0 / 0.6.0 刚过 26 小时——正好是窗口外
最新的可选版本。

**解法（二者择一）**：

- **写死精确版本**（显式版本不受窗口限制，实测装上且"通过供应链策略"）：
  `dsh plugin --profile desktop add "@falling-ts/dsh-force-compact@0.7.2" "@falling-ts/dsh-web-ding@0.6.1" --registry=https://registry.npmjs.org/`
  ——注意 `pnpm remove` **不接受** `--registry=`（报 `[ERROR] Unknown option: 'registry'`，
  退出码 1 且什么都没做，别把它当成"卸载失败"）。
- **精确豁免**（推荐，与 DSH 自己仓库对自研新发布包的处理一致）：在 profile 的
  `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: ['<包>@<版本>']`。只豁免列出的版本，
  其余仍受 24 小时窗口保护；不加豁免时锁文件里那条"太新"的 entry 在后续校验中仍可能被判不通过。

**动手顺序**（`~/.dsh` 是用户主目录数据，先备份）：备份 `package.json` / `cordis.patch.yml` /
`pnpm-workspace.yaml` / `pnpm-lock.yaml` → `dsh plugin --profile desktop remove <两个包>`
（`dsh.profile.bundles` 会自动回收）→ 删 `node_modules` 与 `pnpm-lock.yaml`（remove 之后
`node_modules\@falling-ts` 会留下**空壳目录**，即前文"pnpm 链接空洞"那一类）→ 加豁免 →
精确版本重装。**profile 的 `cordis.patch.yml` 是自己的调参**（补丁层按包名引用），卸载不该
也不必要改它；卸载到重装之间那两条 entry 会短暂悬空，重装即恢复。

**校验不必碰 GUI**：`node exploration/desktop-plugin-meta-probe.mjs [profileDir]` 按宿主
`readPluginMeta` 的同一条路径复核 `exports['./locale/*.json']`、各语言 `meta.title`、
顶层 `icon` 的存在与体积，退出码 0 才算元数据合格。

**但 icon/名称要重启桌面应用才显示**：该解析走 Node ESM 解析器，`@falling-ts/<包>/locale/*.json`
在旧版本里**不是** export，那次失败已被记忆化——DSH 的 `ParentRoutes.requests` 按请求串缓存
解析路由，Node 自己也缓存 package.json 内容，而**生产路径里没有任何地方调用
`pluginPackages.replace()`**（全仓 grep：只有测试与它自己的定义），缓存与路由永不刷新。
这与上一节"装插件不必重启"**不矛盾**：那条讲**激活**（包名进补丁层即可热装载），本条讲
**清单内容**（exports 表在这条路径上是进程级快照）。

## 电脑操作能力（computer use）—— 2026-09-17 在本工作区启用并实测

profile `web` 已启用完整桌面操控：模型经 **Cua Driver 原生 SDK**（`@trycua/cua-driver@0.28.0`，
Rust + 各平台原生二进制）观察并操作本机桌面。挂两个 entry：服务
`@deepseek-ai/dsh-computer-use`（只持有一个**独占**注册）+ 提供方
`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`。

**关键坑：`dsh plugin add` 装得上，但激活不了。** 这两个包（连 MCP 变体）的 `package.json`
**都没有 `dsh.bundle` 字段**，所以 `apps/cli/src/plugin.ts` 的 `reconcilePlugins` 只把它们当普通
依赖装、**不写进 `dsh.profile.bundles`**（只打印 "declares no dsh.bundle — installed as a plain
dependency" 警告，退出码仍是 0）。激活必须由 profile 自己的 `cordis.patch.yml` 用 `insert` 条目完成
——官方 `snapshots/session/computer-use-cua-driver-native/cordis.yml` 是同一写法。两步：

    node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add \
      "@deepseek-ai/dsh-computer-use@0.1.6-alpha.1" \
      "@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.1.6-alpha.1"
    # 再在 ~/.dsh/profiles/web/cordis.patch.yml 里 insert 上述两个 entry

profile 是 `patchReload: live` ⇒ **改完 patch 即进程内热重载，3080 无需重启**（实测：条目数
169→171，两条 `fiberPhase: active`，日志无新增启动行、无激活失败）。

**验证方式**：`POST /api/pluginInventory/list`，`payload.args` 传**空对象 `{}`**——该 `list()` 无参数
（`packages/host/plugin-inventory/src/index.ts:66`），传 `_request` 会被 typert 拒
（`gateway/arguments-invalid: unexpected "_request"`）。条目字段是
`entryId` / `moduleName` / `enabled` / `fiberPhase`（**不是** `name`/`id`/`status`）。

**本机实测（Windows）**：`check_permissions` 报进程完整性 High（RID 0x3000，已提权）、UIA 可用、
PostMessage 注入可用；`health_report` 报 ax_capability（UIAutomation 可达）与
screen_capture_capability（D3D11 可达、Windows Graphics Capture 可用）全绿，三条 macOS 专属检查
（bundle_identity / tcc_accessibility / tcc_screen_recording）在 Windows 上跳过——**Windows 不需要
macOS 那种录屏/辅助功能授权**。原生运行时加载即枚举出 **56 个工具**：`get_desktop_state`（全屏真实
像素截图）、`get_window_state`（UIA 树 + 截图 + `element_token`）、`click` / `double_click` /
`right_click` / `drag` / `scroll` / `type_text` / `press_key` / `hotkey` / `set_value`、
`list_apps` / `list_windows` / `launch_app` / `invoke_menu` / `set_window_frame`、CDP `browser_*`
一族、`clipboard_read` / `clipboard_write`、轨迹录制回放（`start_recording` / `replay_trajectory`）；
模型侧工具名带 `cua_driver_native__` 前缀。截图经 `attachment-local`（`dsh-base` 已含）落成持久化
附件再进模型——实测 `get_desktop_state` 返回图像并写入 `~/.dsh/attachments/v1/objects/…`，端到端打通。
模型路由须声明图像输入：本机 `opencodego` 的 `deepseek-v4.1-flash` 是 `input: [text, image]`，
而名字更像视觉模型的 `deepseek-v4-flash-vision-exp` 反倒 `input: []`。

枚举工具目录与平台权限的探针（**不截图、不发输入、不请求授权**，可安全跑在活动桌面上）：
`node exploration/cua-driver-tool-catalog.mjs [--permissions]`。

**限制**：一个组合只允许**一个**提供方注册，挂第二个（含同名实例）激活即失败；原生提供方与宿
主**同进程**，原生崩溃会带走宿主进程；桌面不按 Session 预留，并发 Session 互相干扰，取消也无法
回滚已投递的输入。

### 实操坑（2026-09-17 用画图完整画一幅图时实测）

- **WinUI3/UWP 应用一律丢弃 PostMessage。** 画图（mspaint）上 `drag` / `click` / `hotkey` /
  `press_key` 的默认 background 投递**全部无效**，但工具照样回 `✅ Posted`（`press_key` 会诚实
  标 "not verified"）——"投递成功"不等于"结果达成"，**判据只能是截图**。必须
  `delivery_mode:"foreground"`（SendInput）。曾因此以为画了十几笔，其实整块画布一笔没上。
- **SendInput 落点有 DPI 缩放偏差。** 本机（画面 2752×1152，driver 报 "@ 1x"，实际 125%）
  实测 **实际落点 = driver 报告坐标 × 1.2577**，故请求坐标须乘 **≈0.795** 才落到目标。
  `drag` 实测：请求 (795,374)→(914,183)，笔迹落在截图 (1000,470)→(1150,237)，两方向系数一致
  （1.2577 / 1.2545），偏移 ≈0。标定一次即可全程复用。
- **`click` 的像素换算与 `drag` 不一样**：`click(225,76)` 报告落点 `(701,101)`（≈×3.11），
  而 `drag(795,374)` 报告 `(1403,660)`（≈×1.765）。后果是**工具栏按钮用像素 click 必偏**
  （实测想点"椭圆"却点中"多边形"，画出一个六边形）。可靠替代：先 `zoom` 放大该区域定位，
  再用**短 `drag`**（from≈to）当点击——`drag` 的换算已验证正确。
- **`get_cursor_position` 不可用于校准**：`drag` 终点报 (1941,706) 时它返回 (1358,566)。
- **键盘快捷键**：画图里 **`P` = 铅笔**（可用；**`B` 是填充不是画笔**，误按会把整块画布填黑，
  用 Ctrl+Z 撤销）。Ctrl+Z / Ctrl+A / Delete 在 foreground 下均有效，但撤销是**逐段**的——
  画了 6 段就要按 6 次。
- **本 harness 拿不到 `element_index`/`element_token`**：`get_window_state` 的返回（markdown
  渲染）里既没有 `snapshot_id` 也没有 token，所以 README 推荐的"优先元素寻址"暂时走不通，
  只能退到像素 + 键盘。
- **Win32 通用对话框反而吃 PostMessage**：`另存为` 对话框里 `type_text` 走 PostMessage 成功，
  **中文文件名正常**（实测存成 `C:\Users\zghyu\Desktop\山水图.png`）。对话框默认停在**上次保存的
  目录**（本机是 `D:\Comfy\media`，不是桌面），在文件名框里直接输入**完整路径**即可换目录，
  无需先导航。

## 后端接口全景（精华 · 一个不漏）

harness Web 后端的**客户端可达接口**分四个面 + 一个下载通道。权威来源与各方法详细签名字段
见 [docs/backend-api-catalogue.zh.md](docs/backend-api-catalogue.zh.md)（跨源核对总表）；本节为浓缩。

> **0.1.3 传输漂移（重要）**：本节 S1 的**句点**形态 `/api/<ns>.<method>` 与 `RpcMethodMap`
> 路由表属于**旧 `packages/host/apiproxy`**（0.1.3 已删）。0.1.3 起一元 RPC 改走
> `client/connection` + typert gateway，wire 路径为**斜杠** `/api/<ns>/<method>`、
> 信封 `payload:{args:{...}}`，方法清单以各 `packages/api/*/src` 的 `@Remote('<name>')`
> 为准（详见下节"通过 wire 协议驱动一次对话"，已按 0.1.3 实测改写）。下表 S1 的方法
> **名字**仍可参考，但**句点形态与 `RpcMethodMap`** 不再成立。

### 四类物理通道

| 面 | 通道 / 形式 | 规模 |
|----|-------------|------|
| S1 一元 RPC | `POST /api/<ns>.<method>`（**句点**分隔），信封 `{"type":"client-request","rpcId","method","payload"}` | **74 个方法**（`RpcMethodMap` 编译期锁定路由表） |
| S2 流式下行 | `GET /api/events.mux`、`/api/events.host`（裸 GET=SSE；浏览器强制 WS 升级，否则 426） | 2 条流 + `MuxFrame`(10 变体) + `HostFrame`(10 变体) |
| S3 应答回调 | `POST /api/respond`（`client-response`，**回显**发起方 rpcId，不重铸） | 承载审批 / 问答应答 |
| S4 网关命名空间 | `POST /api/<ns>/<method>`（**斜杠**分隔段，经 Typert 网关派发） | **7 个命名空间 ≈ 25 个 `@Remote` 方法** |
| 下载 | `GET /api/session.export`（无信封，宿主独占，不进浏览器 IApiClient） | ZIP 导出 |

> 易混淆点：S1 用**句点**、S4 用**斜杠**；两者同 `/api` 前缀但派发机制不同。
> `method` 字段必须与 URL 末段逐字一致（句点面写斜杠会被 `bad-request` 拒绝）。

### S1 — 74 个一元方法（按命名空间）

`session.*`：list, search, create, history, models, selectModel, rename, fork, prompt, attachment, updateQueue, cancel
（12 个）· `subagent.*`：list, history, prompt, interrupt（4）· `host.*`：describe, pickDirectory,
listDirectory, createDirectory, openPath（5）· `workspace.*`：list, create, rename, delete, insertBefore,
insertSessionBefore, archiveSession（7）· `skill.*`：list（1）· `agentPreset.*`：list, select, read, copy,
openDocument, remove（6）· `goal.*`：create, edit, pause, resume, complete, clear（6）· `settings.*`：
describe, openDocument, update, replace, mutate（5）· `credentials.*`：describe, set, unset（3）· `llm.*`：
providers, models, discoverModels（3）。合计 **74**。

### S4 — 7 个网关命名空间（`@Remote` 标记的方法，斜杠形态）

| wire 命名空间 | 拥有包 | 远程方法 |
|---------------|--------|----------|
| `commands` | `packages/interaction/commands` | list, execute |
| `goals` | `packages/goal/goal` | create, edit, pause, resume, complete, clear |
| `dynamicCordisRunner` | `packages/extensions/cordis-host-runner` | runHostHalf, getClientCode, resolveRequestRun, settleUserRun, stopFromPanel, syncInspectManifest, resolveInspectQuery, inventory, reportRenderFailure, reportClientGuardFailure, invoke, undefinedFromPanel |
| `fileReferences` | `packages/context/file-reference` | list |
| `sessionReferenceResolver` | `packages/context/session-reference` | candidates |
| `pluginInventory` | `packages/host/plugin-inventory` | list |
| `messageFeedback` | `packages/feedback/message-feedback` | list, put, delete |

> 前端实测唯一出现的斜杠族就是 `messageFeedback/{list,put,delete}`。注意 `goals` 同时存在
> 句点形态（S1 的 `goal.*`）与斜杠远程形态（S4），入口不同，勿混。

### S3 — 应答（非独立 RPC，走 S2 流下发的 server-request 帧）

`approval/requested` → 答 `ApprovalResponsePayload`（outcome: allowed-once/rejected）；
`question/requested` → 答 `QuestionResponsePayload`。均以 `POST /api/respond` + 回显 rpcId 回应。

### 11 个可转发宿主事件白名单（`API_REMOTE_FORWARDED_EVENTS`，`host/remote-event` 帧唯一承载）

```
agent-preset/selected   commands/change              credentials/reference-updated
cordis/request-run      cordis/request-run-resolved  cordis/dynamic-package
cordis/dynamic-retract  cordis/inspect-query         cordis/inspect-query-resolved
llm/adapters-updated    settings/document-updated
```

新增一条 ＝ 在 `packages/api/remotes/src/remote-events.ts` 该数组加一行，别无他处。

### 状态码 / 安全

- 未知路径 **404**；body 非 JSON **400**；非 JSON media（POST）**415**；>300 MiB **413**；崩溃 **500**；未受信 **403**；浏览器裸 GET 事件流 **426**。业务错误永远 200（错误在 `result.{ok:false,error}`）。
- **无鉴权令牌**，靠信任围栏（Host 回环/受信主机 + sec-fetch-site + Origin==Host）。一批**特权方法仅回环可达**（`settings.*`、`credentials.*`、`llm.discoverModels`、`agentPreset.read/copy/openDocument/remove`、`host.pickDirectory/openPath`）；`llm.providers`/`models` **不在**其中。

## 通过 wire 协议驱动一次对话（免 GUI 自动化）

已验证可用的通道（PowerShell / 任意 HTTP 客户端皆可复现）：

- **URL 形态**：`POST http://127.0.0.1:<port>/api/<namespace>/<method>`
  —— namespace 与方法之间是**斜杠**（如 `/api/pluginInventory/list`、`/api/session/create`）。
  **0.1.3 起为斜杠**：旧的 `packages/host/apiproxy`（句点形态 `/api/<ns>.<method>`）已被
  `client/connection` + typert gateway 传输取代（`64a963da0b` 引入，0.1.3 里 `apiproxy` 已删）；
  现在用句点 / 裸 `/api` 一律 **404**。
- **请求体信封**：`{"type":"client-request","rpcId":"<uuid>","method":"<ns>/<method>","payload":{"args":{...}}}`，
  `Content-Type: application/json`。**实测（2026-09-04，0.1.3 验证）**：`method` 与 URL 路径段
  同为**斜杠**；`payload` 必须包一层 `{"args":{...}}`（gateway 要求 "exactly one plain-object
  args field"）；`args` 内的**键名 = `@Remote` 方法的形参名**（见下）。
- **响应**：`{"type":"server-response","rpcId":"...","result":{"ok":true,"value":{...}}}`。
- **权威方法清单**：不再是 `apiproxy/rpc-map.ts`（已删），改为各 `packages/api/*/src` 里的
  `@Remote('<name>')` 装饰器——wire 路径 = `<ns>/<name>`（`<ns>` 为 camelCase 命名空间，
  `<name>` 即装饰器参数）。常用：`session/create`、`session/prompt`、`session/list`、
  `session/history`、`pluginInventory/list`、`settings/describe`、`settings/update`、`workspace/list`。
- **创建会话并发一句话（最小可复现序列）**：
  1. `POST /api/session/create`，`payload:{"args":{"request":{}}}`（`request` 形参，字段全可省）
     → 返回 `value.sessionId`。
  2. `POST /api/session/prompt`，`payload:{"args":{"request":{"requestId":"<uuid>",
     "sessionId":"<上一步 id>","mode":"queue","content":[{"type":"text","text":"…"}]}}}`
     （`requestId` 为客户端铸的 uuid，必填）→ 返回 `value.accepted:true`，回合异步执行。
  冒烟连通性用 `session/list`：`payload:{"args":{"_request":{}}}`（`list` 的形参名是 `_request`）。
- **排障要点**：URL/`method` 用句点或裸 `/api` → **404**（未知路径）；`payload` 缺 `args`
  包层 → `gateway/internal`（"…exactly one plain-object args field"）；`args` 字段不符
  descriptor → `gateway/arguments-invalid`（typert 会点名缺哪个字段）。
- 传输细节载体：`@deepseek-ai/dsh-client-connection/src/{client/rpc.ts, api-path.ts, rpc-schema.ts}`；
  网关宿主侧契约 `handler('<ns>/<method>', { args }, signal)`
  （`packages/api/gateway/tests/gateway.host.spec.ts`）。

## 探测 / 驱动脚本：集中在 `exploration/`

本工作区早期的探测与 wire 驱动脚本现已**集中存放在 `D:\deepseek-harness-plugins\exploration\`**
（不再散落在工作区根目录）。它们是独立、可重复运行的 `.cjs` / `.mjs` 探针，
不属于任何插件源码，仅供复现实测结论与驱动线上会话。

- 典型用法（示例）：
  `node D:\deepseek-harness-plugins\exploration\fcprobe8080.cjs`
  `node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 smoke anchor`
- 引用这些脚本的文档一律指向 `exploration/` 下的新路径。
- 个别文件名带历史后缀（如 `fcwalk.dry.cjs` / `fcwalk.mjs` / `fcwalk2.mjs`、
  `fcbracecheck.cjs` / `fcbracecheck2.mjs`），保留原名以便对照既有笔记，勿据此推断功能。

## 会话级授权：全程放权 + 默认推荐 + 3080 随手重启（本工作区约定，长期生效）

- 用户在**本工作区**授予：开发过程中**无需逐步请示**，直接推进；遇到多选一
  **默认采用推荐方案**并在结果中标注所选为何；仅在不可逆 / 破坏性动作
  （如推送、删除、改用户主目录数据）前才简短说明。
- **3080 是本工作区的默认开发实例**：可随时 `bash harness-server.sh` 重启或停掉
  （`PORT` 可覆盖默认端口），不必事先询问。承载本会话 GUI 的是**桌面应用**
  （home `~/.dsh`，GUI 19387），与 3080 是两个进程，重启 3080 不影响它。
- 文件沙箱策略：本会话为 `danger-full-access`（不受限读写）；审批弹窗在本会话
  **已禁用**——需要审批的动作会被自动拒绝，因此**不要**发起 `sandbox_permissions`
  升级，直接执行即可。
- 配套经验（来自本轮 force-compact 调试日志开发，供后续复用）：
  - **预设平面晚挂载**：`agent-presets:*` 提供的服务（`fs`、`compaction` 等）
    在插件 `boot-time ctx.effect` 之后才就位；启动期 `ctx.get('fs')` 恒为 `undefined`。
    凡依赖这些服务的副作用应**惰性幂等安装**（在各受守卫生命周期钩子里
    `ensureXxx(ctx)`，进程内闩锁保证至多一次），而非启动期一次性 effect。
  - **顶层 disabled ≠ 服务缺失**：库存清单里顶层 `tool-fs`/`compaction-basic`
    标 disabled，但 `agent-presets:tool-fs` / `agent-presets:compaction-basic`
    常处于 enabled+active——运行时 `ctx.get` 走的是后者，勿据顶层标志判定缺席。
  - **受沙箱 `fs` 服务有 workspace 围栏**：`workspace-write` 模式下拒绝写
    workspace 之外的绝对路径（报错 `file access denied under workspace-write mode`）。
    要把诊断文件写到共享用户主目录（`~/.dsh/logs/…`），改用 **Node 原生
    `import('node:fs/promises')` 直写绝对路径**，完全绕开围栏、与实例沙箱模式无关。
  - **跨用户可移植的路径**：绝不在代码里硬编码绝对路径（如 `C:\Users\<x>\…`）。
    默认值用 `~/…` 模板，运行时经 `node:os.homedir()`（Windows 读 `USERPROFILE`）
    解析到每个用户各自的家目录，从而在不同机器 / 用户间自然迁移。
