---
name: dsh-s-plugin-collection
description: Use when authoring, reviewing, installing, or debugging the dsh-s standalone Cordis plugins (dsh-force-compact, dsh-web-ding, dsh-local-no-auth, dsh-start-command, dsh-chinese) or reviewing plugin conformance. Covers collection conventions, peer-dependency baselines, 0.2.0 compatibility seams, conformance-review red lines, and theme color tokens.
---

# 插件集合约定与兼容性（dsh-s）

## 插件集合约定（适用于 dsh-force-compact 及同级独立插件）

- 每个插件是**独立 git 仓库**（独立远程、独立 `package.json`），包名遵循 `@falling-ts/<插件名>` 命名空间（与 git 仓库归属一致，可 `pnpm publish`）。
- 插件目录结构遵循官方 bundle 架构：`index.js`（插件模块，plain JavaScript 无构建步骤）、`cordis.patch.yml`（patch 层；层内按**包名**引用插件，不用相对路径）、`README.md` / `README.cn.md`、`LICENSE`。
- `package.json` 必须声明 `dsh.bundle.patch`（指向 `./cordis.patch.yml`）：缺少该声明时 `dsh plugin add` 只当普通依赖安装，不激活 patch 层。
- 安装：`dsh plugin --profile <profile> add github:falling-ts/<插件>`（或本地路径）；开发期可不安装，直接 `dsh web --patch <插件>/cordis.patch.yml` 挂载。
- 插件不引入 timer、不引入持久化状态；需要设置分区或浏览器行为的插件另带**客户端半部**（`web/client.js`，`dsh.client` 声明），其工厂必须无副作用、资源全在 `apply` 里经 `ctx.effect` 注册并归还，且不手拼 wire 信封。各插件规则见其 `AGENTS.md`。插件仓库内 `CLAUDE.md` 固定只写 `@AGENTS.md`。

## peer 依赖的下限写法与 harness 版本基线（基线 `>=0.2.0-rc.1`）

三个插件对 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 的 peer 一律写成**纯下界**：官方 tag `dsh-v0.2.0-rc.1` 对应的版本列车 `@deepseek-ai/cordis: ">=4.0.4"`、`@deepseek-ai/schemastery: ">=3.18.4"`、`@deepseek-ai/dsh-*: ">=0.2.0-rc.1"`。**tag 名是 `dsh-v<版本>`，peer 字段里写 `<版本>`**——peer 吃 semver 范围、不吃 git tag。语义：只支持该基线及其以后（0.1.7-alpha.2 → 0.2.0-rc.1 共 763 个提交；vendor 的 cordis 仍是 4.0.4、schemastery 仍是 3.18.4，故这两条 peer 不动）。

**清单规则**：用哪些包就写哪些包，除 `@deepseek-ai/cordis` 外一律 `peerDependenciesMeta.optional: true`——这些包在 profile 里由 dsh 安装提供、不在 profile 的 `node_modules` 中，标 required 只会产生无意义告警（`pnpm peers check` 应报 "No peer dependency issues found"）。各插件 peer 清单与挂载缝见各自 `AGENTS.md`；`dsh-chinese` 是集合里唯一走官方文档化扩展点、不做运行期替换的插件（经 `ctx.systemPrompt.section()` 贡献，不碰上游源码也不包裹实例方法）。

### 为什么 0.1.7 及以前必须排除（硬依赖）

- **0.2.0 新增 boot 期 peer 兼容性预检**：`packages/boot/app-boot/src/plugin-compatibility.ts` 在装 profile 行前读插件 manifest，对每个 `@deepseek-ai/dsh` peer 对运行时版本做 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定，不满足的行直接 `disabled`（stderr 报 "disabling profile plugin ..."），除非用 `dsh plugin allow-version <pkg>@<ver>` 授予精确版本豁免。所以下界写错不再只是"装不上"，而是**静默禁用插件**。`@deepseek-ai/cordis` / `schemastery` 不在判定范围。
- **客户端 settings 服务改名（0.1.7）**：`ctx.settingsScope.bind({ namespace })` 被 `ctx.configForms.get(namespace)` 取代；`ConfigForm` 与旧 `SettingsScope` 同形（`getSnapshot`/`subscribe`/`set`/`unset`/`mutate`），差异是快照 `status` 枚举多了 `'loading'`，且三个写方法现在回答 `Promise<boolean>` 而非 `Promise<void>`。
- **cordis 4.0.2 → 4.0.4（0.1.7）**：vendor 升级，peer 必须跟上。
- `dsh-force-compact` 摘要回放在**强制投影缝**（`surface.deriveEventMessage`）；`dsh-local-no-auth` 的 fail-loud 依赖 0.1.6 启动语义。详见各插件 `AGENTS.md`。

