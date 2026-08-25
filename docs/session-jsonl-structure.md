# 会话 JSONL 行的结构与"上下文 tokens 可见性"

> 基于 `deepseek-harness/packages/core/session/src/{types,surface,index,known-event-types}.ts`
> 与 `packages/llm/llm/src/{types,message}.ts` 的类型定义，以及本工作区三个真实会话
> （`~/.dsh/sessions/--D-deepseek-harness-plugins--/session-*.jsonl.zstd`、
> `~/.dsh/sessions/--D-deepseek-harness-plugins-deepseek-harness--/…`）的实测解析
> 得出。复现脚本：[`fcdumplogs.cjs`](../fcdumplogs.cjs)。

---

## 1. 三层嵌套：一行 JSONL 里到底装了什么

每一行都是一个独立完整的 JSON 对象。**最外层是持久化封装层，内两层才是事件本体**：

```
line
 └─ { type:"session", event: { type:"<eventType>", seq:N, time:T, data:{…},
                             ignorable?:true, surfaceOp?, sourceEventSeqs? } }
```

### 1.1 最外层封装（persistence 层）

| 字段 | 含义 |
|---|---|
| `type` | `"session"` 字面量 —— 告诉解码器这一行是一个**会话事件**而非其它流格式 |
| `event` | 事件本体（见下），**所有业务字段都在这个嵌套对象里** |

**为什么多套一层**：同一 `.jsonl` 通道未来可能承载非事件行（如 header、checkpoint 标记）；
外层 `type` 让解码器先分流再解析。当前实现里 `type` 恒为 `"session"`，但解包时必须用
`rec.event ?? rec`（兼容尚未被封装的旧格式，这也是本仓库 `fcrepair.cjs` / `fctrigger_idle.cjs`
里反复出现的防御性取值模式）。

### 1.2 事件本体（`SessionEvent` 判别联合）

```ts
{
  type: SessionEventType      // 字符串，判别标签
  seq:  number               // 单调递增，从 0 开始，连续无缺口
  time: number               // Unix 毫秒时间戳
  data: PayloadByType<K>     // 随 type 变化的负载
  ignorable?: true           // 可选，仅字面量 true
  surfaceOp?: 'append' | { op:'replace', start:number, end:number }   // 仅三类消息事件可携带
  sourceEventSeqs?: number[] // 同上，可选
}
```

### 1.3 逐字段语义

| 字段 | 必填？ | 作用域 | 语义 |
|---|---|---|---|
| `type` | ✅ | 全局 | 事件类型的机器可读标签，形如 `'user/message'`、`'compaction/start'` |
| `seq` | ✅ | 全局 | **单调递增，从 0 起，连续无缺口**。`Session` 内部用它做顺序校验（`surface.ts:328` 强校验 `event.seq === expectedSeq`）。跨帧排序、表面折叠、增量重放都依赖它 |
| `time` | ✅ | 全局 | Unix epoch 毫秒。仅供观测与回放节奏参考，**不参与任何正确性判定** |
| `data` | ✅ | 随 type | 事件负载，形状由 type 决定（§3 详列） |
| `ignorable` | ⚪ 可选 | 任意 type | **布尔 true 才存在，不存在即视为必填**。读者遇到自己不懂的 `type` 且没有 `ignorable:true`，**必须拒绝重建整段日志**而非静默跳过——这是防"更新版本 harness 写的日志被老版本静默截断"的机制。纯信息记录（如本插件的 `fc-compact/*` 三件套）应当带 `ignorable:true` 以便降级加载 |
| `surfaceOp` | ⚪ 条件必填 | 仅三类 surface 事件（§2） | **进入模型可见表面的方式**：`'append'`（追加到末尾）或 `{op:'replace', start, end}`（替换 `[start,end]` 闭区间的所有表面节点，用本节点替代）。`surface.ts:185-208` 运行时强校验：**只有三类 surface 类型可以携带此字段，非 surface 类型一旦带上就抛错** |
| `sourceEventSeqs` | ⚪ | 同 `surfaceOp` | **血缘标记**：数组列出本事件"源因"事件的 seq 集。两类典型用法：<br>① `assistant/message` 引用组成它的 `assistant/chunk` seq；<br>② 压缩替换节点引用它所遮蔽掉的 surface 节点的 seq。**对 `replace` 操作，必须覆盖被遮蔽范围里的每一个 seq**（`surface.ts:240` 校验），否则折叠失败 |

