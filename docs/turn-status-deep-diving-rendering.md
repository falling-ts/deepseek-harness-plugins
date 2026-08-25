# 「Deep diving...」TurnStatus 指示器的渲染与驱动

> 本文档回答两个问题：① 界面上那句「Deep diving...」（含其计时钟）到底是
> 如何渲染出来的？② 能否写一个「驱动方法」去修改 / 触发它的呈现？
> 结论：**文案本身是 `ChatView.tsx` 里的 JSX 硬编码字面量**（未 i18n），
> 只能通过改上游源码持久改变；wire 层面只能驱动它**出现 / 消失 / 计时起点**，
> 以及做一次**临时的 DOM 文本替换**（下一帧 React 重渲染即还原）。
> 配套的可运行驱动脚本见 `exploration/fcdrivestatus.cjs`。

## 一、渲染链路（四层，均已查实）

```
宿主会话 running:boolean
        │  每帧 host frame
        ▼
manager.ts   →  mutation { kind:'status', sessionId, running }
        │
        ▼
sessions/session.ts:handleRunning(525-534)
        │  this.running = … ; publish()
        ▼
useSession(s => s.running)   // ChatView.tsx:168
        │
        ▼
{ running && <TurnStatus startTime={runningTurnStart} t={t} /> }  // :453
        │
        ▼
<div className={css.turnStatus} role="status" aria-live="polite">
     Deep diving...          ← JSX 字面量（:144，未 i18n）
     [<span>2分0X秒</span>]  ← elapsed ≥ 15s 才出现的时钟
</div>
```

### 组件本体

`deepseek-harness/packages/client/ui-conversation/src/client/chat/ChatView.tsx:119-152`
的 `TurnStatus` 组件渲染一个 `role="status" aria-live="polite"` 的 div，内含：

- **固定的文字标记** `Deep diving...`（`:144` 处 JSX 字面量）；
- **可选的时钟 span**，格式化为 `2分0X秒`（中文 locale）。

### 渲染门控

`:453`：`{running && <TurnStatus …/>}`，其中 `running = useSession(s => s.running)`（`:168`）。
**只要该 session 处于 running 状态就显示**，贯穿整个 running 区间
（等首 token + 工具执行 + 流式生成），并不随单个 step 闪烁；
`running` 翻转为 `false` 时整体卸载。

### 时钟锚点语义

`runningTurnStartTime(timeline)`（`:110-116`）：遍历 `timeline.turns`，
找**最新的 `status==='open' && start!==undefined` 回合**，取其
`start.time`（即持久化的 `turn/start` 事件时间戳）作为计时原点；
找不到则退化为组件挂载时的 `Date.now()`。
组件内置 1s 的 `setInterval` 重算 `elapsedMs`；
`showClock` 仅在 `elapsedMs >= 15_000` 时为真，再由
`formatRunDuration(elapsedMs, t)` 格式化（中文 locale 输出 `2分0X秒`）。
**中途刷新页面也能续上真实耗时**，因为锚点是落盘的时间戳而非内存值。

## 二、CSS / DOM 锚点

| 项 | 位置 | 说明 |
|---|---|---|
| shimmer 扫光 | `ChatView.module.css:74-120` `.turnStatus` | 渐变蓝 `background-clip:text` 透明填充，`animation: dsh-turn-status-shimmer 1.8s linear infinite`；`height:26px`、`white-space:nowrap` |
| 时钟样式 | `:99-106` `.turnStatusClock` | `margin-left:8px`、tabular-nums、caption 色 |
| 减动效 | `:114-120` | `prefers-reduced-motion` 关闭动画 |
| DOM 选择器 | `[role="status"][aria-live="polite"]` | e2e 定位入口 |
| e2e 锚 | `apps/web/tests/live-interactions.e2e.ts:145`、`turn-tail-actions.e2e.ts:122` | `page.getByRole('status').filter({ hasText: 'Deep diving...' })` |
| spec 断言 | `ui-conversation/tests/chat-view.client.spec.tsx:878,938,950` | `textContent === 'Deep diving...'` 或匹配 `/^Deep diving\.\.\.2分0\d秒$/` |

## 三、事实速查表

| 维度 | 结论 |
|---|---|
| **文案来源** | `ChatView.tsx:144` JSX 字面量，**未走 i18n** |
| **组件** | `TurnStatus`（`ui-conversation/src/client/chat/ChatView.tsx:119-152`） |
| **渲染门控** | `{running && <TurnStatus …/>}`（`:453`） |
| **数据源** | 宿主 `running` → `manager` `{kind:'status'}` → `session.handleRunning`(525-534) → `publish` → `useSession(s=>s.running)` |
| **时钟锚点** | 最新 open 回合的 `turn/start` 落盘时间戳（`runningTurnStartTime`，:110-116） |
| **时钟显隐** | 前 15s 纯文字，≥15s 追加 `2分0X秒`（每秒重算） |
| **DOM** | `<div role="status" aria-live="polite">`，文本前缀 `Deep diving` |
| **测试耦合** | 字符串被 e2e/snapshot 固定，改字面量需连带更新 fixtures |

## 四、驱动方法：能改什么、不能改什么

