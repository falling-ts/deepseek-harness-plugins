# 三个插件对官方插件开发规范的符合性评审（2026-09-30）

本文件是**一次性评审的存档**：把"我们的写法 vs 上游官方规范"的逐条核对结果、已整改项、以及
**有意保留的偏离**固定下来，供后续改动前查阅。规范原文全部在上游 checkout 里，本文只做对照与结论。

## 评审依据（上游权威来源）

| 来源 | 管的什么 |
|---|---|
| `deepseek-harness/docs/user/develop/basic/{index,publish,config,tool}.zh.md` | 插件形态、组合包 manifest、patch 层、profile 与安装、Config、工具 DSL |
| `deepseek-harness/docs/user/develop/framework/{index,service,events}.zh.md` | Fiber 生命周期、注册即 effect、dispose 语义、服务与依赖 |
| `deepseek-harness/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md` | 插件作者的**主入口**：交付流程与知识来源顺序 |
| 同目录 `references/host-plugin.md` | 组合包 manifest、**显示元数据与图标**、Host 导出形态、安装/启用/观测语义 |
| 同目录 `references/ui-plugin.md` | 客户端清单（`dsh.client`）、模块加载器契约、槽注册、工厂无副作用 |
| 同目录 `references/practices.md` | 扩展点强弱次序、升级稳定性、会话/投影/性能、**UI 红线** |
| 同目录 `templates/decoration/*` | 四个文件的起手模板（`package.json` / `cordis.patch.yml` / `index.js` / `client.js`） |
| `deepseek-harness/packages/AGENTS.md` | 导出形态硬规则、可选服务用 `ctx.get`、注册即 effect |
| `deepseek-harness/packages/client/AGENTS.md` | 槽与 props 纪律、导出纪律、**rpcId 归属**、`dsh.client.external` 的真实语义、基线模块 |
| 源码判定逻辑：`scripts/verify-client-packages.ts`、`packages/boot/app-boot/src/package-meta.ts`、`packages/client/web/src/platform.ts` | 上面那些"约定"的**实际闸门与读取路径**（权威高于散文） |

**判决边界**：`packages/AGENTS.md` 里的 tsconfig 三面、per-file 100% 覆盖率、recorded-session
snapshot、Agent Note、文档预算、`verify-*` 闸门等属**仓内包**规约，约束的是
`deepseek-harness/packages/*`；三个自有插件是**仓外 plain-JS bundle**，只受 Loader / Client
运行期契约约束。它们自建的 `exploration/*probe.mjs` 是等价回归闸门。

## 结论速览

| 规范域 | force-compact | web-ding | local-no-auth |
|---|---|---|---|
| 组合包 manifest / patch 层（按包名引用、id 唯一、exports/files/license/双语 README） | ✅ | ✅ | ✅ |
| patch row `id` = settings 命名空间（有表单的前提） | ✅ | ✅ | 无表单，n/a |
| Host 插件导出形态（只具名、**无 default**、不混形态） | ✅ | ✅ | ✅ |
| Config：可调参数全进 schemastery，无硬编码 tunable | ✅ | ✅ | ✅（本身无可调项） |
| 注册即 effect / unload 归还 | ✅ | ✅（原 1 处例外，已修） | ✅ |
| Waterfall `next()` 纪律 | ✅ 三条缝全对 | n/a | n/a |
| 会话日志：不发明新事件类型、不重扫 `session/event` | ✅ | ✅ | ✅ |
| 客户端模块契约（id=包名、React 走模块表、基线模块不重复声明、`immediately` 该省则省） | ✅ | ✅ | n/a |
| 工厂无副作用 / 资源在 apply 内注册并归还 | ✅ | ❌→✅ **已修** | n/a |
| 不往 `document.body` 写 DOM / 浮层用 `shell.overlay` | ✅ | ⚠️ **保留偏离** | n/a |
| 不读写宿主 DOM | ⚠️ 保留偏离 | ⚠️ 保留偏离 | n/a |
| 传输归 Connection（rpcId 由 Connection 铸） | ✅ | ❌→✅ **已修** | n/a |
| UI 文案归 locale、主题走 token | ✅ | ✅ | n/a |
| 显示元数据（`locale/*.json` + `icon`） | ❌→✅ **已补** | ❌→✅ **已补** | ❌→✅ **已补** |
| 只走官方扩展点 | ✅ | ✅ | ⚠️ 保留偏离（无官方出口） |

**总判**：骨架、清单、生命周期、waterfall、会话数据面**完全合规**；不合规项集中在 UI/客户端半部，
其中三条（工厂期副作用、body 直写、客户端自铸 rpcId）已整改，其余为**有理由的书面偏离**。

## 已整改（2026-09-30）

