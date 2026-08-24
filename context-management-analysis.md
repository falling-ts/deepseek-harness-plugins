# DeepSeek Harness Context 管理全流程分析

> 本文基于源码（`packages/core/session`、`packages/llm/token-meter`、`packages/session/*`、`packages/client/*`、`packages/compaction/*`）与仓库 docs（`docs/architecture.md`、`docs/agent-lifecycle.md`、`docs/subsystems/session.md`、`docs/subsystems/persistence.md`）以及本机真实落盘文件（`~/.dsh/sessions/**/session.jsonl.zstd` 实测解压）交叉验证，覆盖用户提出的六个维度：
>
> 1. 整套 context 管理流程
> 2. context 数据结构
> 3. 保存的文件类型与内容结构
> 4. 聊天窗口如何显示 / 分析
> 5. 上下文大小如何计算
> 6. 不同工具与内容如何记录
>
> 文中「实测」标记的样例来自本机 `~/.dsh/sessions/--D-DSH--/session-6223a091…/session.jsonl.zstd`（2 MB、6446 个 zstd 帧、7753 条事件）的逐帧解压。

---

## 0. 核心思想：事件溯源（Event Sourcing）

DeepSeek Harness（下称 DSH）的 context 管理建立在一个核心不变量上：

> **Session 是一条只追加（append-only）的、带类型的事件日志（typed `SessionEvent`），它是唯一事实来源（single source of truth）。**

由此派生三条设计原则：

1. **LLM 历史是派生的，不是存储的。** 模型看到的 `messages` 数组从不单独落盘，而是每次按需由事件日志 `deriveMessages()` 投影得到。日志记录的是「发生了什么」（用户说了什么、模型回了什么、工具调用与结果），历史是这些事实的一个视图。
2. **「模型可见」⟺「已记录」（Model-visible means logged）。** 任何要让模型看到的新输入，都必须对应一条新的 session 事件。反过来，不在模型 surface 上的事件（如诊断类、标题类）是「日志可见但模型不可见」。这条不变量让 context 的边界与持久化的边界一致。
3. **Surface = 模型可见事件的有序子集。** 日志中一部分事件是 append-origin（用户消息、助手消息、工具结果、注入 context），它们天然在 surface 上；另一部分（如 compaction 诊断、标题 LLM 请求）只进日志、不进 surface。Surface 用一个「有序 seq 列表」维护，支持 O(1) 追加与 O(new) 替换（compaction 用 `replace` 把一段历史折叠成一个 checkpoint，被折叠的事件仍留在日志里、只是被「阴影」出 surface）。

**版本策略**：`SESSION_FORMAT_VERSION = 0`（pre-release，尚无兼容性负担）。逻辑事件的 `seq` 严格连续（`events[i].seq === i`），`log.length` 即下一条事件的 `seq`。（注意：首帧是 `SessionHeader`、无 seq；流式 chunk 以打包行落盘、行本身只有 `seq0`——见 §2.1。）

**热路径 vs 持久化**：事件追加是同步的（热路径），持久化采用 write-behind（写后缓冲），在 await 的 `session/flush` 检查点处排空（drain）。这把「记录」与「落盘」解耦，模型循环不因磁盘 I/O 阻塞。

---

## 1. 整套 Context 管理流程

### 1.1 会话启动

1. **Profile / Bundle 装配**：`dsh web` 按 profile 加载 bundle 插件树（core 包提供 `ctx.sessions` / `systemPrompt` / `tools` / `agents` / `agentLoop` / `llm` 等 Service）。
2. **Session 创建**：生成 `SessionHeader`（`{type:"session", version:0, id, createdAt, cwd, delegationDepth, agentPreset}`）作为日志第一行（header 帧）。
3. **预设与策略登记**：会话开头追加一条策略类事件，记录本会话的运行环境（实测样例）：
   ```json
   {"type":"permission/preset","seq":0,"data":{"preset":"danger-full-access"}}
   {"type":"sandbox/mode","seq":1,"data":{"mode":"danger-full-access"}}
   {"type":"approval/policy","seq":2,"data":{"policy":"never"}}
   {"type":"agent-preset/selected","seq":3,"data":{"agentPreset":"cordis"}}
   ```
   这些是「日志可见、模型不可见」的元事件，供恢复与审计。

### 1.2 单步（step）上下文组装 —— 核心循环

来自 `docs/agent-lifecycle.md` 的 mermaid 时序（已验证）。每个 step 的顺序是严格的：

```
turn/start
  → 认领下一步输入（claim next-step input，先于 pre-step）
  → system-prompt/assemble + 工具 schemas
      → 记录 request/header（EpochHeader：config + system + tools，整包落盘）
      → 记录 request/context（{provider, model, contextWindow}）
  → agent/pre-step 瀑布（reject | enter(messages)）
      → compaction-basic 的压力压缩挂在这里（见 §5.4）
  → step/start
  → 对 enter 后的每条消息追加 user/message
      → user/message 批次在 request 派生之前追加（顺序契约）
  → deriveMessages() 投影出本次 request 的 messages
  → agent/request 瀑布
  → llm/stream 瀑布
      → assistant/chunk*（流式分块：text-chunks / reasoning-chunks / tool-call-chunks）
  → 装配并追加 assistant/message（携带 usage，sourceEventSeqs 指向其 chunk 的 seq）
      → provider 输出在工具分发之前装配+追加（顺序契约）
  → tool/call*（每条携带 callId + 原始 JSON 字符串 arguments）
  → tools/pre-execute → tools/execute → tools/post-execute
  → tool/result*（ToolResultMessage，sourceEventSeqs 指向其 tool/call）
  → step/end
  → （循环回 step 开始）
→ agent/turn-stopping 瀑布
→ turn/end {reason: TurnEndReason}
```

**顺序契约**（`2026-06-11-event-sourced-sessions.md`）：
- 循环在 pre-step **之前**认领 inbox；
- `step/start` 只在 `enter` 之后；
- `user/message` 批次在 request 派生**之前**追加；
- provider 输出在工具分发**之前**装配并追加。

这套顺序保证：任何模型可见的输入都已先于模型看到它而被记录，从而「模型可见 ⟺ 已记录」成立。

### 1.3 持久化：write-behind + flush 检查点

事件同步追加到内存 `Session`（热路径），同时进入 write-behind 缓冲。write-behind 由 `SessionWriteBehind`（`packages/session/session-persistence/src/write-behind.ts`，**每 live session 一个**）+ `coordinator.ts` 的 `ctx.on('session/flush')`（`:1129`）实现：

- **`enqueue(event)`**（`:45`）：把事件 `structuredClone` 拷入 `pending` 队列（与生产者解耦）；若队空且无 barrier，`armTimer` 启动固定 `maxDelayMs` 计时器。
- **自动路径**：`maxDelayMs` 空闲后 `onDeadline` → `startBackground`——一个 **detached 写**；失败**不**拒绝生产者，而是经 `reportBackgroundFailure` 上报并**保留**批次。
- **`flush()`**（`:63`）：取消计时器、建一个**共享 `barrier` promise**，`drainBarrier` 排空到 quiescence。并发调用者 **join 同一 barrier**（一次 barrier 排空所有 admitted tail）。`session/flush` 事件是 await 的并行持久化检查点（`ctx.parallel('session/flush', session)`）。
- **失败保留**：`startWrite`（`:139`）`splice` 出批次；durability 失败时 `this.pending = batch.concat(this.pending)` **按序重排回队首**、置 `automaticPaused`、后台写则 `reportBackgroundFailure`。
- **barrier 关闭**：`drainBarrier` 在观察到空队列的**同一 job** 内置 `barrier = undefined`，使后续 `enqueue` 开启自己的自动窗口而非被已 settle 的 barrier 卡住。
- **`cancelAutomaticWait()`**：取消计时器但**不**排空保留的工作。

崩溃恢复：append-only、绝不截断；孤儿未闭合 turn 用合成 `turn/end {kind:"interrupted"}` + 合成 tool 结果 + 缺失的 `step/end` 关闭（仅冷检查 `inspect` 时）；`prepare`/`load` 提交修复；live `load` 等待 durable balanced snapshot。

### 1.4 压缩（compaction）流程

来自 `packages/compaction/compaction-basic`（详见 §5.4）：

1. **触发**：两条路径
   - **压力路径**：`agent/pre-step` 每步检查 `measurement.totalTokens >= thresholdTokens`（默认 `contextWindow × 0.8`）。
   - **溢出路径**：`agent/request-error` 命中 `CONTEXT_WINDOW_EXCEEDED_CODE` 时绕过阈值/保留策略直接压缩（retain=0）。
2. **可选裁剪**：`toolResultPruner.pruneSession(...)`（模型无关地修剪旧 tool 结果），随后**重测** token。
3. **选择可压缩区间**：`selectCompactableRange` 从 surface 尾部累加 token 直到 `>= retainTokens`（默认 `contextWindow × 0.16`），回退到工具对平衡边界。
4. **生成摘要**：调用 LLM 生成 checkpoint，校验「摘要比被阴影区间更小」（否则抛错）。
5. **提交**：追加 `compaction/summary`（携带 `shadowedRange` + `shadowedTokenCount`）+ 一条 `user/message` 的 `replace`（把区间折叠成一个 checkpoint 消息）。
6. 最多重试 `compactionRetries + 1` 次，仍超阈值则抛「still above threshold after N attempts」。

### 1.5 token meter 作为共享压力 oracle

`ctx.tokenMeter`（`@deepseek-ai/dsh-token-meter`）是所有 context 大小判断的唯一来源，被 agent-loop、compaction-basic、UI 共同消费。它不做配置、固定启发式（4 字符/token + 结构开销），并提供按 session 的增量回放折叠（详见 §5）。

> **重要**：`agent-loop` 驱动本身**不直接**调用 token meter、也不做压力检查。压力/溢出压缩是独立能力（compaction 插件）挂在 step 边界上（§1.4 / §5.4）。驱动只负责组装 envelope、派生 messages、驱动流式与工具执行。

### 1.6 单步组装细节（`ReactLoopAgent` 驱动）

所有函数位于 `packages/core/agent-loop/src/agent.ts`（除特别注明）。逐函数顺序：

| 序 | 函数 | 动作 |
|----|------|------|
| 1 | `ReactLoopAgent` 构造器 | 经 `agentEvents()`（`packages/core/agent/src/dispatch.ts:158`）构建融合 dispatcher；创建 `Inbox`（`packages/core/agent/src/inbox.ts:25`）；读 `session.events.findLast(e => e.type === 'turn/start')` 得 `lastTurn`。 |
| 2 | `#run()` | phase → `running`，调用 `#processStep()`。 |
| 3 | `#processStep()` | `inbox.claim(target, turn)` 认领 next-step + next-turn 消息；把它们作为 `user/message` 事件追加；再调 `#runStep()`。 |
| 4 | `#runStep()` | 追加 `step/start`；调用 `#runLlmRequest()`。 |
| 5 | `#runLlmRequest()` | `#assembleStep()` → `#dispatchLlm()` → `#processAssistant()`。 |
| 6 | `#assembleStep()` | (a) `requestProposal(session.requestHeader())` 从 held config 剥离 adapter-default 字段；(b) `ctx.serial('agent/request', {agent, turn, step, config}, defaultConfig)` —— `agent/request` 瀑布；(c) `ctx.llm.prepareCall(config, signal)` → `PreparedLlmCall`；(d) `session.append('step/start', {turn, step})`；(e) `ctx.serial('agent/pre-step', {agent, turn, step, messages: claimed}, defaultPreStep)` —— pre-step 瀑布；(f) 若 `reject` → 追加 `step/end` 返回；若 `enter` → 把认领消息作为 `user/message` 追加。 |
| 7 | `#assembleStep()`（续） | `boundaryMessages = session.deriveMessages()`；`requestHeader = session.requestHeader()`；构造 `request = {…header.config, messages: boundaryMessages, system: header.system, tools: header.tools, sessionId, signal}` 并深冻结、`markAgentLoopRequest()`；若折叠后的 header 与 held 不同或首次（`requestHeaderLogged` 标志）则追加 `request/header`（reason `initial`/`resume`/`change`）；若 provider/model/contextWindow 变化则追加 `request/context`。 |
| 8 | `#dispatchLlm()` | `stream = preparedCall?.stream(request) ?? ctx.llm.stream(request)`；`llm/stream` 瀑布在 `LlmRuntime.stream()`（`packages/llm/llm/src/index.ts:985–998`）内接线。 |
| 9 | `#processAssistant()` | 遍历 chunk 流；每 chunk 追加 `assistant/chunk`；`finish` 时用 `createAssistantMessage()`（`packages/llm/llm/src/index.ts`）装配 `AssistantMessage`，追加 `assistant/message`；若含 `toolCall` 块则调 `#processToolCalls()`。 |
| 10 | `#processToolCalls()` | `executeToolCalls()`（`packages/core/agent-loop/src/tool-calls.ts:59`）；每块追加 `tool/call`；每条 call：`tools/pre-execute` → `tools/execute` → `tools/post-execute` 瀑布 → 追加 `tool/result`；再追加 `step/end`。 |
| 11 | `#processStep()`（step 后） | 若 `executeToolCalls` 返回 `concluded: true` → 追加 `agent/turn-stopping` 再 `turn/end`；否则若 `inbox.hasPending` 为真 → 再调 `#runStep()`（循环）；否则追加 `turn/end {completed}`。 |