| 目标 | 可行性 | 途径 |
|---|---|---|
| **让它出现** | ✅ | wire `session.prompt`（queue 模式）注入任务使 `running=true` |
| **让它消失** | ✅ | 轮询 `session.list` 直到 `running=false`，或直接 `session.cancel` |
| **读计时锚点** | ✅ | `session.history` 提取最新 `turn/start` 时间戳（指示器计时的确切起点） |
| **临时改文案** | ⚠️ 临时 | DevTools 控制台替换该 div 的文本节点（React 重渲染即还原） |
| **持久改文案** | ⚠️ 需改源码 | 编辑 `ChatView.tsx:144` 字面量并重编 web 工件（属 `deepseek-harness` 子模块） |

**为什么 wire 层改不了文案**：`Deep diving...` 是前端 JSX 常量，wire 协议
（`session.*` / `host.*` / …）没有任何「改 UI 文案」的方法；wire 只能影响
**状态**（running），而文案由前端组件按状态渲染出来。所以持久改词只能改上游源码
（那属于 `deepseek-harness` 子模块，动它要走上游流程）；不改源码就只能做临时 DOM
替换。此外 e2e/snapshot 测试固定了 `'Deep diving...'` 这个串，改字面量还会牵连
`chat-view.client.spec.tsx:878,938,950` 与若干 fixture，这也是驱动脚本刻意走
「非侵入」路线的原因。

## 五、驱动脚本 `exploration/fcdrivestatus.cjs`

六个动词，覆盖上面表格里所有「✅」项：

```
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs [PORT] [--sid=<id>] [verbs...]
```

| 动词 | 作用 | wire 方法 |
|---|---|---|
| `smoke` | 拉会话表，打印各行 `id/running/cwd/updatedAt` | `session.list` |
| `anchor` | 从 `session.history` 读出最新 `turn/start` 时间戳（=指示器计时的确切锚点） | `session.history` |
| `appear` | queue 模式 `session.prompt` 注入多步任务，轮询直到该行 `running=true`（指示器出现，过 15s 出时钟） | `session.prompt` |
| `disappear` | 轮询直到 `running=false`（指示器卸载） | `session.list` |
| `cancel` | 立即停止当前回合（指示器即刻消失） | `session.cancel` |
| `relabel` | 输出可直接粘贴到 GUI 页 DevTools 控制台的片段，把标签文本节点换成自定义文案（如「⚡ 深挖中…」） | —（纯前端） |

### 已实测（2026-08-25，live 3080）

- `smoke` ✓ — 列出 10 个会话，其中正在跑的 `session-5ec583f8-…`（本对话）报 `running:true`。
- `anchor` ✓ — 读到 `turn/start` 时间戳 `1787626119322` ≈ `2026-08-25T02:48:39Z`，
  即此刻指示器正在为其计时的锚点。

### wire 协议要点（本次实测纠正）

- **URL 形态**：`POST /api/<namespace>.<method>`（句点连接，如 `/api/session.list`）。
- **信封**：`{"type":"client-request","rpcId":"…","method":"<namespace>.<method>","payload":{...}}`。
- **重要纠正**：`method` 字段必须与 URL 路径段**逐字相同、同为句点形**。
  写成斜杠 `session/list` 会被桥接器以
  `bad-request: method "session/list" does not match path "session.list"` 拒绝。
  （早期笔记误记为「字段斜杠 / URL 句点并存」，已由 `fcdrivestatus.cjs` 实测推翻。）
- **响应**：`{"type":"server-response","rpcId":"…","result":{"ok":true,"value":{...}}}`。
- **权威方法清单**：`deepseek-harness/packages/host/apiproxy/src/api/rpc-map.ts`。

## 六、引文表

| 位置 | 含义 |
|---|---|
| `packages/client/ui-conversation/src/client/chat/ChatView.tsx:119-152` | `TurnStatus` 组件（含 `:144` 字面量） |
| `packages/client/ui-conversation/src/client/chat/ChatView.tsx:110-116` | `runningTurnStartTime` 时钟锚点算法 |
| `packages/client/ui-conversation/src/client/chat/ChatView.tsx:168,453` | `useSession(s=>s.running)` 与渲染门控 |
| `packages/client/ui-conversation/src/client/chat/ChatView.module.css:74-120` | shimmer 扫光 / 时钟 / 减动效 |
| `packages/client/runtime/src/client/sessions/session.ts:525-534` | `handleRunning` 置 `running` 并发布 |
| `packages/client/runtime/src/client/sessions/manager.ts` | `{kind:'status'}` 变更来源 |
| `packages/host/apiproxy/src/api/rpc-map.ts` | 41 个 wire 方法权威清单 |
| `apps/web/tests/{live-interactions,turn-tail-actions}.e2e.ts` | `getByRole('status')` 定位 |
| `ui-conversation/tests/chat-view.client.spec.tsx:878,938,950` | 固定 `'Deep diving...'` 串的断言 |
| `exploration/fcdrivestatus.cjs` | 配套驱动脚本 |

## 七、复现命令

```bash
# 1. 冒烟：拉会话表（当前 running 的行就是正在跑的那个）
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 smoke

# 2. 读计时锚点：最新 turn/start 时间戳
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 anchor

# 3. 指定会话出现 / 消失 / 取消
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 --sid=<id> appear
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 --sid=<id> disappear
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 --sid=<id> cancel

# 4. 输出临时改文案用的 DevTools 片段
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 relabel

# 5. 核对源码字面量位置（持久改词需从这里下手）
rg "Deep diving" D:\deepseek-harness-plugins\deepseek-harness\packages\client\ui-conversation\src
```
