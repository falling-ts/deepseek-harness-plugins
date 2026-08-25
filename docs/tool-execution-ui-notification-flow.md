# 工具执行状态与 UI 通知流向分析

> 本文档梳理 `ctx` 体系中代码执行（工具调用 / 进程生命周期）状态如何被记录、
> 如何流向用户界面，以及哪些通道是「模型可见」、哪些是「纯 UI 装饰」。
> 结论先行：**`ctx` 里没有专门的「通知服务」**——UI 看到的永远是
> ① 对会话事件日志（`ctx.sessions.append`）的订阅，或
> ② 进程句柄（`ShellProcess` / `SubprocessHandle`）的直接轮询 / 监听。
> 不存在 `ctx.notify` / `ctx.ui.push` 这类直推接口。

## 一、两个独立通道

| 通道 | 载体 | 谁产生 | UI 怎么看到 | 是否计入 tokens |
|---|---|---|---|---|
| **A · 模型可见** | `tool/call`、`tool/result` 事件 | `ToolRuntime`（`ctx.tools`）+ 工具 provider（`ctx.shell` / `ctx.subprocess` 等） | 客户端 `Session` 对象订阅日志 → `HostObservable` 推送 | ✅ `tool/result` 属三类 surface 之一；`tool/call` 不进 surface |
| **B · 纯 UI 装饰** | 进程句柄的 `status` / `done` / `readOutput()` / `waitForExit()` | `ShellExecutor.start()` / `SubprocessHandle` 返回值 | 组件层直接 poll 或 listen 句柄 | ❌ 不记日志、不投影、不入 surface |

---

## 二、通道 A：工具执行的「权威账本」

### 2.1 `ctx.tools`（`ToolRuntime`）——唯一工具派发中枢

`packages/core/tools/src/index.ts:787`：

```ts
export class ToolRuntime extends Service {
  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({
    mode: z.enum(['native', 'code', 'both']).default('native'),
    maxParallelSubCalls: z.natural().min(1).default(10),
  })

  /** Internal staged view consumed by dsh-agent-loop's parallel scheduler. */
  readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler = {
    prepare:  exec => this.prepareScheduledExecution(exec),
    dispatch: exec => this.dispatchScheduledExecution(exec),
    finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
    finish:   (exec, result) => this.finishScheduledExecution(exec, result),
  }
  // …
}
```

职责：
- 注册 / 注销 / 按 scope 链过滤可见工具集。
- 按 `executionMode(exec)` 决定当前调用是**独占屏障**还是**并行池**成员。
- 走 `tools/execute` waterfall（正是 `timeout-policy` 插件用来拦截超时的挂载点）。
- 把每次调用的 `signal`、`callId`、`arguments` 打包成 `ToolExecutionInput` 交给调度器。

### 2.2 `agent-loop` 的 `tool-calls.ts`——真正写日志的位置

`packages/core/agent-loop/src/tool-calls.ts:262-289`：

```ts
/** Append a started call and return the event seq that its result must cite. */
function appendToolCall(session, turn, step, block): number {
  const event = session.append('tool/call',
    { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}

/** Append a model-ordered result linked to its call event. */
function appendToolResult(session, turn, step, block, result, callSeq): void {
  const message = createToolResultMessage({
    callId: block.id,
    content: result.content,
    isError: result.isError,
  })
  session.append('tool/result', {
    turn, step,
    message,
    ...result.error?.info ? { error: result.error.info } : {},
    // The tool's private presentation payload (e.g. a result-time diff),
    // persisted so a UI bridge reproduces the card on replay.
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
```