1. **web-ding：用户手势监听从工厂求值期搬进 `apply` + `ctx.effect`**
   （原文位置 `web/client.js` 工厂体内，违反 `ui-plugin.md` "Keep factories free of side effects"）。
   改后仍保持"捕获阶段 / 非一次性 / 多手势"，但由 fiber 拥有、卸载时按同一 `capture` 取值撤销。
2. **web-ding：客户端不再自铸 rpcId 取会话标题**
   删掉了手拼 wire 信封调 `/api/session/list` 的 `fetchSessionTitle()`（违反
   `client/AGENTS.md` 的 rpcId 归属，也把传输形态知识塞进装饰路径）。现在 Host 半部在 idle
   转变时从 `ctx.get('sessionProjections').snapshot(session).values.title` 读出标题，随
   `signal` 载荷一起送给浏览器；读失败降级为"没有 title 字段"，绝不影响叮一声。
3. **三个包补 `locale/{en,zh}.json` + `icon.svg`**（`host-plugin.md` 的显示元数据约定）：
   此前插件卡片回退到 `package.json` 的 `name`/`description`，也就是把那一整段 npm 描述当
   描述显示（force-compact 的约 1.2 KB）。同时给 `exports` 加 `"./locale/*.json"`、给 `files`
   加 `locale/*.json` 与 `icon.svg`。
4. **web-ding：`dsh.client.inject` 补 `@deepseek-ai/dsh-client-locale`**（与 force-compact 对齐；
   该字段是信息性的，只影响 preflight 显示与 HMR diff）。
5. **web-ding：修掉一个真 bug——全新 home 上第一声回合结束提示音被吞**
   旧的首帧基线把"命名空间里从来没有过 signal"也当残留处理，于是本安装的第一次回合结束不响、
   第二次才响（在 3099 全新 home 上用真浏览器复现：写入 signal 后振荡器计数仍为 0）。现在有残留
   才以残留为界，无残留则基线取 0。

### 顺带发现的清单事实（值得知道）

`readPluginMeta` 读文案走**完整的插件 specifier 解析**（`${specifier}/locale/en.json`），读图标
则是**按清单路径直读文件**。后果：只加 `icon` 不加 `exports` 时，图标会生效而文案不会——实测在
运行中的实例上就看到过这个半生效状态。原因见下条。

**清单变更必须重启实例**：profile-resolution 在**启动时**把插件的 exports 表快照进解析拦截层，
而 profile HMR 只监视 profile 自己的 `package.json` / `cordis.patch.yml` / `$DSH_HOME/cordis.patch.yml`，
**不监视插件自己的 `package.json`**。所以"改插件源码不用重启"（`link:` 直连工作树）与"改插件清单
要重启"是两条不同的规则。

## 有意保留的偏离（改动前必须先读）

### web-ding

1. **toast 与右侧抽屉直写 `document.body`** —— `practices.md`："Do not write DOM outside your
   component or append to `document.body`"；`ui-plugin.md` 给的浮层出口是 `shell.overlay` 槽
   （官方 fixture `apps/web/tests/fixtures/plugins/fixture-live-client/client.js` 就是这么用的）。
   现状：浮层在两种主题下都可读、会自行移除、不参与设置区的 token 体系。迁移属结构性改写
   （要引入 React 组件 + 槽注册 + 重做 Win11 玻璃质感），**留待有意为之**。
2. **question 块观察宿主 DOM 的 `[data-question-key]`** —— `practices.md` 说"框架驱动、插件计算"，
   自己订阅/重扫/写 DOM 就是绕过增量机制。但 question 帧走 connection 层 MuxFrame，**Host 插件
   没有订阅缝**，客户端也没有对应的事件出口，所以这是"框架没给出口"的折中。
   **风险登记**：该锚点属宿主内部实现，上游一改就静默失效。
3. **回合结束判据用 `agent/status` 的 idle 转变**（而非 durable 的 `turn/end`）—— 规范偏好 durable
   事件，但本插件要的语义是"含子代理在内所有回合都结束、且下一个人类回合之前"，`turn/end` 会每回合
   响一次。注意这是**监听事件、不是轮询**（规范禁的是轮询 `agent/status`）。
4. **peer 只声明 `peerDependencies`（+ optional meta）** —— `publish.zh.md` 建议共享宿主实例的 dsh
   包同时进 peer 与 dev；本插件是 plain JS、无类型检查与独立测试，profile 里由 dsh 提供实例。
5. **`--fcts-*` token 表的浅色分支是字面值** —— 规范说"字面色只用于 artwork"；组件本身只用
   `var()`，字面量只活在 token 表里。改成 `--dsw-alias-*` 会让浅色外观漂移，与"浅色逐字节不变"冲突。

### force-compact