### 0.2.0 兼容性核对（基线 `dsh-v0.2.0-rc.2`）

rc.1 → rc.2 复核结论：`dsh-web-ding` 与 `dsh-local-no-auth` 源码零改动；`dsh-force-compact` 有两处必须跟（见下）。peer 下界一律保持 `>=0.2.0-rc.1` **不动**：收窄到 rc.2 会让 rc.1 运行时被 boot 期 peer 预检**静默禁用**插件。

rc.2 上**复验为原样保留**的缝（节选）：Host 的 `ctx.connection` 三方法、`ctx.webServer.host`、`ctx.appExit`、`ctx.pluginPackages.metaOf`、`agent/status` / `agent/pre-step` / `agent/request` 签名、`session/flush`、`compaction.compactNow`/`compactRegion`、`settings.configure`、`tokenMeter.heuristicTokens`、`llm.stream`+`llm.resolveCallConfig`；Client 的 `ctx.configForms.get(ns)` + `ConfigForm` 五方法、`ctx.slots.inject('settings.section')`、`ctx.locale.bind/register/addLanguage`、`createSnapshotStore`、`data-question-key`、`chat.deepDiving(For)` locale 键、`body[data-ds-dark-theme]` 与 `--dsw-alias-label-*`、`resolver.ts` 的 `error.stack = ...`。

rc.2 上**确实变了**且命中 `dsh-force-compact` 的两处：
1. **运行态文案换了宿主**：`button[data-turn-process] > span` 现在只渲染已结束回合，运行态搬进新组件 `RunningStatus` 的 `div[data-chat-running]`（新锚点），且 `TextShimmer` 把同一句渲染两遍（真实文本节点 + `data-shimmer-text` 高亮副本）。旧贴皮实现会在 0.2.0 上把已结束回合错贴成俏皮话。修法：只替换**文字**前缀，鲸鱼动画小图标与分隔线原样保留，并对两处文字**双写**。
2. **`tool-result` 块类型被上游删除**（提交 `f4a32dbd0a` "flatten tool results"）：计价移植块里为它保留的专用分支与官方 `estimateContent` 的 `default` 分叉 4 tokens，导致少报 shadow 账单。已删掉该分支。

顺手纠正：**0.2.0 的 CLI 有 `--patch <path>` 选项**（可重复）——它叠加的是**配置层**、不安装包；被叠加文件若按**包名**引用插件，该包仍须先装进 profile。

### 验证探针（全部退出码 0）

`exploration/` 下：`plugin-manifest-check.mjs`（严格 `JSON.parse` + peer 字面量）、`peer-range-probe.mjs`（123 项）、`theme-token-probe.mjs`（46）、`i18n-parity-probe.mjs`（74）、`fc-bracket-order-probe.mjs`（8）、`fc-plugin-load-probe.mjs`、`fc-summary-effort-probe.mjs`（19）、`fc-shadow-price-parity-probe.mjs`（38）、`fc-livetext-prefix-probe.mjs`（24）、`fc-livetext-apply-probe.mjs`（12）、`fc-command-face-probe.mjs`（39）、`fc-command-menu-probe.mjs <port>`（14，真浏览器）、`fc-release-artifact-check.mjs dsh-force-compact`、`sc-prestep-probe.mjs`（75）、`sc-e2e-probe.mjs 3080`（17）、`sc-settings-ui-probe.mjs 3080`（7）、`sc-live-verify.mjs 3080`、`ch-prompt-probe.mjs`（78，离线）、`ch-live-probe.mjs 3080`（15，活体）。端到端（3080 web 实例，`DSH_HOME=~/.dsh-web`）：三个插件在 `pluginInventory/list` 均为 `enabled:true`/`fiberPhase:active`，`settings/describe` 出现 `falling-ts-force-compact` 与 `falling-ts-web-ding` 两个命名空间，`dsh-local-no-auth` 免 token 生效（`/` 与 `/api/*` 均 200）。

## 官方插件规范符合性评审（2026-09-30）

按上游 `docs/user/develop/**` + `cordis-plugin-development` skill + `packages/AGENTS.md` / `packages/client/AGENTS.md` 逐条核对过三个插件。完整结论、整改清单与风险登记见 [docs/plugin-conformance-review.zh.md](../../docs/plugin-conformance-review.zh.md)。三条必须记住的：