关键设计决策：
- `tool/call` **是 log-only**（不在三类 surface 白名单），只用于关联、回放与「取消补账」。
- `tool/result` **是 surface**，`sourceEventSeqs:[callSeq]` 把它钉回那次调用，形成不可断裂的因果对。
- **结果里的 `meta` 字段是「UI-only」通道**：`tool-fs` 在这塞 `presentation:'diff-card'`，
  `tool-shell` 在这塞 `presentation:'terminal-card'` 之类。`meta` **不进模型 tokens**
  （surface 投影时只取 `message` 字段），但随 `tool/result` 一同被客户端订阅，
  UI 卡片据此精准还原。

### 2.3 超时 / 取消的「状态」如何落地

`packages/guard/timeout-policy/src/index.ts`（`ToolTimeoutPolicy` 插件）：

```ts
using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
// … dispatch …
if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) {
  return toolTimeoutResult(timeoutMs)   // → ToolExecutionResult
}
```

- **超时不单独记事件**——它就是最终的 `tool/result`，内容是：

  ```ts
  {
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' } },
    content: 'Error: tool call timed out after <ms>ms',
  }
  ```

- **取消**同理：`appendSkippedToolCall`（`tool-calls.ts:249-259`）会给未启动的调用
  补一条合成的 `tool/result`，内容固定为 `"Error: tool call aborted before dispatch"`，
  保证日志永远满足「调用必有结果」，回放不裂。

### 2.4 `ctx.shell` / `ctx.subprocess` 的进程句柄——活状态的另一半

`packages/shell/shell/src/types.ts:161`：

```ts
export type ShellProcessStatus = 'running' | 'completed' | 'killed'

export interface ShellProcessRead {
  delta: string                                  // 自上次读取以来的增量
  lossy: boolean                                 // 是否丢了字节
  stdoutSpillPath?: string                       // stdout 溢出文件（可选）
  stderrSpillPath?: string
}

export interface ShellProcess {
  status: ShellProcessStatus                     // 进程生命周期（三态）
  exitCode: number | null                        // 结束后可读（null = 信号杀死 / 仍在运行）
  signal: NodeJS.Signals | null                  // 终止信号名
  readonly done: Promise<void>                   // 结束时 resolve
  sandbox?: ShellSandboxInfo
  readOutput(): ShellProcessRead                 // 消费型，连续读不重投
  kill(): boolean                                // false = 已经结束
}
```

`packages/subprocess/subprocess/src/types.ts:167` 的 `SubprocessHandle` 更底层：

```ts
export interface SubprocessHandle {
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  terminate(): void                              // SIGTERM → grace → SIGKILL
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
```

**这两条通道是「活状态」**：
- 进程还在跑时，UI 卡片周期性调 `readOutput()` 拿增量、拼接到本地 buffer 显示。
- 结束后 `status` 变终态、`done` resolve、UI 切换最终视图。
- **全程不落日志**——日志里只有最后那条 `tool/result`（含完整收集输出或溢出文件路径）。

---

## 三、通道 B：客户端如何把状态「推到界面」

### 3.1 宿主端：事件 → `HostObservable`

`packages/client/runtime/src/client/sessions/service.ts`：
客户端的 `Session` 对象**订阅宿主会话的事件窗口**。每条事件进来后，按 `type`
路由到对应的 `HostObservable`（snapshot store 引擎，zustand/immer 背板，
`markFrameDirty` 微任务批量化）。这是 UI 感知「日志变化」的唯一入口。

### 3.2 UI 端的三种消费姿势

| 需求 | 用什么 | 例子 |
|---|---|---|
| **一次性状态**（某条消息的点赞数） | `HostObservable<T>` + 框架 `useXxx` 钩子 | `ui-message-feedback` 的 `MessageFeedbackView.status: 'cold'\|'loading'\|'ready'\|'error'` |
| **活流**（后台进程输出、终端滚动） | 句柄的 `readOutput()` / `done` poll | 终端卡片、构建进度面板 |
| **槽位化 UI**（工具卡片、自定义视图） | `ctx.slots.register` + `renderSlot` | `tool.call.toolview` 槽，`tool-fs` / `tool-shell` / `tool-subprocess` 各自贡献 |