**关键函数行号**（`packages/core/agent-loop/src/agent.ts`）：`requestProposal()` ≈ line 55；`#assembleStep()` ≈ 350–514；`#dispatchLlm()` ≈ 515–540；`#processAssistant()` ≈ 540–650；`#processToolCalls()` ≈ 650–750。

### 1.7 系统提示与工具 Schema 装配

**系统提示注册表**（`packages/core/system-prompt/src/index.ts`，`SystemPrompt` 服务）：

- 贡献者经 `ctx.systemPrompt.section(name, order, text)` 与 `ctx.systemPrompt.context(name, order, text)` 注册。
- `PromptSection`（`name`/`order`/`text: string | (ctx)=>string`/`complete?`）按 `order` 升序拼接成系统提示。
- `PromptContext` 拼入动态 context 快照，经 `RuntimeContextProjection`（`packages/core/agent-loop/src/runtime-context.ts:25`）物化为一条 durable `user/message`。
- 约定：`order -100` = harness 身份，`0` = 部署 persona，`100–199` = 工具指引。

**`assemble(context)`**（`index.ts:521–542`）：收集 scope 内所有 section/context → 用 `AssembleContext`（携带 `agent`/`signal`）求值函数型 `text` → 构造 `PromptAssembly {sections, contexts, tools, variables}` → 运行 `system-prompt/assemble` 瀑布（scope 过滤，监听者可改写）→ 若有 `complete:true` section 生效则恢复为唯一 section；若 `runtimeContextSuppressed` 则清空 contexts → 返回变换后的 `PromptAssembly`。

**`renderPrompt(assembly)`**：按序拼接 section、用 `assembly.variables` 插值 `{{variable}}`、返回渲染后的系统提示文本。**`joinContextSections` / `renderContextSections`** 分别把 context section 合并为单一文本 / 逐个渲染。

**工具 Schema**（`packages/core/tools/src/index.ts`，`ToolRuntime`）：

- `ctx.tools.schemas(scope?)`（`:1234`）——为每个可见工具返回一个深克隆 `ToolSchema`，仅白名单 `name`/`description`/`parameters`（排除 `execute` 与展示回调）。
- `schemaOf(definition, detachParameters)`（`:1256`）——把单个定义投影到模型可见 schema 字段。
- `wireSchemas(scope)`（`:980`）——构造 wire schema 与名字用于 prompt-order 校验；`code` 模式下只投影 `run_code`。
- `ToolRuntime` 构造器注册 `systemPrompt.tools()` 提供器：`ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))`（`:832`），使 schema 经 system-prompt 装配进入 `PromptAssembly.tools`，最终进入 `request/header`。

**`EpochHeader`**（`packages/core/session/src/types.ts:201`）= `{config: LlmCallConfig, adapterDefaults?, system?, tools?}`。`assembleStep()` 中经 `agent/request` 瀑布提出替换 config → `prepareCall` 校验并物化 adapter defaults → `session.append('request/header', {header, reason})`。

**何时追加新 `request/header` 快照**：
- `initial`：日志首个 header（新会话）。
- `resume`：某循环实例在已有 header 事件的日志上的首个请求（进程重启、fork seed）。
- `change`：后续请求用了不同 header（config/system/tools 变化）。

header 比较用 `headerEquals()`（`packages/core/session/src/request-header.ts:44`，按字段比较 canonical header；tool schema 按序 JSON 相等）；`canonicalHeader()`（`:21`）把空 system/空 tools 归一化为缺省字段。

### 1.8 Inbox 与注入 context（`agent.inject()`）

- `agent.inject()` 追加一条 `user/message` 事件，`source.kind = 'plugin'` + 插件专属 `plugin` 名。
- `Inbox`（`packages/core/agent/src/inbox.ts:25`）维护两个待发列表：`next-turn` 与 `next-step`。
- `Inbox.claim(target, turn)`（`:71`）移除并返回一个 step 的完整批次：next-step 输入 +（当 `target === 'next-turn'` 时）排队的 turn。
- `Inbox.append(target, message)`（`:86`）/ `Inbox.prepend(target, message)`（`:96`）经 `agent/inbox/spliced` 事件 durable 记录插入（含 `removedCount` 与 `inserted` 字段）。
- **注入 context 在 inbox 中等待，直到下一条消息唤醒**：被追加到 `next-step`/`next-turn` 列表，直到下一个 step 边界的 `claim()` 被消费为批次一部分。

### 1.9 `agent/pre-step` 瀑布：改写或拒绝

- `ctx.serial('agent/pre-step', {agent, turn, step, messages: claimed}, defaultPreStep)`。
- **默认**（`defaultPreStep`）：返回 `{kind:'enter', messages: claimed}`——认领消息原样进入 step。
- **改写**：监听者可返回 `{kind:'enter', messages: modified}`——step 以修改后消息进行。
- **拒绝**：监听者返回 `{kind:'reject'}`——step 不消耗、关闭；turn 以 `blocked` 结束。
- **被拒/空认领仍闭合 durable turn**：`reject` → `assembleStep()` 追加 `step/end` 返回；`processStep()` 追加 `turn/end {reason:{kind:'blocked'}}`。`foldConsumedWork()`（`packages/core/agent/src/consumed-work.ts:68`）把 `blocked` end over claimed input 计为有效已消费工作（`accountsForClaim()` 对 `blocked` 返回 `true`）。空认领（inbox 无消息）→ `processStep()` 追加 `turn/end {reason:{kind:'completed'}}`——一个平衡的 no-op turn。

### 1.10 `deriveMessages()` 与 `request/context`

- `Session.deriveMessages()`（`packages/core/session/src/index.ts:726`）——对 surface 的缓存折叠：
  - **surface 合格事件类型**（`packages/core/session/src/surface.ts:15–19`）：`user/message`、`assistant/message`、`tool/result`。
  - **投影规则**（`deriveEventMessage()`，`surface.ts:83`）：`user/message` → `UserMessage`；`assistant/message` → `AssistantMessage`（空 content 则跳过——只为承载 usage 而存在）；`tool/result` → `ToolResultMessage`；其它（chunk、边界、仅日志记录）→ `null`（跳过）。
  - **缓存**：每个 surface 节点只投影一次；surface 重写（compaction `replace`）重建缓存。
- `session.append('request/context', {provider, model, contextWindow})`——仅当路由或容量变化时记录。`Session.requestContext()`（`index.ts:691`）返回最新折叠的 `RequestContext {provider, model, contextWindow?}`。

---

## 2. Context 数据结构

### 2.1 SessionEvent 信封（envelope）

每条事件统一信封（实测样例，`tool/result`）：

```json
{
  "type": "tool/result",
  "seq": 195,
  "time": 1787520120940,
  "data": {
    "turn": 1,
    "step": 1,
    "message": {
      "source": { "kind": "tool", "callId": "lLAleNz9…" },
      "content": [
        { "type": "tool-result", "toolCallId": "lLAleNz9…",
          "content": [ { "type": "text", "text": "{…工具输出…}" } ],
          "isError": false }
      ],
      "role": "user",
      "id": "0036513b-…"
    }
  },
  "sourceEventSeqs": [194],
  "surfaceOp": "append"
}
```

字段：

| 字段 | 含义 |
|------|------|
| `type` | 事件类型（见 2.2 词表）。 |
| `seq` | 在日志中的位置，**必填**（`SessionEvent` 类型 `seq: number`），逻辑事件严格连续（`log.length` 即下一条的 `seq`，`Session.append` 处 `seq: this.log.length`，`index.ts:629`）。 |
| `time` | 毫秒时间戳（Unix epoch）。 |
| `data` | 类型特定的载荷（见 2.2）。 |
| `sourceEventSeqs?` | 仅 `SurfaceEventType`（`user/message`、`assistant/message`、`tool/result`）携带；引用其它事件的 seq 数组。`assistant/message` 指向其 chunk 的 seq；`tool/result` 指向其 `tool/call`；compaction 的 `replace` 指向被折叠区间的 seq。显式 `[]` = 已知空流。非 surface 事件（边界标记、chunk、usage、错误）**从不**携带 surface 元数据（编译器在 `Session.append()` 调用点强制）。 |
| `surfaceOp?` | 仅 `SurfaceEventType` 携带。`append`（surface 追加）或 `{op:"replace", start, end}`（把区间 `start..end` 替换为本事件，被替换事件留在日志但阴影出 surface）。缺省 = 非 surface 事件（只进日志）。 |
| `ignorable?` | `true` = 读者可安全跳过（恢复时跳过）。**缺省 = 必填**：读者遇到无此标记的未知 `type` 必须**拒绝**重建而非静默丢弃（因未识别的必填事件可能改变对日志其余部分的解读）；写者只对纯信息性记录设 `true`。默认必填让「漏标」偏向过度拒绝（不便）而非静默继续残缺会话。 |

> **实测**：一条 2MB 日志中，226 条带 `surfaceOp`、其中 14 条是 `replace`；211 条带 `sourceEventSeqs`。

> **两个信封 nuance**（已实测核实）：
> 1. **首帧是 `SessionHeader`，不是事件**：`{type:"session", version:0, id, createdAt, cwd, delegationDepth, agentPreset}`（`types.ts:61`）**无 `seq`**——它是持久化头行，不属于 `SessionEvent` 序列。首个事件（`permission/preset`）才是 `seq:0`。
> 2. **流式 chunk 是打包行（packed row）**：`reasoning-chunks` / `text-chunks` 以 **`{type, seq0, time0, data}` 信封**落盘（`chunk-rows.ts`），单行代表多个逻辑事件，展开时 `seq = seq0 + k`（`chunk-rows.ts:322`）。故打包行本身**无 `seq` 字段**（只有 `seq0`），这也是实测中 `reasoning-chunks` 显示 `seq=undefined` 的原因。打包动机：chunk 行的 JSON 信封远大于其载荷（实测 ~56×），打包降低开销（`chunk-rows.ts:4`）。

### 2.2 事件词表（SessionEventMap，可合并扩展）

核心 + 合并插件类型（来自 `docs/subsystems/session.md` 与实测分布）：

**生命周期**
- `turn/start`、`turn/end {reason: TurnEndReason}`
- `step/start`、`step/end`

**消息（append-origin，surface 事件）**
- `user/message` — role user；`data.source` 区分「人类提示 / `agent.inject()` 合成 context / goal 续跑」。
- `assistant/chunk {turn, step, chunk: StreamChunk}` — 流式分块。
- `assistant/message` — 装配完成的助手消息；若 adapter 报告则携带 `usage`；`sourceEventSeqs` 指向其 chunk seq。

**工具**
- `tool/call {turn, step, callId, name, arguments}` — `arguments` 是模型产出的**原始 JSON 字符串**（非解析后的对象）。
- `tool/result {turn, step, message: ToolResultMessage, error?, meta?}` — `meta` 是工具私有的展示载荷（须 JSON 可序列化，`Session.append` 时校验）；UI 的 `presentResult` 读取它。

**请求（模型请求信封，落盘供审计/重放）**
- `request/header` — 整个 EpochHeader：`{header: {config:{provider,model,reasoningEffort,maxTokens}, adapterDefaults, system, tools[]}}`（实测 system 约 18KB、tools 含完整 JSON Schema）。
- `request/context` — `{provider, model, contextWindow}`（实测 `contextWindow: 131000`）。

**压缩（合并插件，非 surface 事件，除 checkpoint 的 `replace` 外）**
- `compaction/start {compactionId, turn}`
- `compaction/summary {compactionId, summary[], rawOutput[], llmStreamCall, shadowedRange:{start,end}, shadowedSeqs[]}`
- `compaction/end {compactionId, turn}`
- `compaction/prune {shadowedRange, shadowedSeqs, shadowedTokenCount}`（tool 结果裁剪，仅日志）

**标题 / 元信息**
- `session/title`、`session/title-llm-request {titleProvider, messageSeqs, route, system, messages, maxTokens}`
- `session/end-seed {…}`（live 会话尾部边界种子）
- `agent/inbox/spliced`（inbox 拼接记录）

**命令 / 待办**
- `command/run`、`command/done`
- `todo/write {todos: [{content, status}]}`（完整列表快照）

**策略 / 环境**
- `permission/preset`、`sandbox/mode`、`approval/policy`、`agent-preset/selected`

**实测事件类型分布**（2MB 日志）：

```
 5243 reasoning-chunks   419 tool-call-chunks   268 text-chunks
 1255 assistant/chunk    118 tool/result        106 tool/call
  91 step/start          91 assistant/message   91 step/end
  17 user/message        12 agent/inbox/spliced 12 compaction/prune
   4 turn/start          4 turn/end
   3 compaction/start    3 compaction/end      2 compaction/summary
  各 1 条: session / permission/preset / sandbox/mode / approval/policy /
           agent-preset/selected / request/header / request/context /
           session/title-llm-request / command/run / command/done /
           todo/write / session/end-seed
```

> 注意：流式 chunk 是高频事件（`reasoning-chunks`/`tool-call-chunks`/`text-chunks` 各为独立事件类型），而装配完成的 `assistant/message` 是低频的、带 `usage` 与 `sourceEventSeqs` 的「事实」事件。两者关系由 `sourceEventSeqs` 显式引用，而非隐含顺序。

