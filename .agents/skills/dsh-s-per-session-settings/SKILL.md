---
name: dsh-s-per-session-settings
description: Use when implementing a per-session overridable setting (global default + per-session override) in a dsh plugin, or diagnosing "writes rejected / settings not volatile" errors. Captures the 2026-10-02 mechanism used by dsh-force-compact's auto-compaction threshold.
---

# 会话级设置（per-session settings）—— 2026-10-02 实测

需求形态：一个「全局默认 + 每会话可覆盖」的设置（force-compact 的自动压缩阈值）。下面机制可直接复用到别的插件。

## 宿主 schema 必须给覆盖字段开 volatile 口子

客户端写设置走 `settings.mutate` → `isVolatilePath(schema, path)`（`packages/settings/settings/src/schema.ts`），该函数命中**首个** `meta.volatile` 节点即返回 true，**不检查更深的路径**。所以把覆盖表声明成 `sessionThresholds: asVolatile(z.any())` 之后，`path: [sessionThresholds, <sessionId>]` 就是合法写入；用 `z.any()` 而非 `z.dict(...)` 是为了让动态键原样落盘、形状在读取时自查。反例：字段忘了 `.volatile()` → 写入被拒，报文 `Config field "sessionThresholds.<sid>" is not volatile`（`settings/rejected`）。

- **宿主→客户端方向可省 volatility 检查，客户端→宿主不行**：`liveUi` 这类只由宿主 `settings.update(NS, patch)` 写的字段（path 列表为空）本来就不查 volatile，当通道用没问题；一旦要**客户端写回**就必须过上面那关。
- **组件天然拿得到 sessionId**：`conversation.composer.dock` 是 `{ kind: list, scope: session }`，`ctx.slots.inject` 的工厂与组件 props 都带 `sessionId`，直接拿它做键即可隔离，不需要另找会话标识。
- **插槽包装层是 `display: contents`，所以 `order` 直接可用**：`renderSlot` 给 list 槽注册项套一层无类名 `div`，实测该层 `display: contents`，于是注册项的根元素**就是**外层 flex 容器（`conversation.composer.dock` → `.dock`）的 flex item。force-compact 的会话 chip 靠根节点 `order: 1` 落到 ContextMeter 右侧；想挪位置改这个 `order` 即可，不必（也无法）选包装层——它没有类名。
- **useProjection 是 session 作用域槽位的框架标准 prop**：不需要 inject、也不需要 `ctx.remote`。`docs/subsystems/slots.md` 表格列了全套（`sessionId` / `useSession` / `useProjection`，owner 是 `ui-session`）；`ui-session/src/client/index.ts` 的 `SessionStandardProps` 是权威声明。插件组件读 `props.useProjection` 再调 `p("contextPressure")`，直接拿到 `{ pressureTokens, projectedTokens, contextWindow }`。要点：`props` 上理论上可能缺席，用**模块级** no-op 兜底后再调用，别写成条件 hook。
- **想画在别人的 UI 上只能用几何 overlay**：ContextMeter 的圆环与展开面板归 `ui-conversation`，插件塞不进它的 React 树。可行做法：从自己 chip 反查 DOM 锚点（chip.parentElement 是 display:contents 包装层，它的 parentElement 就是 dock；取 dock 里非包装层兄弟 = ContextMeter 根），用 `getBoundingClientRect` 求相对偏移，把绝对定位 marker 挂上去（给宿主根补 `position:relative`），再用 `MutationObserver` 跟着面板开合重算；回调里用 writing 旗标挡住自己写出的 mutation，避免自激循环。环几何照抄上游：`viewBox 0 0 14 14`、`r=5.5`、`rotate(-90 7 7)` 起算（12 点起顺时针）。

- **pill 文案固定、数值走辅助通道**：chip 只显示固定文案（图标 +「强制压缩阈值」），生效值放 `aria-label`（形如 `<caption>: 700K`）、`title` 与弹层里。好处是每行宽度稳定、数字不挪布局；代价是读取值靠 aria/tooltip，写探针别再断言 pill 文本是数字。
- **读取端统一回落到默认**：宿主读设置一律走 `readSettings(ctx, session)`，返回 `sessionThresholds[sessionId] ?? autoThresholdTokens`；把 session 一路传进各门禁调用点。force-compact 现有 7 处传 session，另有 2 处**故意不传**（debug logger、只读 `disableThinking` 的 `__thinkingDisabledBody`）。
- **设置表单只负责默认值**：把标签写成「默认值」、hint 里指向覆盖入口，免得用户以为改了表单就改了已被覆盖的会话。
- **踩坑：改了宿主半部必须重启实例**：profile 里插件是 `link:` 软链，客户端 bundle 按文件 rev 现取，但**宿主半部**是启动期 `import` 的模块快照。改 `src/**` 后不重启 → 客户端新、宿主旧，症状"界面能点，但保存报错或静默不动"。判据：看 `POST /api/settings/describe` 返回的 schema 里有没有新字段。

## 复现探针（`exploration/`）

`fc-session-threshold-probe.mjs`（离线：宿主解析 + 客户端解析一致性 + 调用点审计）、`fc-session-threshold-schema-probe.mjs`（真 schema 对真 `isVolatilePath`）、`fc-session-threshold-live-probe.mjs`（真机：保存 → 整页重载仍在 → 回落默认 → 另一会话隔离）、`fc-session-threshold-mode-probe.mjs`（简洁/详细两模式都渲染）。

## 相关技能

- `dsh-s-plugin-collection`：客户端半部红线、主题 token、规范评审。
- `dsh-s-server-run`：宿主半部改动需重启、HMR 边界。