`packages/client/AGENTS.md` 三条纪律（此处摘录）：
- **组件不许直接摸 `ctx`**——所有数据要么走 props（四份 share：`PropsRuntime` /
  `PropsRenderSlots` / `PropsStore` / inject face），要么走 `HostObservable` 订阅。
- **业务组件禁手搓订阅机制**——禁 `useSyncExternalStore` 裸调、禁手动 mirror
  外部快照进本地状态。
- **组件内行为钩子**允许存在（如内部 `useState` / `useEffect`），只要不订阅外部。

### 3.3 `HostObservable` 的最小定义

```ts
// packages/client/runtime/src/client/sessions/types.ts
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(cb: (snap: T) => void): Unsubscribe
}
```

两条身份稳定性约束（AGENTS.md 规则 5）：
- **源对象本身稳定**——hook 绑定缓存按源对象 key，同一源反复传入不重复订阅。
- **两帧之间快照引用相同**——`getSnapshot()` 在同一次事实变更前后返回同一引用。
发布端纪律：`notifyNow` 只用于用户手势即时回声；结构性更新用 `markDirty`
微任务合并；可视化流式 chunk 用累计 `markFrameDirty`。

---

## 四、完整的调用图

```
模型发出 tool call
        │
        ▼
┌────────────────────────────────────────────┐
│  agent-loop                                 │
│  executeToolCalls(ctx, turn, step, blocks) │
│                                              │
│  ├─ ctx.sessions.append('tool/call', …)     │  ← log-only
│  ├─ ctx.tools.executionMode(exec)            │  ← 判并发
│  └─ 按组调度 runGroup                        │
└────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────┐
│  ctx.tools (ToolRuntime)                    │
│                                             │
│  ├─ waterfall 'tools/execute'              │
│  │   ├── timeout-policy 挂 deadline        │
│  │   └── 其它拦截器（归因、重试、审计）      │
│  └─ 把 exec.signal / callId / args 交出去  │
└────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────┐
│  工具 provider                                │
│  （各能力插件）                               │
│                                             │
│  ├─ ctx.shell.run / start  → ShellExecutor │
│  ├─ ctx.subprocess.spawn   → SubprocessHandle │
│  └─ 其它能力……                              │
└────────────────────────────────────────────┘
        │ 返回                                     │ 活状态
        ▼                                          ▼
┌────────────────────────────────────────────┐  ┌──────────────────────────────┐
│ ctx.tools.dispatch 返回                       │  │ ShellProcess / Handle        │
│ ToolExecutionResult                           │  │                            │
│ { content, isError, error, meta }            │  │ status / done / readOutput   │
└────────────────────────────────────────────┘  │ （UI 直接 poll 或 listen）     │
                                                └──────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────┐
│ agent-loop                                    │
│                                            │
│  ctx.sessions.append('tool/result', …,     │
│    { surfaceOp:'append',                    │
│      sourceEventSeqs:[callSeq] })          │
│                                            │
│  meta: 工具私有的 UI 载荷（presentation 等）  │
│  → 进 surface，下回合模型看得到 message 部分  │
│  → meta 不进 surface（不进 tokens）         │
└────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────┐
│ 客户端 Session 订阅                           │
│                                            │
│  ├─ HostObservable 更新                     │
│  ├─ 组件层 useXxx 钩子收到新帧             │
│  └─ 工具卡片按 meta.presentation 渲染       │
└────────────────────────────────────────────┘
```

**一句话总结**：
> **`ctx.tools` 管账本（dispatch + waterfall），`ctx.shell` / `ctx.subprocess` 管进程活状态，
> `ctx.sessions` 管落盘，客户端的 `HostObservable` 管推送。
> 没有单独的「通知服务」——UI 看到的永远是日志订阅或句柄轮询，不是 push notification。**

---

## 五、对插件作者的含义（以 `dsh-force-compact` 为例）