### 2.3 Surface 与 SurfaceOp

- **SurfaceManager** 维护一个有序 `number[]`（事件 seq 列表），即当前模型可见事件的投影。
- **增量式**：`append` 是 O(1)（尾部 push）；`replace {start,end}` 是 O(new)（splice 区间并插入本事件 seq）。
- **判定函数**（来自浏览器安全的 `surface` 模块）：`isAppendSurfaceEvent` / `isReplacementSurfaceEvent`。
- **替换语义**：`replace` 把 `start..end` 区间阴影出 surface（事件仍留在日志），插入本事件。被阴影事件不参与 `deriveMessages()`，但仍在日志中可审计。
- **append-origin 事件**：`user/message`、`assistant/message`、`tool/result`、`context/message` 携带 `surfaceOp:"append"` + `sourceEventSeqs`。

### 2.4 deriveMessages()：从事件到模型 messages

- `deriveMessages()` 按 surface 顺序投影出模型请求用的 `messages` 数组。
- **只计 append-origin 消息**：`session.history` 统计 append-origin 消息数。
- 投影规则（`surface.ts`）：`deriveEventMessage(event)` 把 surface 事件映射为一条 `Message`（`null` = 非消息事件）；`assistant/message` 的 `sourceEventSeqs` 用于把「消息」与其「chunk 流」关联，但 `deriveMessages` 只取装配完成的 `message`，chunk 用于流式渲染与 token 重定价。
- **被 `replace` 阴影的区间**：`deriveMessages` 跳过阴影 seq，只保留 checkpoint（`user/message` 的 `replace`）。

### 2.5 EpochHeader（模型请求头）

`request/header` 事件携带的 `header`（实测结构）：

```json
{
  "config": { "provider": "qwen38", "model": "/root/models/Qwen3.8-27B-Q4_K_M.gguf",
              "reasoningEffort": "low", "maxTokens": 1000000 },
  "adapterDefaults": { "maxTokens": true },
  "system": "You are an AI agent powered by DeepSeek Harness. …（完整系统提示，~18KB）",
  "tools": [ { "name": "ask_user_question", "description": "…", "parameters": {…JSON Schema…} }, … ]
}
```

- `system` + `tools` 构成模型请求的「前缀」，是 KV-cache 与 token 计量的大头。
- **请求上下文**（`request/context`）另存 `{provider, model, contextWindow}`（实测 131000），供 token meter 与 compaction 读取容量。
- **Epoch 语义**：当 `system`/`tools`/config 变化时进入新「epoch」，token meter 的锚点失效、触发全量重定价（见 §5.3）。

### 2.6 Message 与 content block

模型消息由 `role` + `content` 块数组组成，块类型：

| 块类型 | 结构 | 来源 |
|--------|------|------|
| `text` | `{type:"text", text}` | 用户文本 / 助手文本 |
| `reasoning` | `{type:"reasoning", text}` | 模型推理块 |
| `tool-call` | `{type:"tool-call", name, arguments}` | 模型发起的工具调用（`arguments` 原始 JSON 字符串） |
| `tool-result` | `{type:"tool-result", toolCallId, content:[…], isError}` | 工具结果（递归 `content`） |
| 未知/合并 | 任意 | 回退 `JSON.stringify` 计量 |

**source 标注**：`user/message` 的 `data.source` 区分三类输入——人类提示、`agent.inject()` 注入的合成 context（如 `<compacted-summary>` checkpoint、goal 续跑上下文）、以及其它合成来源。这让人类转录与模型可见的注入 context 在日志里可区分。

### 2.7 TokenSurfaceNode（token meter 的 surface 表示）

token meter 内部把 surface 表示为位置化的 `TokenSurfaceNode[] = {seq, tokens}[]`（头到尾），`surfaceTokens` 为带符号运行总和（见 §5.2）。compaction 的 `selectCompactableRange` 直接在这组节点上从尾部累加。

---

## 3. 保存的文件类型与内容结构

> 本节「实测」来自本机 `~/.dsh` 的逐帧解压；其余结构引用子代理 A 的源码分析（`packages/session/session-persistence*`）。

### 3.1 DSH_HOME 布局（`C:\Users\zghyu\.dsh`，实测）

```
~/.dsh/
├── sessions/                          # 每个会话一个目录，按转义后的 cwd 分组
│   ├── --D-DSH--/                     # cwd = D:\DSH（反斜杠/冒号被转义）
│   │   └── session-<uuid>/
│   │       └── session.jsonl.zstd     # 唯一事实来源（zstd 帧容器）
│   ├── --D-deepseek-harness-plugins--/
│   │   └── session-<uuid>/session.jsonl.zstd   # 含子代理会话（按子代理 session id 命名）
│   └── …
├── storages/                          # 派生状态缓存（非事实来源）
│   ├── session_projcache.json         # 投影缓存（version 3；title/goal/sessionStats 各带 ver/seq/val）
│   ├── usage-stats-cache.json
│   ├── message_feedback.json
│   ├── wallet.json
│   ├── workspace.json
│   └── dsh_delete_session.json
├── memory/memory.db                   # SQLite 记忆库
├── profiles/web/                      # profile 装配 + node_modules
├── change-ledger/v1/
├── attachments/
└── dsh-delete-session-trash/
```

- **目录键 = 转义后的 cwd**：`D:\DSH` → `--D-DSH--`（路径分隔符与盘符冒号被转义成 `--`）。
- **子代理会话**存放在**父会话 cwd 目录**下，以子代理 session id 命名（实测：5 个子代理的 `session.jsonl.zstd` 都在 `--D-deepseek-harness-plugins--/` 下持续增长）。

**路径/命名约定**（`packages/session/session-persistence-jsonl/src/format.ts`）：
- **基础目录** = `Config.root`（`index.ts:60`，**必填、无默认**——避免进程 cwd 变化散落文件）。
- **每项目目录** `projectDir(root, cwd)`（`format.ts:176`）：`cwd===undefined` → `_no-cwd`；否则 `projectKey(cwd)`（`format.ts:147`）：分隔符/冒号 → `-`，不安全码元 → `~XXXX` 十六进制转义，结果 `--<slug slice 0..251>--`（slug 截断 251 字符）。
- **每会话目录** `sessionDir`（`:189`）= `join(projectDir, encodeSegment(id))`。`encodeSegment`（`:121`）：`~XXXX` 十六进制转义每个不安全码元；`.` → `~002E`、`..` → `~002E~002E`。
- **日志文件** `logPath`（`:201`）= `join(sessionDir, 'session' + logSuffix(compression))`。`logSuffix`（`:24`）：`'none'` → `.jsonl`、`'zstd'` → `.jsonl.zstd`——**逻辑文件名恒为 `session.jsonl`，后缀仅标记编码**。
- **定位** `findLog`（`index.ts:774`）在每项目目录扫描 `session.jsonl`/`session.jsonl.zstd`，**拒绝相反编码**（`encodingMismatch`）；`assertStoredIdentity`（`:808`）要求路径恰等于 `logPath`。
- **`list`** 用 `readFirstZstdLine`（`:737`）只解码第一帧取 header 行——列举规模随**会话数**而非日志大小增长。
- **Windows 持久化命名空间**（`win32.ts`）：`publishNewFileWin32`（`:116`）经 `MoveFileExW(..., MOVEFILE_WRITE_THROUGH=0x00000008)` 原子发布；`ensureDurableDirectoryWin32`（`:130`）用 `mkdtemp` 暂存 + 写穿移动。

### 3.2 `session.jsonl.zstd`：zstd 拼接帧容器（实测）

**文件 = 多个独立可解码、带校验的 zstd 帧顺序拼接**（不是单个 zstd 流）：

- **帧 1** = `SessionHeader` 行（`{"type":"session","version":0,…}`）。
- **后续每帧** = 一个 durable 事件批次（一个 write-behind 批次的 JSONL 明文压缩成帧）。
- 实测 2MB 文件 = **6446 帧 → 7753 条逻辑事件**（平均 ≈1.2 事件/帧）。

**为什么多帧**：append-only 容器必须能「追加一个批次 = 追加一个帧」，所以每批是独立帧。`scanZstdFrames`（`packages/session/session-persistence-jsonl/src/zstd.ts:48`）不解压块、只做**结构扫描**：校验帧 magic `0xFD2FB528`、帧头描述符、块头，返回完整帧区间 + 可选的「撕裂尾帧起点」`tornStart`。

**帧编码**（`zstd.ts`）：
- `compressZstdFrame(input)`（`:111`）= `zstdCompress(input, {params:{ZSTD_c_checksumFlag:1}})`——每帧带校验和。
- `decompressZstdFrame(input)`（`:120`）= 解一个完整帧并校验 checksum。
- `decompressZstdPrefix(input)`（`:154`）= `zstdDecompress(input, {finishFlush:ZSTD_e_flush})`——从结构上不完整的尾帧恢复可用明文（抑制 final-frame/checksum 完成）。
- 解码器：优先 `NodePrivateZstdFrameDecoder`（Node 22/24/26 私有 API 快路径），否则回退 `PublicZstdFrameDecoder`（`zstd-public-decoder.ts`，逐帧 `zstdDecompressSync`）。
- **注意**：Node 的 `zstdDecompressSync` 对多帧缓冲只解第一个帧——所以必须先用 `scanZstdFrames` 定位每帧区间再逐帧解。

**压缩配置**：默认 `DEFAULT_COMPRESSION = 'zstd'`（`index.ts`）；`'none'` 则用原始 `.jsonl`（无压缩）。

### 3.3 逻辑 JSONL：每行一个 SessionEvent（无损）

解压所有帧后，得到**逻辑 JSONL**——每行一个 `SessionEvent`，与内存 `Session` 逐字节等价（无损、可重放）。行结构见 §2.1 信封。

**`assistant/chunk` 的打包（packed chunk rows，`packages/core/session/src/chunk-rows.ts`）**：chunk 在逻辑层是逐条事件，但持久化时可按「packed chunk rows」打包——连续 chunk 行在物理层合并存储，重放时展开为单条事件；打包行是**持久化编码词汇**，**从不**进入 `Session.events`。逻辑层仍是「一行一事件」。

- **`StorageRecord`**（`chunk-rows.ts:70`）= `SessionEvent`（单事件行）**或** `ChunkRow`（打包行）。
- **`DeltaKind`**（`:26`）= `'text-delta' | 'reasoning-delta' | 'tool-call-delta'`。
- **`ChunkRow`**（`:64`）= `{ type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks'; seq0: number; time0: number; data: RunData }`。
- **`RunData`**：`RunDataBase { turn, step, index, dt: number[] }`（`:37`）；`TextRunData extends { texts: string[] }`（`:47`）；`ToolCallRunData extends { id: CallId; name?; args: string[] }`（`:52`）。
- **`MIN_RUN = 3`**（`:77`）：一个运行需 **≥3 个成员**才打包。
- **成员重建**：成员 k 重建为 `seq = seq0 + k`、`time = time0 + Σ(dt[0..k-1])`（`expandRow`，`:293-327`）。`dt` 是**相邻成员时间差数组（可为负**，表示时间回退），长度 = 成员数 − 1。
- **`classify`**（`:96-123`）：白名单精确形状——`type==='assistant/chunk'`、精确键 `[type,seq,time,data]`、`data={turn,step,chunk}`，`chunk` 为三种 delta 变体之一（`text-delta`/`reasoning-delta` 需精确键 `{type,index,text}`；`tool-call-delta` 需 `{type,index,id,[name,]argumentsDelta}`）。block-start/end、usage、finish 及其他变体保持一事件一行。
- **`continues`**（`:136-150`）：要求 `next.seq===prev.seq+1`、`next.time−prev.time` 为安全整数、同 turn/step/index、tool-call 的 `id` 一致且 `name` 存在性与值都一致（混合运行不可表示）。
- **`packChunkRuns`**（`:192-221`，纯函数）把 ≥`MIN_RUN` 个连续同类型同块 delta 打包为一行；`decodeStorageRecord`（`:339-345`）校验 + 展开（格式错误 → 抛错 = 损坏存储，非静默丢弃）；`validateRow`（`:248-290`）要求成员 seq/time 保持安全整数（浮点舍入会产生不同数 = 静默损坏）。
- **`packChunks`** 默认 `true`（`DEFAULT_PACK_CHUNKS`，`jsonl/index.ts:37`）：true 时 `packChunkRuns` 打包再逐行 JSON；false 时每事件一行（与打包前字节一致）；**读取对两种布局都无感知**（`scanLog` 始终解码行）。

**SessionHeader 行**（实测）：

```json
{"type":"session","version":0,"id":"session-6223a091-a5c5-40d0-aad3-da78414bad8a",
 "createdAt":1787520086927,"cwd":"D:\\DSH","delegationDepth":0,"agentPreset":"standard"}
```

字段：`type:"session"`、`version:0`（`SESSION_FORMAT_VERSION`）、`id`、`createdAt`（ms epoch）、`cwd`、`delegationDepth`（0 = 根会话）、`agentPreset`。

### 3.4 崩溃恢复（append-only，绝不截断）