> **关键约束**：`surfaceOp` 与 `sourceEventSeqs` 是**互斥于非 surface 事件**的。非 surface
> 事件一旦携带这两个字段之一，`Session.append` 立刻抛错。这条规则保证了 surface 元数据
> 只出现在产生消息的事件上，不污染 trace/boundary 类事件。

---

## 2. "是否计入上下文 tokens"的判定规则 —— 全文档的核心问题

### 2.1 唯一判定函数

`packages/core/session/src/surface.ts:26-38`：

```ts
const SURFACE_EVENT_TYPES = new Set<string>([
  'user/message',
  'assistant/message',
  'tool/result',
])

export function isSurfaceEligibleType(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}
```

**只有这三类**事件类型能进入模型可见的表面（surface），也就只有它们的 `data` 会被投影成
LLM 请求里的消息体。**其余 47 个已注册事件类型全部是 log-only**，不进 surface，也不计入
下一次请求的输入 tokens。

### 2.2 投影规则（per-node）

`surface.ts:83-114` 定义了唯一的逐节点投影函数 `deriveEventMessage(event)`：

| 事件类型 | 投影行为 | 备注 |
|---|---|---|
| `user/message` | 返回 `event.data`（一条完整的 `UserMessage`） | 原文照搬，不做二次包装 |
| `assistant/message` | 若 `event.data.message.content.length === 0` 则返回 `null`（空消息只为承载 `usage`，不入历史）；否则返回 `event.data.message` | 区分了"有内容的助手回合"和"只为记账的空壳" |
| `tool/result` | 返回 `event.data.message`（一条 `ToolResultMessage`） | 工具回执作为 `user` 角色注入模型 |
| 其它 | 一律返回 `null` | 合并扩展的 union，不会 `assertNever` |

### 2.3 三种状态 × 三条推导链

把 §1 的三个可选字段组合起来，一个事件在"上下文 tokens 视角"下有六种实际状态：

| # | `surfaceOp` | `sourceEventSeqs` | 含义 | 进 tokens？ |
|---|---|---|---|---|
| 1 | `'append'` | 缺省 | 常规追加：用户新 prompt / 模型新回复 / 新工具回执 | ✅ 计入 |
| 2 | `'append'` | 显式列出若干更早 seq | 带血缘的追加（罕见，通常是注入型合成消息想声明其来源） | ✅ 计入 |
| 3 | `{op:'replace', start, end}` | **必须包含被遮蔽范围内所有 seq** | **替换型压缩**：把 `[start,end]` 区间上的所有 surface 节点遮蔽掉，用本节点替代 | ✅ 本节点计入；被遮蔽区间不计入 |
| 4 | 缺省（非三类） | 必缺省 | 边界 / chunk / 错误 / 配置快照等 trace 类 | ❌ 不计入 |
| 5 | 非法：非三类却携带 `surfaceOp` 或 `sourceEventSeqs` | — | 运行时直接抛错 | — |
| 6 | 非法：三类却缺 `surfaceOp` | — | 运行时直接抛错 | — |

> **关键洞察**：`fc-compact/start|summary|end` 这类**压缩过程事件**属于状态 4（log-only）。
> **真正改变上下文的**是紧随其后那条 `user/message` 状态的 3（带 `surfaceOp.replace` 的
> 合成摘要消息）。插件的内置压缩路径正是靠这个分离实现的：**trace 留痕但不污染上下文，
> 摘要消息既留痕又顶替原对话区段**。

---

## 3. 全量 50 种事件类型的载荷表（含中文语义）

### 3.1 顶层骨架（`SessionEventMap` 核心成员，来自 `types.ts:236-337`）

以下按"进 surface / 不进 surface"分组，**粗体**表示该类型进 surface。

#### A. 三类 surface 事件（✅ 进上下文 tokens）