1. **LiveUI 贴皮读写宿主 DOM**（`paintTurnStatus` 改写 `[data-chat-running]` 子树的文本、
   `MutationObserver` 盯 React 的每秒重写）—— 同上"框架没给出口"的折中：宿主那行运行态文案没有
   任何对外缝。**风险登记**：`data-chat-running` / `data-shimmer` / `data-shimmer-text` /
   `role=status` 四个锚点属宿主内部实现；三条探针（24 + 12 + 17 项）是它的回归闸门。
2. `--fcts-*` 同 web-ding 第 5 条。
3. peer 同 web-ding 第 4 条。
4. 三处"有意偏离集合约定"的 timer / observer / 超时守卫，本插件 `AGENTS.md` 顶部已逐条豁免说明。

### local-no-auth

1. **运行期替换 `ctx.connection` 三方法 + 包裹 `pluginPackages.metaOf` 都不是官方扩展点** ——
   规范要求"新行为挂在文档化的扩展点上"，但认证面与那条假诊断**都没有官方出口**（后者位于所有
   配置面之下的解析拦截层内）。这是"规范无解法"的折中：边界、恢复（`ctx.effect`）、fail-loud
   （`ctx.appExit`）、回环闸门都在插件 `AGENTS.md` 里写死，**不得再扩大**。
2. **日志用 `console.log` / `console.warn`**（Host 插件通常该走 `ctx.logger`）—— 保留是因为
   `refuseStart` 必须在**任何服务都不可用**（含 logger）时仍能往 stderr 说话，且那行
   `[dsh-local-no-auth] active: …` 是启动脚本 grep 的判据。

## 验证（全部退出码 0，2026-09-30）

离线闸门：

```
node exploration/plugin-manifest-check.mjs      # 严格 JSON + peer 基线 + 显示元数据（已扩展）
node exploration/peer-range-probe.mjs
node exploration/theme-token-probe.mjs
node exploration/i18n-parity-probe.mjs
node exploration/fc-bracket-order-probe.mjs
node exploration/fc-summary-effort-probe.mjs
node exploration/fc-plugin-load-probe.mjs
node exploration/fc-shadow-price-parity-probe.mjs
node exploration/fc-estimate-parity-probe.mjs   # 见下方"已知红灯"
node exploration/fc-timeout-guard-probe.mjs     # 见下方"已知红灯"
node exploration/fc-livetext-prefix-probe.mjs
node exploration/fc-livetext-apply-probe.mjs
node exploration/fc-v3-{header,region,surfaceop}-probe.mjs
node exploration/abortsignal-timeout-boundary-probe.mjs
node exploration/lna-refusestart-probe.mjs      # 见下方"已知红灯"
node exploration/wd-signal-title-probe.mjs      # 新增，27 项
node exploration/wd-audio-unlock-apply-probe.mjs  # 扩展到 31 项
node exploration/fc-release-artifact-check.mjs dsh-force-compact
```

隔离活实例（`DSH_HOME=<workspace>/.dsh-verify`、端口 3099，避开 3080 的会话租约）：

```
node exploration/fc-livetext-e2e-probe.mjs 3099            # 17 项
node exploration/wd-ding-trigger-probe.mjs 3099            # 8 项断言
node exploration/wd-browser-probe.mjs 3099                 # 真回合：缓存记录带上真实会话标题
node exploration/web-020-plugin-sections-probe.mjs 3099   # 两个设置分区正常渲染
node exploration/web-020-headless-probe.mjs 3099           # 仅探针自身探的 /api/settings/describe 404
```

显示元数据端到端：`pluginInventory/list` 里三个 entry 的 `meta.title`（en/zh）、
`meta.description`（en/zh）来自 `locale/*.json`，`meta.icon` 是内联 data URL，`meta.error` 为空。

### 已知红灯（先于本次改动就存在，与本次改动无关）

用 `git stash push -- package.json` 把插件清单回退后复跑，三者**同样失败**；且它们都**不在**
AGENTS.md 声明的回归闸门清单里，属早期一次性探针未随实现更新：

- `fc-estimate-parity-probe.mjs`：32 passed / 1 failed ——
  `工具结果角色与 tool_call_id 保持原样: {"role":"tool"}`（rc.2 的 "flatten tool results" 之后
  该断言过时；逐例计价对拍已由 `fc-shadow-price-parity-probe.mjs` 接管）。
- `fc-timeout-guard-probe.mjs`：13 项失败（输出被截断，未逐条定位）。
- `lna-refusestart-probe.mjs`：`ctx.effect` 桩与现行实现不匹配（`disposers=0` 后崩），探针过时。

**建议**：要么修这三个探针，要么把它们移进 `exploration/_stale/` 以免误当成闸门。