- **append-only**：恢复只追加、绝不截断已有字节。
- **撕裂尾帧**：`scanZstdFrames` 返回 `tornStart`，`decompressZstdPrefix` 恢复可用明文，丢弃不可恢复尾部。
- **`prepare` / `load` 提交修复**；live `load` 等待 durable balanced snapshot。
- **`inspect`** = 不可变逻辑 Session（不发布、不 LRU）。
- **`listSnapshots`** 返回 revisions。

**孤儿未闭合 turn 的闭合（`interruptedTurnClosers`，`packages/core/session/src/repair.ts:27-133`）**——常量 `TOOL_NOT_STARTED='TOOL_NOT_STARTED'`（`:13`）、`TOOL_OUTCOME_UNKNOWN='TOOL_OUTCOME_UNKNOWN'`（`:16`）。扫描 `turn/start`/`turn/end`/`step/start`/`step/end`/`assistant/message`（登记 pending tool-call 块）/`tool/call`（把 `callSeq` 加入 `sourceEventSeqs`）/`tool/result`；平衡日志 → `[]`。**按序合成**：
1. **未匹配的 `tool/result` 错误事件**（每个 pending call，Map 插入序保转录顺序）：已启动（`callSeq!==undefined`）→ `ToolOutcomeUnknownError`/`TOOL_OUTCOME_UNKNOWN` + `sourceEventSeqs:[callSeq]`；未启动 → `ToolNotStartedError`/`TOOL_NOT_STARTED`（无 `sourceEventSeqs`）。两者都是 `role:'user'`、`isError:true`、`source:{kind:'tool',callId}` 的 `tool-result` 消息，文案指导模型**不要盲目重试**。
2. **开放的 `step/end`**（`:128-130`）。
3. **`turn/end`**，`data:{turn: openTurn, reason:{kind:'interrupted'}}`（`:131`）。

seq 从 `last.seq+1` 续，time 复用最后事件的 time（确定性、不发明「未来」时间）。

### 3.5 SQLite 后端（可选，已核实）

`packages/session/session-persistence-sqlite`（`src/schema.ts`、`resources/sql/schema.sql`）：与 JSONL 1:1 行映射的 SQLite 存储，默认后端仍是 JSONL，SQLite 是可选替代。

- **`SCHEMA_VERSION = 17`**（`schema.ts:18`）；`SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 0x44534850`（ASCII "DSHP"）。
- **三张 `STRICT` 表**（`resources/sql/schema.sql`）：
  - `persistence_state (singleton INTEGER PK CHECK=1, store_id TEXT NOT NULL)`——单例 store 身份（UUID）。
  - `sessions`：`id TEXT PK`、`version INTEGER`、`created_at INTEGER`、`cwd TEXT`、`parent_session TEXT`、`seed_length INTEGER`、`origin TEXT`（仅 `'subagent'` 或 null）、`delegation_depth INTEGER`、`agent_preset TEXT`、`incarnation TEXT NOT NULL`（UUID）、`revision INTEGER`。
  - `events`：`session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`、`seq INTEGER`、`type TEXT NOT NULL`、`time INTEGER`、`data ANY NOT NULL`、`source_event_seqs ANY`、`surface_op TEXT`、`ignorable INTEGER CHECK (NULL OR 0/1)`，`PRIMARY KEY (session_id, seq)`。
- **`data` / `source_event_seqs` 是 `ANY` 类型**（string 或 blob，`schema.ts:385-395` 校验）——packed / compressed 事件行可存 blob；`surface_op` 是 `TEXT`。
- **安全加固**（`schema.ts:91-184`）：`trusted_schema=0`、`mmap_size=0`、`foreign_keys=ON`、journal 模式可配（`wal`/`delete`/`truncate`/`persist`）、`synchronous=FULL (2)`。
- **schema 所有权校验**：打开时 `user_version` 必须为 0（未版本化则初始化）或等于 `SCHEMA_VERSION`（单调，**无向下迁移**）；`application_id` 必须等于 0x44534850；canonical schema objects 必须与内存参考库**精确匹配**（`validateRequiredSchema`，`schema.ts:243-251`）。每次 mutation 事务内重查（`validateSchemaForMutation`，`:260-276`）。
- **崩溃/并发**：`begin-immediate` 事务、`isSqliteBusy`（errcode 5）重试到 deadline。

**`appendBatch` 如何断言连续 seq**（`store.ts:173-200`）：`BEGIN IMMEDIATE` → `validateSchemaForMutation` → `tailRows` → `logicalLastEvent` → `expected = last===undefined ? 0 : last.seq+1`；**第一个事件 seq 必须等于 expected**（`:187-189`）→ `packChunkRuns(events)` → `insert-event.sql` → `incrementRevision`（`revision = revision+1`）→ `COMMIT`；失败 → `rollback`。

**物理行 codec（schema-17 独立物理编码，刻意不与 JSONL 共享；`codec.ts` + `compression.ts`）**：
- 常数：`MIN_PACKED_ROW_MEMBERS=3`（`:42`）、`MAX_PACKED_ROW_MEMBERS=1024`（`:44`）、`MAX_PACKED_DATA_BYTES=1048576`（1 MiB，`:46`）、`ZSTD_DATA_THRESHOLD_BYTES=4096`（`:31`，小于阈值保持 SQLite 文本避免每帧 CPU/字节开销）、`ZSTD_COMPRESSION_LEVEL=3`（`:36`）、`PACKED_ROW_SENTINEL=0`（`:37`）。
- **打包行**：`type ∈ ('text-chunks','reasoning-chunks','tool-call-chunks')`、`seq` = 首成员 seq、`time` = 首成员 time、`data` = run payload 的 JSON（≤1 MiB）、`source_event_seqs`/`surface_op` 为 NULL、`ignorable = 0`（打包行哨兵）。
- **标量事件行**：`data` = `data` 字段 JSON、`source_event_seqs` = 编码数组或 null、`surface_op` = JSON 或 null、`ignorable = 1`（当事件 `ignorable===true`）否则 null。
- **`scanRows`**（`:227-276`）：从后往前找最后一个含 `turn/end` 的物理行（`lastTurnEndRow`）；逐行解码 + 连续性校验。坏行/逻辑 gap 出现在 `lastTurnEndRow` **之后** → 返回 `tornFrom`（可删除的物理尾部）；出现在**已提交** `turn/end` 之内 → 抛 "invalid committed physical row"（致命损坏）。
- **文件/目录校验**（`:392-435`）：父目录必须真实目录、属当前用户、非 group/world-writable；数据库文件必须常规文件（非符号链接）、属当前用户、仅属主可访问；`createDatabaseFile` 用 `open(path,'wx',0o600)`。
- **入口**（`index.ts`）：`SqliteSessionPersistence`（`:52`）、`supportsRawArtifacts=false`（`:53`）、`locate` 返回 `undefined`（一个数据库而非每会话独立工件）；`Config`（`:36`）`path`（必填，可 `:memory:`）、`journalMode`（默认 `'wal'`）、`busyTimeoutMs`（默认 5000）、`preparedSessionCacheSize`、`writeBatchMaxDelayMs`。

> 注：`2026-06-18-session-surface.md` 说 `sourceEventSeqs`/`surfaceOp` 是「两个可空 TEXT 列」，实际 schema 中 `data`/`source_event_seqs` 为 `ANY`（可 blob）、仅 `surface_op` 为 TEXT——以 `schema.sql` 为准。

### 3.6 重载/恢复语义（`session-persistence` 抽象 + `coordinator`）

抽象 `SessionPersistence`（`packages/session/session-persistence/src/index.ts:84`，service key `sessionPersistence`）：
- **`locate(meta)`**（`:96`）→ `SessionLocation | undefined`（无副作用定位器；SQLite 返回 `undefined`）。
- **`supportsRawArtifacts`**（`:102`）：JSONL `true`、SQLite `false`；**`readRaw`**（`:119`）逐字节返回工件文本 + 解析首行 header。
- **`create`**（`:133`）、**`append`**（`:143`，首事件 seq 必须等于存储的 next-seq）。
- **`prepare`**（`:155`）= `load` + `ctx.sessions.prepare(id, { seed, meta, seedSource:'persistence' })`。
- **`load`**（`:183`）：返回**平衡的逻辑视图**（以平衡 `turn/end` 结尾），**持久化**提交恢复。
- **`inspect`**（`:200`）：**非提交**；内存合成 closer；撕裂尾部**不动**；prepared Session 留在 LRU 供后续 `prepare`/resume。
- **`readFrom(id, fromSeq)`**（`:220`）：分离的尾部读取，**无修复**。
- **`list`**（`:228`）、**`listSnapshots`**（`:240`）。

**`prepareCore`**（`coordinator.ts:892-931`）：读存储 → `assertStoredId` → `assertVersion` → `adoptStoredEvents` → `assertEventsSupported` → **`interruptedTurnClosers`**（内存合成，见 §3.4）→ `balanced=[...storedEvents, ...closers]` → `ctx.sessions.prepare`。

**冷读 `SESSION_FORMAT_VERSION` 校验**：
- **`assertVersion`**（`coordinator.ts:1046-1049`）：`meta.version === SESSION_FORMAT_VERSION`，否则 `sessionFormatVersionRefusal(id, version)`（`:77`）：`version > SESSION_FORMAT_VERSION` → "written by a newer harness — upgrade"；更旧 → "no upgrade path"。错误类型 `SessionFormatUnsupportedError`（`:55`，携带 `location?`）。
- **JSONL 侧**：`refuseForeignFormatVersion`（`format.ts:240-247`）在**校验当前 header 形状或解码任何事件行之前**先拒绝——未来格式无需满足今天的结构检查，用户应看到 "upgrade the harness" 而非 "corrupt session log"。
- **事件支持性**：`assertEventsSupported`（`:1061-1065`）拒绝未知事件类型（除非 `ignorable:true`）；`assertSupportedEvents`（`:274-290`）拒绝废弃 v0 词汇（`request/header-delta`、`mode/set`、`request/header` reason "fallback"）。
- `prepareCore` 捕获：`SessionFormatUnsupportedError` **原样**抛出（对完整日志的拒绝而非损坏），其余包为 `SessionPersistenceCorruptionError`。

**live 会话采纳（HMR/reload，`onCreated` `:1237-1294`）**：已跟踪（owner 匹配 / 认领无主 state / 真放弃 id / 拒绝碰撞）；未跟踪 + 工件存在 → **`adoptLivePrefix`**（`:1302-1324`，**不走**冷 preparation——那会把开放 turn 误判为 interrupted，故仅做**截断**修复、无 closer，live Session 仍是权威）；cwd 不匹配 → 碰撞拒绝；未跟踪 + 无工件 → 真新会话 `createCore` + 持久化 seed 一次。

**write-behind 协调器监听器**（`coordinator.ts`）：
- `ctx.on('session/created', session => initFor(session))`（`:1118`）——创建时捕获 header，fork seed 持久化一次。
- `ctx.on('session/event', (session, event) => { live.writes.enqueue(event) })`（`:1123`）。
- `ctx.on('session/flush', session => flush(session))`（`:1129`）→ `flush`（`:1326-1338`）：`initFor` → `cancelAutomaticWait()` → `await live.init` → `live.writes.flush()`。
- **`DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200`**（`coordinator.ts:30`）；`appendLiveBatch`（`:1355-1361`）`batch.filter(e => e.seq >= cursor)` 过滤掉 init 已存储的事件。

### 3.7 派生状态缓存（`storages/`）

**`session_projcache.json`**（实测，version 3）——按 session 缓存派生投影，避免重算：

```json
{
  "unit": { "name": "session_projcache", "version": 3 },
  "global": null,
  "tables": {
    "session-<id>": {
      "identity": { "createdAt": …, "cwd": "D:\\Comfy" },
      "rows": {
        "title":        { "ver": 1, "seq": 1016197, "val": "…" },
        "goal":         { "ver": 4, "seq": 1016197, "val": null },
        "sessionStats": { "ver": 1, "seq": 1016197, "val": {…} }
      }
    }
  }
}
```

每个投影行带 `ver`（版本）、`seq`（计算到的日志 seq）、`val`（投影值）。这是**缓存**，不是事实来源——日志重建时可全部丢弃。

### 3.8 真实落盘样例（实测）

**`tool/result`**（§2.1 已展示）。**checkpoint `user/message`（`replace`）**：

```json
{"type":"user/message","seq":44712,"time":1787520826118,
 "data":{"content":[
   {"type":"text","text":"This is an automatically generated checkpoint condensing an earlier span…"},
   {"type":"text","text":"## Primary Request and Intent\n- …"}
 ]},
 "surfaceOp":{"op":"replace","start":8,"end":31422},
 "sourceEventSeqs":[…]}
```

> 这正是本文头顶 `<compacted-summary>` checkpoint 的落盘形态：一条 `user/message` 用 `replace` 把 seq 8..31422 折叠成一个 checkpoint 消息。

**`compaction/summary`**：

```json
{"type":"compaction/summary","seq":44711,
 "data":{"compactionId":"202f127e-…",
   "summary":[{"type":"text","text":"## Primary Request and Intent\n- …"}],
   "rawOutput":[{"type":"text","text":"…"}],
   "llmStreamCall":true,
   "shadowedRange":{"start":8,"end":31422},
   "shadowedSeqs":[8,9,10,11,193,195,353,355,…]}}
```

**`request/header`**（EpochHeader，§2.5 已展示）。**`request/context`**：