若你要让 force-compact 也出一张「正在压缩…」进度卡片：

1. **不要**造 `ctx.forceCompactNotify` 之类的东西——这条路径设计上不存在，
   组件层也不许直接摸 ctx。
2. **正路 · 落盘路线**：在 `fc-compact/summary` 事件 append 之后，**顺手 append
   一条 `tool/result`**，`meta: { presentation: 'force-compact-progress' }`——
   然后在插件 `apply` 阶段
   ```js
   ctx.slots.inject('tool.call.toolview', () =>
     ctx.slots.register({ name: 'tool.call.toolview.force-compact' }, ForceCompactCard))
   ```
   就在现有工具卡槽里贡献你自己的视图。
3. **正路 · 活流路线**：把进度做成 `HostObservable`——插件 `apply` 里维护
   `currentProgress: HostObservable<ForceCompactProgress>`，客户端组件通过
   inject face 绑定的 `useForceCompactProgress()` 钩子订阅。适合「活流」，
   不适合「落盘事实」。
4. **`meta` 是免费的**：`tool/result` 的 `meta` 字段专门留给
   「core 不认识、UI 需要的展示载荷」。只要 JSON 可序列化，客户端想取就取，
   完全不动 core 任何代码。

---

## 六、引文表

| 位置 | 含义 |
|---|---|
| `packages/core/tools/src/index.ts:787` | `ToolRuntime extends Service` 类头 |
| `packages/core/agent-loop/src/tool-calls.ts:262-289` | `appendToolCall` / `appendToolResult` 两处 |
| `packages/core/agent-loop/src/tool-calls.ts:249-259` | `appendSkippedToolCall` 取消补账 |
| `packages/guard/timeout-policy/src/index.ts:25,39-48,61,72-74` | `TOOL_TIMEOUT` 常量、构造、`deadline` 包裹、替换判断 |
| `packages/shell/shell/src/types.ts:140-179` | `ShellProcessStatus` / `ShellProcessRead` / `ShellProcess` 三个接口 |
| `packages/subprocess/subprocess/src/types.ts:167-194` | `SubprocessHandle` 接口 |
| `packages/client/runtime/src/client/sessions/service.ts` | 客户端 `Session` 订阅逻辑 |
| `packages/client/AGENTS.md` | 组件层三套纪律（ctx 不可达 / 订阅机制禁手搓 / 四份 props share） |
| `packages/core/session/src/surface.ts:15-19` | surface 白名单三类：`user/message` / `assistant/message` / `tool/result` |
| `packages/core/session/src/surface.ts:83-114` | `deriveEventMessage` 唯一逐节点投影规则 |
| `docs/session-jsonl-structure.md`（同仓） | 50 种核心事件类型分类、surface 资格矩阵、`ignorable` 逃生口 |

## 七、复现命令

```bash
# 1. 确认 tool/call / tool/result 确实是落盘的两兄弟
rg "session.append\('tool/(call|result)'" \
  D:\deepseek-harness-plugins\deepseek-harness\packages\core\agent-loop\src

# 2. 确认 tool/call 是 log-only、tool/result 才是 surface
rg "deriveEventMessage|isSurfaceEligible" \
  D:\deepseek-harness-plugins\deepseek-harness\packages\core\session\src\surface.ts

# 3. 找出超时插桩位置
rg "deadline\(exec\.signal|timeoutOf\(d\.signal" \
  D:\deepseek-harness-plugins\deepseek-harness\packages\guard\timeout-policy\src

# 4. 找出进程句柄的两个接口
rg "interface (ShellProcess|SubprocessHandle)" \
  D:\deepseek-harness-plugins\deepseek-harness\packages

# 5. 观察真实会话中 tool/result 携带的 meta（用之前的 fcdumplogs 脚本）
node D:\deepseek-harness-plugins\exploration\fcdumplogs.cjs --only tool/result --limit 3
```