- **显示元数据**：标题/描述放 `locale/<lang>.json` 的 `meta`，图标是清单顶层 `icon`（相对路径、SVG/PNG/JPEG/WebP、≤256 KiB），两者都要经 `exports` 发布；缺了会**静默**回退到 package.json 的 `name`/`description`（超长 npm 描述）。**清单改动要重启实例才生效**（profile-resolution 启动时快照插件 exports 表），与"改插件源码不用重启"是两条规则。
- **客户端半部红线**：工厂必须无副作用（监听器/样式/订阅一律在 `apply` 里经 `ctx.effect` 注册并归还 disposer）；**不写自己组件之外的 DOM、不 append 到 `body`**（浮层官方出口是 `shell.overlay` 槽）；不读写宿主 DOM 做定位；rpcId 铸造归 Connection（客户端不要手拼 wire 信封）；`@deepseek-ai/dsh-client-store` 是 `PLATFORM_MODULES` 基线模块，**不需要**写 `dsh.client.external`（重复基线反而被 `verify-client-packages` 判违规）。
- **有意保留的偏离（勿顺手修）**：web-ding 的 toast/抽屉仍是 body 直写浮层；两个插件仍读宿主 DOM 锚点（`data-question-key` / `data-chat-running`）；回合结束仍以 `agent/status` 的 idle 转变为判据（监听事件、非轮询）；peer 只声明 `peerDependencies`；`--fcts-*` 浅色分支保留字面值。逐条理由与风险登记在那份文档里。

**有意保留的偏离（设置导航图标是 DOM 贴面）**：`dsh-force-compact` / `dsh-web-ding` / `dsh-start-command` 三个分区的**设置导航图标**是 DOM 贴面。原因是外壳 `ui-settings-general` 的 `navIcon(id)` 按 section id 硬编码闭合表，而 `settings.section` 注册选项只有 `id`/`order`/`label`（无 icon 字段），第三方分区拿不到图标位。三者照抄生态通行解法（`dshmarket` 的 `settings-nav-icon`）：对话框挂载后按**本地化 label 文本**认领自己那一行，加属性 + 注入 `<style>`，用 `mask-image` 画标记并隐藏兜底齿轮。确实触碰了"不写自己组件之外 DOM"红线，但只加属性、不删不换 React 节点，空标签不认领任何行，属性与样式表都由 `ctx.effect` 归还，观察器只在 React 改写导航时回调；mask 模板纯 alpha、不命名颜色（全 `currentColor`），不进 `--fcts-*` 色表。上游一旦给 `settings.section` 加 `icon` 字段即删除。活体验证 `exploration/fc-settings-nav-icon-live-probe.mjs 3080`（29 项）。

## 主题（浅色/暗色）与颜色 token

插件是 plain JS、组件用内联 style，**不能**写 CSS Module；但内联 style 里的 `var(--fcts-*)` 照样沿 DOM 继承解析。集合约定：
- 带设置分区的插件在 `apply` 时注入一张**只定义变量**的样式表（`<style id="falling-ts-theme-tokens">`，按 id 幂等；两个插件注入的规则**逐字相同**），组件里只引用 `var(--fcts-*)`，**不写字面色**。
- 两个分支：`body{…}` 放**改动前的浅色字面值**（保证浅色外观逐字节不变）；`body[data-ds-dark-theme]{…}` 放**上游语义别名**（`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-border-l*`、`--dsw-alias-interactive-bg-*`）。这些别名由官方主题包按肤定义（`deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css` 的 `body` 与 `body[data-ds-dark-theme]` 两块），随主题翻转，插件**不需自己判肤**。**暗色下说明/详细文字取 `--dsw-alias-label-primary`**（解析为 `--dsw-static-neutral-bluish-50 = rgb(249,250,251)`，即纯白）。
- 允许保留字面量的只有：品牌色（蓝渐变及其辉光）、控件高光与投影阴影。其余一律走 token。
- 验证：`node exploration/theme-token-probe.mjs`——解析官方主题表、按 WCAG 算对比度（当前暗色说明文字 **17.45:1**），拒绝指向不存在上游 token 的取值，守住"浅色取值未漂移"与"设置区无残留字面色"。

## 相关技能

- `dsh-s-server-run`：HMR 与重启、两个 home。
- `dsh-s-desktop-install`：桌面版装插件总拿到旧版（minimumReleaseAge 闸门）。
- `dsh-s-per-session-settings`：会话级设置机制（force-compact 阈值）。
- `dsh-s-chinese-plugin`：系统提示词规则注入插件。