```json
{"type":"request/context","seq":14,"data":{"provider":"qwen38",
 "model":"/root/models/Qwen3.8-27B-Q4_K_M.gguf","contextWindow":131000}}
```

**`compaction/prune`**（tool 结果裁剪，仅日志）：

```json
{"type":"compaction/prune","seq":30138,
 "data":{"shadowedRange":{"start":1170,"end":1170},
         "shadowedSeqs":[1170],"shadowedTokenCount":3690}}
```

**`todo/write`**（完整列表快照）：

```json
{"type":"todo/write","seq":73793,"data":{"todos":[
  {"content":"Identify the actual auto-compact engine…","status":"completed"},
  {"content":"Pin down why it breaks session structure…","status":"completed"},
  …]}}
```

**`session/end-seed`**（live 会话尾部边界种子）：

```json
{"type":"session/end-seed","seq":137272,"data":{}}
```

---

## 4. 聊天窗口如何显示 / 分析

> 本节引用子代理 D 的源码分析（`packages/client/ui-conversation`、`packages/client/ui-trajectory`）。

### 4.1 人类转录 vs 模型 surface：两个独立投影

聊天窗口**不直接**渲染模型 surface，而是渲染一条**人类转录**（human transcript）——这是与模型 surface 分离的独立投影：

- **人类转录**：终端 + 浏览器都用**日志顺序的 append-origin 转录**（terminal + browser use append-origin log-ordered transcript）。即按 seq 顺序展示所有 append-surface 事件，形成人类可读的对话流。
- **模型 surface**：被 `replace` 阴影的区间（如 compaction 折叠的历史）**只留在日志、不在人类转录中显示**；取而代之的是**恰好一个**淡化的 compaction 标记（来自被引用的 `compaction/summary` 事件，而非带框的 checkpoint 载荷本身）。
- **`session.history`** 只统计 append-origin 消息。

> **命名纠正**（已 grep 核实，当前代码零匹配）：早期文档/笔记中的「`TranscriptAdapter`」（取代旧 `FoldAdapter`）**不是当前代码符号**。当前浏览器转录的真实架构是 **per-business `ConversationNodeDefinition` 引擎**：
> - 每个业务特性注册一个 `ConversationNodeDefinition`，把事件折叠进引擎拥有的 `Context`；
> - 每个 Session 一个 `ChatSnapshotBuilder`，发布 `ChatSnapshot { order, nodes, locations, timeline, legacy }`；
> - 「人类转录投影」= **surface 谓词**（`core/session/src/surface.ts`：`isAppendSurfaceEvent` = type ∈ {`user/message`,`assistant/message`,`tool/result`} 且 `surfaceOp==='append'`，`:51`）+ **per-kind `match`/`start`/`update`/`buildViewNode` 定义**（`ui-conversation/src/client/conversation-nodes/`）+ **`ChatSnapshotBuilder.orderedVisible`**；
> - 旧的**扁平 `ConversationNode[]`** union 仍存在，挂在 `snapshot.legacy.nodes` / `snapshot.nodes`（`Session.buildSnapshot()` `:745`），供 trajectory / stats 消费者使用。

> 关键：人类看到的是「对话发生了什么」（append 顺序），模型看到的是「当前 surface」（含折叠后的 checkpoint）。两者是同一日志的两个投影，折叠只影响 surface、不影响日志完整性。

### 4.2 从事件到 UI 节点：`Session → ChatSnapshot → ChatView`

**数据流**（已核实，`packages/client/runtime` + `ui-conversation`）：
1. `Session.acceptLiveEvent`（`session.ts:688`）→ `appendLive`（`:672`）→ 逐事件 `Conversation.append` 折叠；
2. `scheduleConversation`（`:704`）：立即 → `markDirty`（微任务批处理）；动画帧 → `markFrameDirty`（RAF）；
3. `getSnapshot`（`:459`）/ `buildSnapshot`（`:735`）→ `ConversationSnapshot`（`sessions/conversation.ts:437`），含 `chat: ChatSnapshot`（`:399`）；
4. `ChatView` → 按 `order` 键逐个 `ChatNodeSeat`（`ChatView.tsx:432`）渲染。

**`ConversationNode` union**（`sessions/conversation.ts:285`、`api-catalog.ts:514`）= **11 个 arm**：
`User / Assistant / Steering / Context / ModelRetry / TurnError / TurnMaxTokens / ToolResult / Command / CompactionSummary / UnknownSurface`。
新的 keyed store 使用 `ChatConversationViewNode`（`contract/conversation.ts:125`），其 `data` 由 `declare module` 合并的 `ChatNodeDataMap` 按 kind 收窄。

**React 层**把 `ChatSnapshot.nodes` 渲染成消息气泡/卡片；每个 `ChatNodeSeat` 按 `order` 键独立订阅——一次 append 只重渲染一行。

**chat 节点数据模型**（已核实，`packages/client/ui-conversation/src/client/contract/chat-nodes.ts`）：

- `ChatNodeDataMap`（`:7`）是一个 **merge-extensible** 载荷注册表，按最终 chat renderer kind 键控；业务模块经 `declare module` 扩展（如 `compaction: CompactionSummaryNode`）。`ChatNodeKind = Extract<keyof ChatNodeDataMap, string>`。
- `ChatNode<Kind>`（`:13`）= `ChatConversationViewNode & {kind, data: ChatNodeDataMap[Kind]}`。
- 各载荷接口：
  - **`AssistantChatData`**（`:21`）——助手行（流式 + 落定共用）：`{status:'running'|'settled'|'interrupted', turn, step, blocks: AssistantBlock[], time, usage?, finalNode?}`；`FinalAssistantChatData` 额外带 `finalNode: AssistantMessageNode`。
  - **`ToolChatData`**（`:37`）——工具行：`{root: ToolCallBlock}`（根生命周期拥有所有递归子调用）。`isSettledTool`（`:71`）= 根块带 `kind`（`tool-result`）；`isRunningTool` = 无最终结果。
  - **`ManualCompactionChatData`**（`:42`）——手动命令及其关联的压缩事务：`{command: CommandNode, compaction: CompactionSummaryNode | null}`。
  - **`RetryChatData`**（`:48`）——一条 durable 重试链渲染为单行：`{attempts: ModelRetryNode[], current: ModelRetryNode}`。
  - **`TurnTailChatData`**（`:54`）——turn 局部页脚行（拥有 actions 与可选特性贡献）：`{turn, seq, time, closing: FinalAssistantChatData|null, branchUnavailable, ttftMs?, tokensPerSecond?}`。

**`ChatNodeDataMap` 完整键清单**（已核实，`chat-nodes.ts:7` + 各 `conversation-nodes/*.ts`）——每个 chat renderer kind 及其载荷：

| kind | 载荷 | 定义文件 |
|------|------|----------|
| `input-message` | `UserMessageNode \| SteeringMessageNode \| ContextMessageNode` | `message.ts` |
| `assistant-step` | `AssistantChatData \| FinalAssistantChatData` | `assistant.ts` |
| `tool-call` | `ToolChatData { root: ToolCallBlock }` | `tool.ts` |
| `command` | `CommandNode` | `command.ts` |
| `manual-compaction` | `ManualCompactionChatData { command, compaction\|null }` | `command.ts` |
| `compaction` | `CompactionSummaryNode` | `compaction.ts` |
| `model-retry` | `RetryChatData { attempts, current }` | `retry.ts` |
| `turn-error` | `TurnErrorNode` | `turn-error.ts` |
| `turn-max-tokens` | `TurnMaxTokensNode` | `turn-max-tokens.ts` |
| `turn-tail` | `TurnTailChatData { turn, seq, time, closing, branchUnavailable, ttftMs?, tokensPerSecond? }` | `turn-tail.ts` |
| `unknown` | `UnknownSurfaceNode` | `fallback.ts` |

> 另有 state-only Contexts：`inbox-next-turn` / `inbox-next-step`（`inbox.ts`，无 view node）。

**节点纪律**（`packages/client/AGENTS.md`）：每个 chat 业务特性注册一个 `ConversationNodeDefinition` 及其 keyed `conversation.chat.node` renderer；`match(event)` 只读当前事件；append 热路径与 renderer 绝不扫描完整事件窗口/Contexts/Chat Nodes——在 State 中累积、经 `buildLocationData()` 发布同 Turn/Step 事实。

### 4.3 compaction 标记（已核实）

来自 `packages/client/ui-conversation/src/client/conversation-nodes/compaction.ts`、`command.ts` 与 `chat/CompactionItem.tsx`：

- **checkpoint 识别**（两条等价路径）：
  - **canonical**：`isCompactCheckpointSource(source)`（`packages/compaction/compaction/src/checkpoint.ts:49`）= `source.kind === 'plugin' && source.plugin === 'compact'`。checkpoint 的 source 由 `compactCheckpointSource(compactionId, sourceCommandId?)`（`:33`）构造 = `{kind:'plugin', plugin:'compact', compactionId, sourceCommandId?}`（frozen）。
  - **client structural**：`compactSource(event)`（`command.ts:79-95`）要求 `event.type==='user/message'` **且** `isReplacementSurfaceEvent(event)` **且** `source.kind==='plugin' && source.plugin==='compact' && typeof source.compactionId==='string'`，返回 `{compactionId, sourceCommandId?}`。
  - checkpoint 是一个 **replacement** `user/message`（非 append 的 `surfaceOp`）——它是「replacement 副本不进入转录」规则的**唯一有意例外**：被折叠为恰好一个标记，锚定在 checkpoint 自身 seq。
- **标记字段来源**：`compactSummary(match, checkpoint)`（`command.ts:103-133`）——`summary`/`shadowedItemCount`/`shadowedTokenCount` **仅**从被引用的 `compaction/summary` 事件的 `data` 读取；`seq`/`time` 从 replacement checkpoint 事件读取。带框的 checkpoint `user/message` content **为模型而写、从不渲染**（`CompactionItem.tsx:1-7`）。

**`compactionDefinition`**（`kind:'compaction'`，`target:'chat'`）匹配三类事件：
  - checkpoint `user/message`（经 `compactSource(event)` 识别，且 `sourceCommandId === undefined`）→ `{id: compactionId, role:'update'}`；
  - `compaction/start` / `compaction/summary` / `compaction/end`（无 `sourceCommandId` 且 `compactionId` 为非空字符串）→ `role` 为 `start`（`compaction/start`）或 `update`（其余）。
- **`buildViewNode`**：仅当 `state.checkpoint !== undefined` 时，用 `compactSummary(state.summary, state.checkpoint)` 构造**恰好一个** `CompactionSummaryNode`。
- **`CompactionItem`** 是「落定压缩对对话流贡献的**唯一一行**」：
  - 折叠态标记，`title` 默认 `t('message.compaction')`；
  - **带框的 checkpoint 载荷「为模型而写、不渲染」**——展开时显示的是 checkpoint 自身**引用的 `compaction/summary` 事件**的 summary（经 `MarkdownText` 渲染），而非 checkpoint 载荷本身；
  - 若窗口裁剪把 `compaction/summary` 事件切到窗口外，该行**不可展开而非空白**；
  - 有 `shadowedItemCount` + `shadowedTokenCount` 时显示「N 项已压缩、M tokens」，否则回退 `fallbackSummary`。
  - 该标记报告「模型在哪里停止看到那段历史」——**从不替换**被阴影的历史（历史仍显示在其上方）。

### 4.4 工具卡片配对

- 工具调用（`tool/call`）与工具结果（`tool/result`）在 UI 上配对成一张「工具卡片」：调用参数 + 执行结果 + 状态。
- **配对机制**（已核实，`conversation-nodes/tool.ts`）：
  - `tool/call` 命中 `start`，节点 id = `callId`；
  - `tool/result` **仅当 `isAppendSurfaceEvent`** 时命中 `update`，节点 id = `message.source.callId`——即结果只折叠到 append-surface 的工具行上（被 replace 阴影的调用不产生 UI 行）。
  - **无调用降级**：`rootResult`（`tool.ts:53`，call:null）与 `fallbackState`（`:226`）处理「窗口截断导致 call 事件缺失、只剩 result」的情形——仍渲染结果行而非丢失。
- **`command/run` + `command/done` → `CommandNode`**；成功的 `/compact` 命令：`commandFromDone` 读 `data.sourceEventSeq`（= checkpoint seq，`command.ts:54-58`），checkpoint 的 `source.sourceCommandId` 等于 command id（match `command.ts:186-189`）→ 恰好一个 `CompactionSummaryNode` → `ManualCompactionChatData` → `CompactionCommandCard` → `CompactionItem` 折叠披露。

### 4.5 轨迹布局（`packages/client/ui-trajectory`）

**Trajectory 是第二个 `target`**（独立于 `chat`）：`TrajectoryConversationViewNode`（`trajectory-contract.ts:53`）= `ConversationViewNode & {target:'trajectory', anchorSeq, location, data: TrajectoryContribution}`。