| 类型 | payload 形状 | 中文语义 |
|---|---|---|
| **`user/message`** | `UserMessage`（`role:'user'`） | 一条用户侧消息。来源三选一：直接人类 prompt（排队领取）、`agent.inject()` 合成上下文（文件变更通知、子目录 AGENTS.md、技能内容、cron 通知……）、目标延续轮次的注入。`content` 原文照搬到模型请求；`source.kind` 区分三者 |
| **`assistant/message`** | `{ turn, step, message: AssistantMessage, usage?: TokenUsage, interrupted?: true }` | 一步（step）装配好的完整助手回复。**`usage` 是唯一定义的 token 记账载体**——适配器上报后挂在助手消息上，模型输出与其计量同行，不再单设独立 usage 记录。中途取消时落盘已交付的前缀并打 `interrupted:true`，未分派的 tool-call 缺席 |
| **`tool/result`** | `{ turn, step, message: ToolResultMessage, error?: {name,code}, meta?: JsonValue }` | 一次工具调用的模型可见回执。`message` 以 `role:'user'` 形态注入（OpenAI 协议惯例：工具结果走 user 通道）。`error` 仅内部身份标识；`meta` 是对 core 透明的工具私有展示载荷（如 `dsh-tool-fs` 在此挂结果时的上下文 diff），必须 JSON 可序列化——`Session.append` 会用 `isJsonValue` 在源头做运行时校验 |

#### B. 边界 / chunk / 重试类（❌ 不进上下文）

| 类型 | payload 形状 | 中文语义 |
|---|---|---|
| `turn/start` | `{ turn: number }` | 打开第 `turn` 号回合，发生在循环认领队列入参之前 |
| `turn/end` | `{ turn, reason: TurnEndReason }` | 关闭第 `turn` 号回合。`reason` 是五态判别联合（见 §3.2） |
| `step/start` | `{ turn, step }` | 打开第 `turn` 回合内的第 `step` 步 —— 一次模型调用加上它请求的工具执行 |
| `step/end` | `{ turn, step }` | 关闭当前步 |
| `assistant/chunk` | `{ turn, step, chunk: StreamChunk }` | **token 级原始流块**，七种联合之一：block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish。提供 token 级回放保真度，但**本身不是消息**，装配完成后才会产出对应的 `assistant/message` |
| `llm/retry-started` | 结构随适配器 | 某次 LLM I/O 触发重试策略的开始标记 |
| `llm/retry` | 结构随适配器 | 重试的实际动作（指数退避、换路由等细节由适配器决定） |
| `agent/inbox/spliced` | `{ target, start, inserted?, removedCount? }` | agent inbox（队列）被插值的痕迹记录；`target` 指示插入位置锚点 |

#### C. 配置 / 头信息类（❌ 不进上下文）

| 类型 | payload 形状 | 中文语义 |
|---|---|---|
| `request/header` | `{ header: EpochHeader, reason: 'initial'\|'resume'\|'change' }` | **下一个请求头的完整快照**：`config`（provider/model/reasoningEffort/sampling 标量）+ `adapterDefaults`（哪些字段由适配器默认值填充）+ `system`（渲染后的系统提示文本）+ `tools`（组装完的工具 schema）。**最新一条即可重建整个请求头**，故为 log-only 设计——不直接参与消息装配，但保留完整审计轨迹 |
| `request/context` | `{ provider, model, contextWindow? }` | 下一请求的路由元数据，**只在路由或容量变化时才落盘**（去抖设计） |
| `permission/preset` | `{ preset }` | 权限预设切换痕迹 |
| `sandbox/mode` | `{ mode }` | 沙箱模式（workspace-write / danger-full-access / read-only 等）切换痕迹 |
| `approval/policy` | `{ policy }` | 审批策略切换痕迹（always / never / ask 等） |
| `plan/mode` | 结构随 plan 能力 | plan-mode 开关痕迹 |

#### D. 生命周期 / 标题 / 种子类（❌ 不进上下文）

| 类型 | payload 形状 | 中文语义 |
|---|---|---|
| `session/end-seed` | `Record<string, never>`（空对象） | **种子结束边界**。构造器的初始 `seed`（fork/resume/replay 继承的历史）全部排在此事件之前。定位时取**最后一条**——如果种子末尾已经有一条就不重复标记。位置与 `time` 共同携带语义，payload 为空 |
| `session/title` | `{ title, messageSeqs: number[], source }` | 会话标题生成记录。`messageSeqs` 指向驱动本次标题生成的那几条消息；`source.kind` 区分 fallback / llm 两种生成方式 |
| `session/title-llm-request` | 结构随 title-llm 能力 | LLM 生成标题的请求详情 |
| `agent-preset/selected` | `{ presetId }` | agent 预设选择痕迹 |

#### E. 反馈 / 目标 / 团队 / 计划类（❌ 不进上下文）

| 类型 | payload 形状 | 中文语义 |
|---|---|---|
| `feedback/record` | 结构随 feedback 能力 | 用户反馈记录 |
| `goal/change` | 结构随 goal 能力 | 完成目标的编辑 / 暂停 / 恢复 / 完成 / 阻塞等状态迁移 |
| `schedule/change` | 结构随 schedule 能力 | 调度任务变更 |
| `team/member` | `{ memberId, … }` | 团队成员加入 / 退出 / 属性变更 |
| `team/message/queued` | `{ from, to, … }` | 团队消息入队 |
| `team/message/delivered` | `{ from, to, … }` | 团队消息送达确认 |
| `team/task` | `{ taskId, … }` | 团队任务分配 / 完成 |
| `subagent/descriptor` | 描述符 | 子 agent 的描述符登记 |
| `todo/write` | `{ todos: TodoItem[] }` | **整列表快照**（last-write-wins，每次写替换全表）；条目最小化：只有 `content` 短命令句 + 三态 `status`（pending / in_progress / completed）。UI-only，从不进入派生历史 |

#### F. 钩子 / 命令 / 审批 / 工作流类（❌ 不进上下文）

| 类型 | payload 形状 | 中文语义 |
|---|---|---|
| `hook/invoked` | 结构随 hook 桥接 | Hook 被调用的痕迹（Claude Code / Codex 桥接） |
| `hook/result` | 结构随 hook 桥接 | Hook 执行完毕的结果 |
| `command/run` | 结构随 command-runtime | 斜杠命令运行记录 |
| `command/done` | 结构随 command-runtime | 斜杠命令结束记录 |
| `approval/asked` | 结构随 interaction 能力 | 向用户发起审批请求的痕迹 |
| `approval/decided` | `{ decision, … }` | 用户对前述审批的决定 |

#### G. 工具相关补充（❌ 不进上下文，除非升级为 `tool/result`）

| 类型 | payload 形状 | 中文语义 |
|---|---|---|
| `tool/call` | `{ turn, step, callId, name, arguments }` | 模型请求了一次工具调用。**`arguments` 保持原始 JSON 字符串不解析**（原样透传模型的输出），`callId` 与后续 `tool/result` 配对 |
| `tool/code-dispatch` | 结构随 code-runtime | 代码片段分派的最终形态 |
| `tool/code-dispatch-start` | 结构随 code-runtime | 代码分派开始标记 |
| `tool-workflow/agent-start` / `-end` | 结构随 workflow 能力 | Workflow 里某个子 agent 的生命周期 |
| `tool-workflow/run-start` / `-end` | 结构随 workflow 能力 | Workflow 整体运行的生命周期 |

#### H. Web 检索专用（❌ 不进上下文）

| 类型 | payload 形状 | 中文语义 |
|---|---|---|
| `web/deepseek-search-llm-request` | 结构随 web 能力 | DeepSeek 搜索后端发起 LLM 查询的请求详情 |

### 3.2 `TurnEndReason` 的五态判别联合（`types.ts:155-174`）

```ts
interface TurnEndReasonMap {
  completed:     { kind: 'completed' }
  aborted:       { kind: 'aborted'; reason: TurnEndCancelCause }
  blocked:       { kind: 'blocked' }
  error:         { kind: 'error'; error: LlmFailure }
  'max-tokens':  { kind: 'max-tokens' }
  interrupted:   { kind: 'interrupted' }   // 持久化后端在重载时关闭崩溃孤儿回合
}
```

`TurnEndCancelCause` 本身也是四态判别联合：`user / parent / hook{reason} / disposed`，
再加一个 `legacy`（导入的老记录未携带原因）。`interrupted` 是唯一由持久化层而非循环自身
产出的标记，且**此前记录的所有事件保持完好**——循环从不主动 emit 这个标记。