**`TrajectoryContribution`**（`trajectory-contract.ts:17`）是七种 stage 贡献的 union：
- `{kind:'node', node: ConversationNode}`——通用事件节点；
- `{kind:'assistant', node?: AssistantMessageNode, partial: PartialAssistant|null, request?: RequestView(assistant)}`——助手阶段（流式 partial + 最终 node + 请求视图）；
- `{kind:'tool', root: ToolCallBlock}`——工具阶段（根块拥有递归子调用）；
- `{kind:'request-header', header: TrajectoryRequestHeaderState}`——请求头阶段（`{seq, time, prompt: ConversationPromptSnapshot, change?, location}`，`trajectory-contract.ts:8`）；
- `{kind:'compaction', request: RequestView(compaction)}`——压缩阶段；
- `{kind:'session-end', seq, time}`、`{kind:'turn-end', turn, time, error?}`——终态行。

**`TrajectorySnapshot`**（`trajectory-contract.ts:61`）= 由注册的业务 Context 独立组装的 stage 数据：
```
{ eventNodes: ConversationNode[],
  eventLocations: ReadonlyMap<seq, ConversationLocation>,
  requests: RequestView[],
  callSchemas: ReadonlyMap<callId, prompt.tools[number]>,
  partial: PartialAssistant|null,
  runningCalls: RunningToolCall[] }
```
经 `declare module` 注入 `ConversationViewSnapshotMap.trajectory`（`:70`）——即 trajectory 是 `ConversationViewSnapshot` 上的一个**并行投影**，与 chat 投影共享同一 `ConversationNode` 源但各自折叠。

**布局组件**（`src/client/`）：
- `TrajectoryView.tsx`——根视图；`TrajectoryTable.tsx` / `trajectory-virtual-rows.ts`——**虚拟行**渲染（大日志不一次性实例化所有行）；
- `TrajectoryTimeline.tsx` / `timeline.ts`——时间轴；`TrajectoryTurn.tsx` / `TrajectoryTurnHeader.tsx`——turn 分组头；`TrajectoryGroupHeader.tsx`——group 头；
- `trajectory-request-header-definition.ts` / `trajectory-assistant-definition.ts` / `trajectory-tool-definition.ts` / `trajectory-compaction-definition.ts`——四种 stage 的 `ConversationNodeDefinition`（对应 `request/header`、`assistant/*`、`tool/*`、`compaction/*` 事件）；
- `trajectory-message-definitions.ts`——user/assistant 消息行；`trajectory-snapshot-builder.ts`——组装 `TrajectorySnapshot`；`trajectory-search-index.ts` / `trajectory-preview.ts`——搜索与预览；
- `duration-store.ts`——turn/step 耗时 store（`ttftMs`/`tokensPerSecond` 等派生事实）。

**布局折叠**（已核实，`layout.ts` `deriveTrajectoryLayout` `:138`）：把 legacy `ConversationNode[]` + `partial`/`runningCalls` + `RequestView[]` 折叠为 `TrajectoryTurnModel[]`（`{turn: number|null, groups}`；`turn=null` = 独立 compaction 段）。

**时长游标**：运行中的 `let prevAbsTime`（`:159`）随每个 entry 推进；每个 cell 携带 `startedAt`（epoch ms）与 `timeSeconds`（自身时长）。游标在**每个 entry 末尾**更新（`prevAbsTime = finiteTime(node.time) ?? prevAbsTime`），使 cell 自身时长可相对前一绝对时间计算。

**哪些 entry 产生 cell vs 只推进游标**：

| entry kind | 产生 cell？ | 推进游标？ |
|-----------|-----------|-----------|
| `request`（未表示的 assistant） | 是（`requestOnly` 消息 cell） | 是 |
| `system`（prompt 变更） | 是（`kind:'system'`） | 是 |
| `compaction`（RequestView） | 是（`kind:'compacted'`；`turn===null` 时独立段） | 是 |
| `user` node | 是（`kind:'user'`，`opensTurn`） | 是 |
| `steering` node | 是（`kind:'user'`，经 `steeringPlacement` 放置） | 是 |
| `assistant` node | 是（`expandAssistant` → 消息 + 工具 cell） | 是 |
| `context` node | 是（`kind:'context'`） | 是 |
| **`compaction` node（legacy）** | **否**——Chat 已拥有面向人类的标记，trajectory 不重复 | **仅推进游标**（`:415-420`） |
| `tool-result` node | 是（当 `callId` 未被 assistant 发出过，经 `emittedCallIds` 去重） | 是 |
| `partial` | 是（流式 assistant） | n/a（循环后追加） |
| `runningCalls` | 是（inflight 工具 cell） | n/a |

> **关键**：legacy `compaction` node **不产生 trajectory cell**（注释：「Chat 已拥有面向人类的 compaction 标记」），只推进游标——避免 chat 与 trajectory 两处重复展示同一压缩标记。

**性能契约**（`packages/client/AGENTS.md`）：append 热路径与 renderer 绝不扫描完整事件窗口/Contexts/Chat Nodes；在 State 中累积、经 `buildLocationData()` 发布同 Turn/Step 事实；消费最终 Node 数据或受约束的 Location hook。trajectory 用虚拟行 + 独立 stage 折叠，使超长会话（如本文实测的 7753 事件）仍可交互。

### 4.6 性能与分页契约

- **一次 append → 一个节点**；未变更节点保持引用（`MutableChatNodeStore.upsert` 同引用跳过 + `values()` 脏缓存；`orderedVisible` 仅在 apply/replace 时重算，no-op 时不变）；`LegacySliceBuilder.sameContribution` no-op 检测；`projectedBlocks` WeakMap；`ChatNodeSeat` 按 key 独立订阅——**一次 append 只重渲染一行**。
- **分页**：`PAGE_MESSAGES=50`；`installWindow` / `loadOlder` / `repairGap` / `acceptLiveEvent` 维持**单个连续 raw 区间**。
- **窗口切断 compaction**：某一页可能携带一个 checkpoint，但其被阴影的 `compaction/summary` 事件落在窗口**之外** → `summary: null` → `CompactionItem` 渲染为**不可展开的标记而非空白**（`expandable = node.summary !== null`，`CompactionItem.tsx:42`）。

---

## 5. 上下文大小如何计算（token meter）

> 本节引用子代理 C 的源码分析（`packages/llm/token-meter/`）。所有引用前缀 `pkg:` = `packages/llm/token-meter/src/`。

### 5.1 全局常量与配置（`pkg:estimate.ts`）

- `CHARS_PER_TOKEN = 4`（`estimate.ts:13`）——固定文本密度。
- `BLOCK_OVERHEAD = 4`（`estimate.ts:16`）——每个 content 块。
- `ROLE_OVERHEAD = 4`（`estimate.ts:19`，导出）——每条被计价消息加一次。
- **无配置**：`TokenMeterConfig = Record<string, never>`（`types.ts:12`）；`validateConfigKeys` 对**任何** key 抛错（`index.ts:61-65`）。无模型 profile、无 tokenizer 后端。

### 5.2 `estimateMessage` / `estimateContent`（`pkg:estimate.ts`）

`estimateMessage(message) = estimateContent(message.content) + ROLE_OVERHEAD`（`estimate.ts:56-58`）。即每条消息的 role 框架是**固定 4 token**（不分角色——system/user/assistant/tool-result 都是 +4）。

`estimateContent(blocks)`（`estimate.ts:26-49`）逐块求和，**4 字符/token = `ceil(len/4)`**：

| 块类型 | 公式 |
|--------|------|
| `text` / `reasoning` | `ceil(block.text.length / 4) + 4` |
| `tool-call` | `ceil(block.name.length/4) + ceil(block.arguments.length/4) + 4` |
| `tool-result` | `estimateContent(block.content) + 4`（递归） |
| 未知/合并（含 `image`） | `4 + ceil(JSON.stringify(block).length / 4)` |

所以每条消息：`4（role）+ Σ_blocks(4 + ceil(text/4))`。

**信封计价**（请求侧，`estimate.ts`）：
- `estimateSystemTokens(header)` = `ceil(header.system.length/4) + 4`，`header?.system === undefined` 时为 0（`estimate.ts:65-68`）。
- `estimateToolsTokens(header)` = `ceil(JSON.stringify(header.tools).length/4) + 4`，tools 缺省/空时为 0（`estimate.ts:75-78`）。
- `estimateHeader(header) = estimateSystemTokens + estimateToolsTokens`（`estimate.ts:85-87`）。

### 5.3 `measure(session, requestHeader?)`（`pkg:index.ts:116-147`）

返回深冻结快照 `{ logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes }`：

- `logRevision = state.consumedEvents`（`index.ts:140`）= 已消费 durable 事件数（= 下一条未读 seq）。
- `header = requestHeader === undefined ? state.header : canonicalHeader(requestHeader)`（`index.ts:118-120`）。
- **三个 baseline 分支**（`index.ts:123-137`）：
  1. `anchor !== undefined && optionalHeaderEquals(anchor.header, header)` → 复用 `baseline = anchor.baseline`，`surfaceDeltaTokens = state.surfaceTokens - anchor.surfaceTokens`（125-127）。
  2. `header === undefined && state.surfaceTokens === 0` → `baseline = {kind:'none', tokens:0}`，delta 0（128-130）。
  3. 否则 → `baseline = {kind:'estimated', tokens: estimateHeader(header) + state.surfaceTokens}`，`surfaceDeltaTokens = 0`（131-136）。
- `totalTokens = Math.max(0, baseline.tokens + surfaceDeltaTokens)`（143）——请求+响应压力（请求头信封 + surface；锚定时响应输出在 `baseline.tokens` 里）。
- `surfaceTokens = state.surfaceTokens`（144）——仅 surface 的启发式总和 = Σ `nodes[].tokens`。
- `nodes = state.surface`（145）——位置化头到尾 `TokenSurfaceNode[]` `{seq, tokens}`（`types.ts:37-42`）。

`requestHeader` 覆盖只改变**压力计价**（分支 1/3 的 header 选择）；surface 字段始终描述当前 session（`index.ts:108-113` doc，README:18）。

### 5.4 按 session 增量折叠（`pkg:index.ts:160-310`）

`ReplayState`（每个 `Session`，WeakMap `index.ts:79`）：
- `consumedEvents`——`session.events` 游标（`index.ts:174`）。
- `header`——最新 canonical `request/header` 快照（`index.ts:194-196`）。
- `surface: TokenSurfaceNode[]` + `surfaceTokens`（带符号运行总和，`index.ts:265-267`）。
- `stepStart: {turn, step, surfaceTokens} | undefined`——打开的 step 边界（`index.ts:203`）。
- `anchor: MeasurementAnchor {header, surfaceTokens, baseline}`（`index.ts:28-31,40`）。

`_sync`（160-181）：惰性创建 state，然后 `while (consumedEvents < session.events.length)` 折叠每个未读事件并推进游标。`ctx.on('session/event')` 仅对已跟踪 session 急切推进（`index.ts:95-97`）；读操作总通过 durable 尾部追赶。

`_foldEvent`（188-270）——**所有可失败部分在变更前准备好**（`index.ts:184-187` doc）：
- `request/header` → `nextHeader = canonicalHeader(event.data.header)`（195）。
- `step/start` → 若已有 step 打开则抛（`step/start … before turn/step ended`，197-204）；否则 `nextStepStart = {...event.data, surfaceTokens: state.surfaceTokens}`（203）。
- `step/end` → 若无匹配打开的 `step/start` 则抛（205-212）；否则清 `nextStepStart`（211）。
- surface append/replace 经 `foldSurfaceTokens`（217-219）；然后 `state.surfaceTokens += surface.deltaTokens`（267）。
- `assistant/message` → 必须位于匹配打开的 `step/start` 内（222-227）；然后设 `nextAnchor`。

**Surface 折叠**（`pkg:surface-fold.ts` `foldSurfaceTokens`，42-65）：
- `message = deriveEventMessage(event)`；`tokens = message === null ? 0 : estimateMessage(message)`（46-47）。空 content 的 `assistant/message` 派生 `null`（`session/surface.ts:99-104`）→ 0。
- `append` → push `{seq, tokens}`，`deltaTokens = tokens`（49-50）。
- `replace {start,end}` → 在 `nodes` 中定位两个 seq（52-53）；缺失/反向区间则抛（54-58）；`removed = Σ nodes[startIdx..endIdx].tokens`（59-61）；splice 入 `{seq, tokens}`；`deltaTokens = tokens - removed`（63-64）——**带符号** delta（替换更小时为负）。

**`assistant/message` 锚定**（`index.ts:221-261`）：
- `anchorSurfaceTokens = stepStart.surfaceTokens + <assistant 事件 tokens>`（238/251）——请求**看到**的 surface（step 开始）加上其自身输出。
- 有 `event.data.usage !== undefined && nextHeader !== undefined`（232-249）：
  - `providerAssistantTokens = _estimateProviderAssistant(...)`（233-237）。
  - `providerTokens = usageTokens(event.data.usage)`（239）。
  - `estimatedAnchorTokens = estimateHeader(nextHeader) + anchorSurfaceTokens`（240）。
  - `baseline = providerTokens >= estimatedAnchorTokens ? {kind:'usage', tokens: providerTokens, usage} : {kind:'estimated', tokens: estimatedAnchorTokens}`（246-248）。**仅当 provider 总量 ≥ 完整启发式锚点时复用**（带符号 delta 保持保守）。
- 无 usage（250-260）：`baseline = {kind:'estimated', tokens: estimateHeader(nextHeader) + anchorSurfaceTokens}`。

`_estimateProviderAssistant`（277-310）经 `sourceEventSeqs` 引用的精确 seq 重组 provider 输出：
- `sourceEventSeqs === undefined` → 返回 `durableEventTokens`（保守，283）。
- 每个引用 seq 必须 `< event.seq`、唯一、是同一 turn/step 的 `assistant/chunk`（287-305，否则抛）；push `chunk` 入 `BlockAssembler`（306-308）。
- `providerContent = assembler.blocks()`；返回 `providerContent.length === 0 ? 0 : estimateContent(providerContent) + ROLE_OVERHEAD`（309）。**显式空列表**把已知空流计价 0（309，README:22）。

### 5.5 provider usage 锚定与重定价（`pkg:index.ts`）

- `usageTokens(usage)` = `usage.inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + usage.outputTokens`（44-49）。桶互不重叠；`reasoningTokens` 是 `outputTokens` 的子集，**不额外加**（README:22；`llm/types.ts:130-133`）。
- 锚点相等 = `optionalHeaderEquals(anchor.header, header)`（125）：两者都 `undefined` → 相等；否则 `headerEquals`（`index.ts:52-58`）。
- `headerEquals`（`core/session/src/request-header.ts:44-54`）比较：`callConfigEquals(config)`（`llm/call-config.ts:49-59`：`provider`、`model`、`reasoningEffort`、`temperature`、`maxTokens`、`stop` 逐元素）、`adapterDefaults.reasoningEffort`、`adapterDefaults.maxTokens`、`system`（引用相等）、`tools`（长度 + 逐下标 `JSON.stringify` 相等，顺序敏感）。`canonicalHeader` 把空 `system`/`tools` 归一化为缺省、除非标记字段否则丢弃 `adapterDefaults`（`request-header.ts:21-31`）。所以 provider、model、system、前缀（adapter defaults）、tools、call-config **全部**必须匹配。
- **不匹配** → 分支 3：全量启发式重定价 `estimateHeader(header) + state.surfaceTokens`，delta 0（`index.ts:131-136`）。**匹配** → 分支 1：复用锚点 `baseline`，只应用带符号 surface delta `state.surfaceTokens - anchor.surfaceTokens`（127）——收缩的 `replace` 产生**负** delta，`totalTokens = max(0, baseline.tokens + delta)` 在 0 处钳制（143）。

### 5.6 `dsh-compaction-basic` 消费（`packages/compaction/compaction-basic/`）

**默认值**（`src/config.ts`）：`DEFAULT_THRESHOLD_RATIO = 0.8`（20）、`DEFAULT_RETAIN_RATIO = 0.16`（23）；`maxTokens ?? 8192`（91）、`compactionRetries ?? 1`（92）、`maxOverflowRetries ?? 1`（93）、`auto ?? true`（95）。

- `resolveCompactSpec(policy, contextWindow)`（`config.ts:133-167`）：`contextWindow` 必须是正整数否则 `TargetPressureConfigError`（138-143）。`thresholdTokens = floor(contextWindow × thresholdRatio)`（144）；`retainTokens = policy.retainTokens ?? floor(contextWindow × retainRatio)`（145-147）；`retainTokens >= thresholdTokens` 则抛（148-154）。
- 容量从**所属 adapter** 解析：`context = (await ctx.llm.resolveModelInfo(provider, model, signal)).context`（`index.ts:293`）；`undefined` → `TargetPressureConfigError`（296-302）。所以比率相对 adapter 宣告的容量缩放，而非固定值。
- `compactIfNeeded`（`index.ts:258-332`）：`measurement = meter.measure(agent.session)`（267）。压力路径：`if (measurement.totalTokens < spec.thresholdTokens) return null`（304）。可选模型无关 `toolResultPruner.pruneSession(...)` 然后**重测** `meter.measure(...)`（308-311）并复查阈值（312）。然后最多 `compactionRetries + 1` 次尝试：`selectCompactableRange(session, measurement, spec.retainTokens)`（316）；若 `null` 且无落地 → 返回 null / break；`compactRegion(...)`；**每次压缩后重测**（324）；一旦 `totalTokens < thresholdTokens` 返回（325）；否则抛 "still above threshold after N attempts"（328-331）。
- `context-overflow` 路径绕过阈值/保留策略：可选 prune + 重测（284-287）、retain=0 的 `selectCompactableRange(session, measurement, 0)`（288）、然后 `compactRegion`（290）。
- `selectCompactableRange`（`src/region.ts:98-134`）：校验 `measurement.nodes` 的 seq 与 `session.surface.nodes` 精确匹配（107-110，不匹配则抛）；从**尾部**遍历节点累加 `node.tokens` 直到 `accumulated >= retainTokens`（114-119），然后回退到工具对平衡边界（122-127）；返回 `{start: 首个节点 seq, end: 截断节点 seq}`（130-133）。
- **区间事务**在每边界测量（`src/region.ts`）：`compaction/start`（追加 189）后 `prepareCompaction` 调用 `meter.measure(session)`（344）、计算 `shadowedTokenCount = Σ selectedNodes.tokens`（354）、构造 summary 输入。摘要后 `summarizeCompaction` 用 `meter.estimateMessage(checkpointMessage)` 计价带框 checkpoint（373），**若不比 `shadowedTokenCount` 小则抛**（374-378）。稳定性检查重测（`assertWholeSurfaceUnchanged` 392、`assertSelectedSpanStable` 420）。提交追加带 `shadowedRange` + `shadowedTokenCount` 的 `compaction/summary` 然后一条 `user/message` `replace`（447-465）。
- `auto` 注册 `agent/pre-step`（每步压力压缩，`index.ts:147-165`）与 `agent/request-error` 命中 `CONTEXT_WINDOW_EXCEEDED_CODE`（溢出恢复，`index.ts:179-223`；重试受 `maxOverflowRetries` 门控，188-189）。

### 5.7 O(surface) 成本与 fail-loud 行为

- **每次 `measure` O(surface)**：每次调用深克隆所有位置化节点、`surfaceTokens` 总和是运行折叠，所以读是 O(surface)（`index.ts:109-111` doc；README:18,66）。三个投影单元改经 shadow-price 协议保持 O(1) 状态（`pkg:surface-projection.ts`）：`compaction/summary`/`compaction/prune` 武装一个 `ShadowPriceClaim {start, end, tokens}`（70-76）；相邻 `replace` 消费它，`deltaTokens = tokens - claim.tokens`（93）；无 claim 的 `replace` 按**零 delta** 折叠（有界状态无法重建被替换区间——历史日志漂移，82-86）；区间与武装 claim 不匹配的 `replace` 抛（87-92）。`tokenUsage` 投影用同 step 样本替换而非重复计数（`pkg:usage-projection.ts:137-148`，`addReplacing` 32-41）。`contextPressure.projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`（`usage-projection.ts:216`）。
- **对畸形 durable 边界 fail-loud**（全部抛，且因 `_foldEvent` 变更前准备好，坏事件每次重试都保持未读——`index.ts:184-187`，34-41）：
  - step 打开时 `step/start`（`index.ts:197-204`）；无匹配打开 start 的 `step/end`（205-212）；打开 step 外的 `assistant/message`（222-227）。
  - `replace` 引用 surface 中不存在的区间 / 反向（`surface-fold.ts:54-58`）。
  - `_estimateProviderAssistant`：引用 seq `>=` 当前（288-290）、重复引用 seq（291-293）、引用 seq 非 `assistant/chunk`（299-302）、引用 chunk 在不同 turn/step（303-305）。
  - 压缩：meter surface 与 session surface 不匹配（`region.ts:107-110`）、摘要不比阴影小（`region.ts:374-378`）、摘要期间 surface 变化（393-395、417-423）。
- 不变量伴生**故意留空**（"No runtime invariant"），因为估计是按调用输出、缓存在事件变更边界失效（`pkg:invariant.ts:17-29`）。

**跨包引用**：`headerEquals`/`canonicalHeader` = `packages/core/session/src/request-header.ts:21,44`；`callConfigEquals` = `packages/llm/llm/src/call-config.ts:49`；`deriveEventMessage`/`isSurfaceEvent` = `packages/core/session/src/surface.ts:83,35`；`TokenUsage` 互斥桶 doc = `packages/llm/llm/src/types.ts:127-141`。

---

## 6. 不同工具与内容如何记录

> 本节引用子代理 E 的源码分析（`packages/core/tools`、`packages/core/session`、各 tool 包）。

### 6.1 `tool/call` 与 `tool/result` 载荷 + `callId` 配对

**`tool/call`**（`packages/core/session/src/types.ts:236+`）：

```json
{ "type": "tool/call", "seq": 41, "data": {
    "turn": 3, "step": 2, "callId": "call_1f3c", "name": "read",
    "arguments": "{\"file_path\":\"packages/core/session/src/types.ts\",\"limit\":40}" } }
```

- `arguments` 是模型 tool 块产出的**原始 JSON 字符串**，**不解析、不重序列化**直接落盘（`CallId` 是 branded string，`packages/llm/llm/src/brand.ts`）。重放时再解析。
- `appendToolCall`（`packages/core/agent-loop/src/tool-calls.ts` ~263）追加 `{turn, step, callId: block.id, name: block.name, arguments: block.arguments}`。

**`tool/result`**：

```json
{ "type": "tool/result", "seq": 42, "surfaceOp": "append", "sourceEventSeqs": [41],
  "data": { "turn": 3, "step": 2,
    "message": { "id": "msg_r42", "role": "user",
      "source": { "kind": "tool", "callId": "call_1f3c" },
      "content": [ { "type": "tool-result", "toolCallId": "call_1f3c",
        "content": [ { "type": "text", "text": "<path>…</path>\n<type>file</type>\n<content>1: …</content>" } ] } ],
    "meta": { "path": "…", "offset": 175, "lines": […], "totalLines": 440, "lang": "ts" } } }
```

- `appendToolResult`（`tool-calls.ts:268-288`）构建 `createToolResultMessage({callId, content, isError})`，追加 `tool/result` 携带 `...result.error?.info ? {error} : {}`、`...result.meta !== undefined ? {meta} : {}`、`{surfaceOp:'append', sourceEventSeqs:[callSeq]}`。
- **`callId` 配对**：`sourceEventSeqs` 指向前置 `tool/call` 的 seq（callId 级配对），`turn`/`step` 提供 step 作用域。
- **追加时强制校验**（`packages/core/session/src/index.ts` ~305-352）：message 必须有 `id` + role `user`；`tool/result` 的 message 必须 `source.kind === 'tool'` 且 `callId` 匹配、content = 恰好一个 `tool-result` 块且 `toolCallId === source.callId`。

### 6.2 `ToolResultMessage` 形状

`ToolResultMessage`（`packages/llm/llm/src/message.ts:152`）是一条 **USER-role** `Message`：`{ id, role:'user', content:[ToolResultBlock], source:{kind:'tool', callId} }`。`createToolResultMessage`（`:231`）构建恰好一个 `ToolResultBlock`：`{ type:'tool-result', toolCallId, content: ContentBlock[], isError? }`（`ContentBlock = text|reasoning|tool-call|tool-result`，`packages/llm/llm/src/types.ts`）。

### 6.3 工具私有 `meta`：attach → 校验 → 回读

- **声明侧**：工具的 `output` 可声明 `presentationMeta(args, value): JsonValue`——对工具**输出值**（非渲染文本）的投影。registry 计算 `meta = tool.output.presentationMeta?.(args, value)`（`packages/core/tools/src/index.ts` ~1400-1470），线程穿进 `ToolResult { content, isError, meta?, error? }`。
- **durable 边界**：`Session.append`（`packages/core/session/src/index.ts:604`）跑 `snapshotJsonValue(data)`（`packages/core/session/src/json.ts:177`；`isJsonValue:188`）——迭代式无损 JSON 校验，拒绝 BigInt、函数、symbol、undefined、负零、非有限数、循环、稀疏、异型值；抛 `session event "tool/result" carries non-JSON-serializable data`。事件随后深冻结。**`meta` 必须是纯 JSON，否则 append 失败**——与一切在同一边界校验。
- **回读**：`presentResult(args, result)` 原样接收持久化的 `meta` 并**防御性收窄**（畸形 → `undefined` → generic-card 回退，重放绝不抛错）。

**具体 `meta` 形态**：
- `read` → `FsReadMeta { path, offset, lines:[{number,text}], totalLines, lang? }`（`packages/fs/tool-fs/src/read-render.ts:220-231`），由 `readMetaFromMeta`（`:258-272`）收窄：校验 1-based 行号、严格递增、`number <= totalLines`，任一违反返回 `undefined`。
- `edit`/`write` → `FsDiffMeta { diffs: FileDiff[] }`，`FileDiff { path, oldText: string|null, newText }`（`packages/core/tools/src/presentation.ts`），经 `computeHunkDiffs`（3 行上下文 hunk，`structuredPatch`）。
- `web_fetch` → `WebFetchMeta { url, statusCode, truncated }`（`packages/web/tool-web/src/fetch.ts:374-376`），由 `fetchMetaFromResult`（386-391）收窄。
- `web_search` → `{ answer?, sources:[{url,title,snippet?,publishedAt?}], truncated }`（`packages/web/tool-web/src/search.ts:320-345`）。

### 6.4 UI 渲染意图：声明 + 纯展示方法