### 3.3 `TodoItem` 的最小三态（`types.ts:189-194`）

```ts
interface TodoItem {
  content: string                                   // 人类可读的短命令句
  status: 'pending' | 'in_progress' | 'completed'
}
```

刻意极简：无 id、无优先级、无 `activeForm`。整列表 last-write-wins，条目无需稳定身份。

### 3.4 `EpochHeader` / `RequestContext`（`types.ts:201-220`）

```ts
interface EpochHeader {
  config: LlmCallConfig                       // provider / model / reasoningEffort / temperature / maxTokens / stop
  adapterDefaults?: LlmCallConfigAdapterDefaults   // 哪几个字段是适配器默认填的
  system?: string                              // 渲染完的系统提示；无系统则为空
  tools?: ToolSchema[]                          // 组装完的工具 schema；无工具则为空
}
interface RequestContext {
  provider: string
  model: string
  contextWindow?: number                        // 最大请求 + 响应上下文（token）
}
```

两者都是 log-only 的设计意图很明确：**请求头本身不算对话消息**，但它决定了每次请求长什么样；
把它按"最新快照重建"的规则记录，就能精确复现任何一个请求的输入参数。

### 3.5 `ContentBlockMap` 五种内容块（`types.ts:99-110`）

| 块类型 | 形状 | 说明 |
|---|---|---|
| `text` | `TextBlock` | 普通文本 |
| `reasoning` | `ReasoningBlock` | CoT（思考链） |
| `image` | `ImageBlock` | 图片（持久化引用或 base64 二选一） |
| `tool-call` | `ToolCallBlock` | 助手发起的工具调用 |
| `tool-result` | `ToolResultBlock` | 工具回执块 |

### 3.6 `TokenUsage` 的四段计量（`types.ts:135-141`）

```ts
interface TokenUsage {
  inputTokens: number            // 未缓存输入
  outputTokens: number
  cacheReadTokens?: number       // 缓存命中
  cacheWriteTokens?: number      // 缓存写入
  reasoningTokens?: number       // 推理链 token
}
```

三段输入计数**互不相交**（`inputTokens` 只是未命中缓存的那部分），计费输入 = 三者之和。
适配器如果上游把缓存命中折进了总 prompt 数（DeepSeek 的 `prompt_tokens` 就是如此），要减回去。

### 3.7 `FinishReasonMap` 五种终止原因（`types.ts:116-125`）

`stop / tool-calls / max-tokens / aborted{failure} / error{failure}` —— 合并可扩展的 union，
适配器可加 provider 特有的 reason。

---

## 4. 真实日志中的六行样例（取自本工作区最近三个会话）

| 序 | 实测行（节选） | 类别 | 进 tokens？ |
|---|---|---|---|
| 0 | `{"type":"permission/preset","seq":0,"data":{"preset":"danger-full-access"}}` | 配置快照 | ❌ |
| 3 | `{"type":"session/end-seed","seq":3,"data":{}}` | 种子边界 | ❌ |
| 7 | `{"type":"step/start","seq":7,"data":{"turn":1,"step":1}}` | 边界 | ❌ |
| 8 | `{"type":"user/message","seq":8,"data":{"content":[{"type":"text","text":"我的插件…"}],"role":"user","source":{"kind":"user","rpcId":"6aa5c6da…"}},"surfaceOp":"append"}` | 用户 prompt | ✅ |
| 9 | `{"type":"user/message","seq":9,"data":{"content":[{"type":"text","text":"<system-reminder>The following workspace instructions…"}],"role":"user","source":{"kind":"plugin","plugin":"agent-instructions"}},"surfaceOp":"append"}` | 注入式合成上下文 | ✅ |
| 12 | `{"type":"request/header","seq":12,"data":{"header":{"config":{"provider":"qwen38","model":"/root/models/Qwen3.8-27B-Q4_K_M.gguf","reasoningEffort":"off","maxTokens":1000000},"adapterDefaults":{"maxTokens":true},"system":"You are an AI agent powered by DeepSeek …"},"reason":"initial"}}` | 请求头 | ❌ |

> 注意：`session/title` 的 `messageSeqs:[8]` 指回第 8 号事件——这就是 `sourceEventSeqs`
> 思想的另一种表达（虽然这里挂在 `data` 而不是顶层 envelope，语义等价）。

---

## 5. 一句话总结（回答"如何定义被记录到 / 不被记录到"）

| 维度 | 被记录到上下文 tokens | 不被记录 |
|---|---|---|
| **准入标准** | `type ∈ {'user/message','assistant/message','tool/result'}` 且顶层携带合法 `surfaceOp` | 其余 47 个已注册类型全部自动排除 |
| **物理载体** | 通过 `deriveEventMessage` 投影为 LLM 请求的消息体，经 `foldSurface` 折叠后进入"当前表面" | 留在 append-only 日志里供回放 / 审计，但对下一次模型请求不可见 |
| **替换机制** | `surfaceOp.replace` 可把一段已有 surface 区间遮蔽掉，用新的合成消息替代（压缩场景） | 无对应机制——log-only 事件不能被"遮蔽"，只能被追加 |
| **计量归属** | `assistant/message` 是 `usage` 的唯一宿主；`user/message` / `tool/result` 自身不带 `usage` | `request/header` 虽含 `config.maxTokens` 等采样上限，但这不是"消耗了多少 token"的记录，而是"下一步允许多少"的配置 |
| **插件扩展** | 新增 surface 类型必须同时扩充 `SURFACE_EVENT_TYPES` 集合并在 `deriveEventMessage` 加分支——两条都改才能生效 | 插件自定义类型只需带 `ignorable:true` 即可安全共存（如本插件的 `fc-compact/*`），不改 core 也能降级加载 |

**最简记忆法**：**三类消息进表面，四十七类进日志；三类消息要么 append 要么 replace；四十七类只能 append。**

---

## 6. 对本插件 `dsh-force-compact` 的直接含义

1. **`fc-compact/*` 三件套必须带 `ignorable:true`** —— 它们属于状态 4，是 trace 不是
   消息；带标记后老版本 harness 读到时可以直接跳过而不拒绝整段日志。
2. **真正的上下文改动必须由一条带 `surfaceOp.replace` 的 `user/message` 承担** ——
   插件在 `built-in.js` 里 append 合成摘要时，必须精确计算被遮蔽范围的
   `sourceEventSeqs`，漏一个 seq 就会触发 `surface.ts:240` 的 `must include every
   shadowed surface node` 异常，导致整次 append 失败。
3. **不能试图给 `fc-compact/*` 加 `surfaceOp`** —— `surface.ts:188-192` 会直接抛错，
   因为非三类事件携带 `surfaceOp` 本身就是不变量违反。

---

## 7. 引用定位

| 事实 | 出处 |
|---|---|
| 三类 surface 白名单 | `deepseek-harness/packages/core/session/src/surface.ts:15-19` |
| `deriveEventMessage` 投影规则 | `surface.ts:83-114` |
| `surfaceOp` 强校验（仅限三类） | `surface.ts:185-208` |
| `replace` 必须覆盖全部被遮蔽 seq | `surface.ts:240` |
| 全量 50 个已知事件类型 | `deepseek-harness/packages/core/session/src/known-event-types.ts` |
| `SessionEventMap` 核心成员 + JSDoc 契约 | `deepseek-harness/packages/core/session/src/types.ts:236-337` |
| `TurnEndReason` / `TodoItem` / `EpochHeader` / `RequestContext` | `types.ts:155-228` |
| `ContentBlockMap` / `TokenUsage` / `FinishReasonMap` | `deepseek-harness/packages/llm/llm/src/types.ts:99-141, 116-125, 312` |
| `Message` / `UserMessage` / `AssistantMessage` / `ToolResultMessage` | `deepseek-harness/packages/llm/llm/src/message.ts:128-156` |
| 实测样例 | `%USERPROFILE%\.dsh\sessions\--D-deepseek-harness-plugins--\session-*.jsonl.zstd`、`--D-deepseek-harness-plugins-deepseek-harness--\session-*.jsonl.zstd`（由 [`fcdumplogs.cjs`](../fcdumplogs.cjs) 解出） |