**词汇**（`packages/core/tools/src/presentation.ts`）：
- `ToolCallKind = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'fetch'|'other'`。
- `FileLocation { path, line? }`、`FileDiff { path, oldText: string|null, newText }`。
- 调用侧 `ToolCallView = GenericCallView | TerminalCallView | DiffCallView`：
  - `GenericCallView { card:'generic', title, kind?, rawInput?, content?, locations? }`
  - `TerminalCallView { card:'terminal', title, description?, cwd? }`
  - `DiffCallView { card:'diff', title, diffs: FileDiff[], locations? }`
- 结果侧 `ToolResultView`：`GenericResultView`、`TerminalResultView`、`DiffResultView`、`ReadResultView`、`WebSearchResultView`、`WebFetchResultView`（`{card:'web', kind:'fetch'|'search', …}`）等。

**声明**：`ToolDefinition.presentCall(args): ToolCallView | undefined`（`index.ts` ~279）与 `presentResult(args, result): ToolResultView | undefined`（~287）。两者都是 `args`（结果侧还有持久化 `meta`）的**纯函数**——无副作用、无 I/O——所以窗口截断重放丢弃了 live call head 时仍能从日志 `tool/call`/`tool/result` 事件重建精确卡片（replay-safe）。**渲染意图（generic/terminal/diff + locations）在工具设计期决定，而非渲染期。**

**具体示例**：
- `read`（`tool-fs/src/read.ts:196-207`）：`presentCall` → `GenericCallView {card:'generic', title:'Read <path>(offset-window)', kind:'read', locations:[{path, line:offset??1}]}`；`presentResult` → `ReadResultView {card:'read', path, offset, lines, totalLines, lang?, content}`。
- `edit`（`edit.ts:151-158`）：`presentCall` → `DiffCallView {card:'diff', title:'Edit <path>', diffs:[{path, oldText:old_string||null, newText:new_string}], locations:[{path}]}`；`presentResult` → `DiffResultView` 经 `diffsFromMeta(result.meta)`，错误/畸形回退 generic。
- `write`（`write.ts:132-139`）：`presentCall` → `DiffCallView`（`oldText:null`，调用时无前内容）；`presentResult` → `DiffResultView` 经 `diffsFromMeta ?? [{path, oldText:null, newText:args.content}]`。
- `pwsh`（`tool-pwsh/src/index.ts:412-443`）：前台 → `TerminalCallView {card:'terminal', title:command, description, cwd}` + `TerminalResultView {card:'terminal', output, exitCode/signal/timedOut}`（`renderPwshResult` 文本经 `parseExitStatus`）；后台/错误 → `GenericCallView`/`GenericResultView`。
- `subagent`（`tool-subagent/src/index.ts:412-417`）：`presentCall` → `GenericCallView {card:'generic', title:'Delegate <description>', kind:'other', rawInput}`；`output.render` → `started background subagent job <jobId>` / `started subagent <subagentId>` / 前台 `output` 文本。
- `web_search`（`search.ts:336-354`）：`presentCall` → `GenericCallView {card:'generic', title:'Web search: <queries>', kind:'search', rawInput:args.queries}`；`presentResult` → `WebSearchResultView {card:'web', kind:'search', title?, answer?, sources, truncated}`。
- `web_fetch`（`fetch.ts:405-417`）：`presentResult` → `WebFetchResultView {card:'web', kind:'fetch', title:args.url, url, statusCode, truncated}`。
- `todo_write`（`tool-todo/src/index.ts:224`）：`presentCall` → `GenericCallView {card:'generic', title:'Update todo list', kind:'other', rawInput:args.todos}`。

### 6.5 六个代表性内置工具记录什么

| 工具 | `tool/result` `content`（面向模型） | `tool/result` `meta` |
|------|--------------------------------------|----------------------|
| `read`（`tool-fs/src/read.ts`） | 带行号窗口 + 续行/EOF 页脚（`formatReadOutput`，`read-render.ts:152-170`） | `FsReadMeta {path, offset, lines:[{number,text}], totalLines, lang?}` |
| `edit`/`write`（`tool-fs/src/edit.ts`、`write.ts`） | 纯确认文本 | `FsDiffMeta {diffs: FileDiff[]}`（`computeHunkDiffs`） |
| `pwsh`（`tool-pwsh/src/index.ts`） | `renderPwshResult` 文本：stdout、`[stderr]` 段、`[exit code: N]`/`[timed out after Nms]`/`[killed by signal: X]`/sandbox 拒绝标记 | 无（无 `presentationMeta`——`presentResult` 经 `parseExitStatus` 重解析渲染文本） |
| `subagent`（`tool-subagent/src/index.ts:336-374`） | `started background subagent job <jobId>` / `started subagent <subagentId>` / 前台 `output` 文本 | 无 |
| `web_search`（`tool-web/src/search.ts:348-372`） | 搜索答案 + 来源列表 | `{answer?, sources:[{url,title,snippet?,publishedAt?}], truncated}` |
| `web_fetch`（`tool-web/src/fetch.ts`） | markdown 正文 + 头行 | `{url, statusCode, truncated}` |
| `todo_write`（`tool-todo/src/index.ts:201-222`） | `Updated todo list: N pending, M in progress, K completed.` | 无 |

### 6.6 注入 context（`agent.inject()`）作为带类型 `source` 的 `user/message`

`agent.inject(message)`（`packages/core/agent-loop/src/agent.ts:130-132` → `send(input, 'next-step', false)`）为**下一个** pre-step 排队模型可见 context，不唤醒驱动（`followup` 122 → `next-turn` + 唤醒；`steer` 126 → `next-step` + 唤醒）。claim 时循环追加 `'user/message'` 带 `{surfaceOp:'append'}`（`agent.ts:283`），`content` **原样**投影。`source` 区分生产者（JSDoc `packages/core/session/src/types.ts` ~257-264）。

`MessageSourceMap`（`packages/llm/llm/src/message.ts:100`，merge-extensible）基础 kind：`user`（直接人类提示）、`plugin`（+`ContextForm`）、`model`、`tool`。`ContextForm`（`message.ts:48-60`）= `'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'`。

**生产者 `source` 值**（各包经 `declare module '@deepseek-ai/dsh-llm'` 扩展 `MessageSourceMap`）：
- `user`——直接人类提示（无生产者字段）。
- `plugin` + `plugin` 名——通用插件注入：`cordis-host-runner`、`time-context`、`tmux-context`（`form:'snapshot'`）、`user-approval`（审批策略变更通知）。
- `agent-instructions` + `form:'instructions'`——工作区 AGENTS.md 基线与文件变更通知 / 子目录 AGENTS.md 调和（`packages/context/agent-instructions/src/state.ts:37-46`）。
- `skill-catalog` + `form:'catalog'`——技能目录条目（`packages/skill/tool-skill/src/index.ts:34-41`）。
- `skill-invocation` + `form:'instructions'`——加载技能内容 `<skill_content name="…">…</skill_content>`（`packages/skill/skill/src/index.ts:147-153`）。
- `goal`——goal 续跑轮：`{kind:'goal', goalId, revision, round}`（`packages/goal/goal/src/domain.ts:47-53`）；goal-round-driver 构建 `createUserMessage({content: renderGoalRoundPrompt(goal, round), source:{kind:'goal',…}})` 并 `agent.followup`。
- `session-reference` + `form:'recall'`——跨会话材料：`{kind:'session-reference', form:'recall', version:1, references:[{sessionId, label, capturedThroughSeq, compacted, originalMessages, retainedMessages, omittedMessages, omittedBytes, truncated, inputIndex}]}`。
- `coordinator` + `form:'relay'`——协调者消息带 `senderSessionId`；`subagent-report` + `form:'relay'`——子报告；`subagent-settled` + `form:'notice'`——settle 通知（均在 `packages/subagent/subagent/src/continuation.ts:40-98`）。
- 所有这些都落为 `user/message` 事件，`content` 原样投影 + 带类型 `source` 生产者；`agent/context-injected`（`packages/core/agent/src/types.ts`，`{agent: AgentId, message: UserMessage}`）记录注入本身。

### 6.7 `todo/write` 整列表快照

- `SessionEventMap['todo/write'] = { todos: TodoItem[] }`（`packages/core/session/src/types.ts:303`）；`TodoItem { content: string, status: 'pending'|'in_progress'|'completed' }`（`types.ts:189-194`，刻意最小化——无 id/priority/activeForm，因列表整体替换、last-write-wins）。
- `todo_write` 的 `execute`（`tool-todo/src/index.ts:206-222`）经 `toTodoList`（91-111：trimmed 非空唯一 content、至多一个 `in_progress` 除非 `allowParallelInProgress`）校验，追加 `'todo/write'` 带**完整列表** `exec.agent.session.append('todo/write', {todos})`（213），返回 `{todos:[{content,status}], counts:{pending, inProgress, completed}}`。
- `todos` 投影（`index.ts:135-148`）是 standing-plan last-wins 折叠：最新 `todo/write` 列表，下一个 `turn/start` 清除（`turn/end` 保留已完成 checklist 可见），首个 write 前为 `null`。**重放 = `todo/write` 事件上 last-write-wins**。
- **交叉验证**：invariant 测试（`packages/core/session/src/invariant.spec.ts:56-364`）覆盖 `tool/call` + `tool/result` append 校验，含 `meta` JSON 可序列化性。

---

## 7. 文档索引（哪份 doc 拥有什么）

| 主题 | 文档 |
|------|------|
| Cordis 插件树、profile/bundle、core 包、三事件域、turn 流程、能力接缝、扩展点 | `docs/architecture.md` |
| turn/step 完整时序（mermaid） | `docs/agent-lifecycle.md` |
| `SessionEventMap` 逐事件 JSDoc、`session/flush` 语义 | `docs/subsystems/session.md` |
| flush 检查点批处理、崩溃恢复、`inspect`/`load`、`listSnapshots` | `docs/subsystems/persistence.md` |
| 事件溯源决策 + 顺序契约 | `.agents/notes/…/2026-06-11-event-sourced-sessions.md` |
| JSONL packed chunk 行、zstd 默认、append-only、SQLite 1:1、`runPersistenceContract` | `2026-06-14-session-persistence.md` |
| `sourceEventSeqs`/`surfaceOp` 字段、SurfaceManager delta、JSONL 零变更、SQLite 两列 | `2026-06-18-session-surface.md` |
| replay token meter 服务 | `2026-07-15-replay-token-meter-service.md` |
| 人类转录 append-origin | `…/implemented/bug-fix/2026-07-29-human-transcript-append-origin.md` |
| web 转录日志顺序投影 | `…/implemented/bug-fix/2026-07-30-web-transcript-log-ordered-projection.md` |

---

## 附：实测数据速查

| 项 | 实测值 |
|----|--------|
| 样例文件 | `~/.dsh/sessions/--D-DSH--/session-6223a091…/session.jsonl.zstd` |
| 压缩大小 | 2075 KB |
| zstd 帧数 | 6446 |
| 逻辑事件数 | 7753 |
| 事件类型数 | 24（含 header） |
| 带 `surfaceOp` 事件 | 226（其中 14 个 `replace`） |
| 带 `sourceEventSeqs` 事件 | 211 |
| `contextWindow`（qwen38） | 131000 |
| token 密度 | 4 字符/token，每块 +4，每消息 +4 |
| compaction 默认 | 阈值 0.8 / 保留 0.16 / maxTokens 8192 |

### 持久化关键常量速查

| 常量 | 值 | 位置 |
|------|----|------|
| `SESSION_FORMAT_VERSION` | `0` | `core/session/src/types.ts:56` |
| `SCHEMA_VERSION`（SQLite） | `17` | `session-persistence-sqlite/src/schema.ts:18` |
| `SESSION_PERSISTENCE_SQLITE_APPLICATION_ID` | `0x44534850`（= 1146308688 "DSHP"） | `schema.ts:20` |
| `ZSTD_MAGIC` | `0xFD2FB528` | `jsonl/src/zstd.ts:15` |
| `DEFAULT_COMPRESSION`（JSONL） | `'zstd'` | `jsonl/src/index.ts:38` |
| `DEFAULT_PACK_CHUNKS`（JSONL） | `true` | `jsonl/src/index.ts:37` |
| `MIN_RUN`（JSONL 打包） | `3` | `core/session/src/chunk-rows.ts:77` |
| `MIN_PACKED_ROW_MEMBERS` / `MAX_PACKED_ROW_MEMBERS` / `MAX_PACKED_DATA_BYTES`（SQLite） | `3` / `1024` / `1048576`（1 MiB） | `sqlite/src/codec.ts:42/44/46` |
| `ZSTD_DATA_THRESHOLD_BYTES`（SQLite） | `4096` | `sqlite/src/compression.ts:31` |
| `ZSTD_COMPRESSION_LEVEL`（SQLite） | `3` | `sqlite/src/compression.ts:36` |
| `PACKED_ROW_SENTINEL`（SQLite `ignorable`） | `0` | `sqlite/src/compression.ts:37` |
| `DEFAULT_WRITE_BATCH_MAX_DELAY_MS` | `200` | `session-persistence/src/coordinator.ts:30` |
| `DEFAULT_BUSY_TIMEOUT_MS`（SQLite） | `5000` | `sqlite/src/index.ts:31` |
| `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` | `'TOOL_NOT_STARTED'` / `'TOOL_OUTCOME_UNKNOWN'` | `core/session/src/repair.ts:13/16` |

