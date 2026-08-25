# DeepSeek Harness 后端接口全量清单（Backend API Catalogue）

本文件是 harness Web 后端的**跨源手工核对总表**，覆盖所有可由客户端触达的接口。它不是单一生成器：每个条目都标注了权威来源文件与行号，便于回溯。当源码变动时，以源码为准、并同步更新本文。

**四类接口面**（按物理通道划分，互不重叠、合起来即全集）：

| # | 面 | 通道 | 形式 | 数量 |
|---|----|------|------|------|
| S1 | 一元 RPC | `POST /api/<ns>.<method>` | `client-request` 信封 | 74 个方法 |
| S2 | 流式下行 | `GET /api/events.mux`、`GET /api/events.host`（裸 GET=SSE；浏览器强制 WS 升级） | SSE / WebSocket，帧为 `server-request` 包络 | 2 条流 + 两套帧联合 |
| S3 | 应答回调 | `POST /api/respond` | `client-response`（回显发起方 rpcId） | 1 端点（承载审批/问答应答） |
| S4 | 网关命名空间 | `POST /api/<ns>/<method>`（**斜杠**分隔段，经 Typert 网关派发） | 同 `/api` 前缀，`ns/method` 斜杠形态 | 7 个命名空间 ≈ 25 个远程方法 |

另有 **GET 下载通道**（无信封，宿主独占）：`GET /api/session.export`。以及 **11 个可转发宿主事件**白名单。前端调用普查见文末「前端实际调用」节。

> 权威锚点：`packages/host/apiproxy/src/api/rpc-map.ts`（S1 注册表）、`packages/host/apiproxy/src/fetch/handler.ts`（全部物理路由）、`packages/host/apiproxy/src/api/events.ts`（S2 帧联合）、`packages/api/gateway/src/index.ts` + `packages/api/remotes/src/client/index.ts`（S4 挂载）。

---

## 通用约定（适用于全部四面的传输细节）

- **URL 形态**：`POST http://127.0.0.1:<port>/api/<namespace>.<method>`，命名空间与方法之间是**句点**。请求体信封：`{"type":"client-request","rpcId":"<uuid>","method":"<ns>.<method>","payload":{...}}`，`Content-Type: application/json`。
- **响应**：`{"type":"server-response","rpcId":"…","result":{"ok":true,"value":{…}}}`；业务错误同样返回 HTTP 200，错误置于 `result:{ok:false,error:{code,message,details}}`。
- **路径↔method 必须逐字一致**：`method` 字段须等于 URL 末段，否则 `bad-request: method "…" does not match path "…"`（`handler.ts:314-316`）。
- **状态码语义**（仅表达载体层，`handler.ts:4-6`）：未知路径 **404**；非 JSON media type（POST）**415**；body 非 JSON **400**；处理器崩溃 **500**；body 超 300 MiB（`http-bridge.ts:12 DEFAULT_MAX_REQUEST_BODY_BYTES`）**413**。业务结果永远是 200。
- **安全模型——信任围栏而非鉴权**：无 bearer/cookie/OAuth（`api-request-trust.ts`）。每个 `/api` 请求过围栏：Host 头须为回环或受信主机（防 DNS rebinding）、`sec-fetch-site=cross-site` 拒绝、存在 `Origin` 时须等于 Host 权威值（`"null"` 拒）。未受信 → **403**。另有一批**特权方法仅回环可达**（`settings.*`、`credentials.*`、`llm.discoverModels`、部分 `agentPreset.*`/`host.*`），其围栏用空受信列表评估。

---

## S1 — 一元 RPC（`RpcMethodMap`，共 74 方法，编译期锁定路由表）

`rpc-map.ts` 的 `RpcMethodMap` 是唯一签名真源；`handler.ts` 的 `UNARY_ROUTES` 与之编译器绑定（缺一路由行则无法编译）。每行含 schema+invoke 对。下表按命名空间分组。**所有方法均为 `POST /api/<ns>.<method>`**。定义文件相对 `packages/host/apiproxy/src/api/`。

### `session.*`（`SessionsApi`，`sessions.ts`，12 个）

| 方法 | 载荷（payload 字段） | 返回（`ok.value`） | 备注 |
|---|---|---|---|
| `session.list` | `cursor?: string` | `{ items: SessionSummary[] }` | |
| `session.search` | `query: string`（非空 ≤500，无 NUL）+`signal?` | `{ items: SessionSearchItem[], hasMore }` | 上限 20 条、摘要截断 240 码点（`session-search.ts`） |
| `session.create` | `workspaceId?`, `cwd?`, `sessionId?`, `agentPreset?`（`workspaceId`/`cwd` 至多其一） | `{ sessionId, agentPreset? }` | |
| `session.history` | `sessionId`, `beforeSeq?`, `maxMessages?` | `{ events: HistoryEntry[], hasMore, projections? }` | 历史项**包裹于 `.event`** |
| `session.models` | `sessionId` | `SessionModels{ current, routable, groups[], failures[] }` | |
| `session.selectModel` | `sessionId`, `provider`, `model`, `reasoningEffort?` | `{ selected: ModelSelection }` | |
| `session.rename` | `sessionId`, `title` | `{ title, seq }` | |
| `session.fork` | `sessionId`, `atSeq?` | `{ sessionId }` | 新分支会话 |
| `session.prompt` | `sessionId`, `mode: 'queue'\|'steer'`, `content: PromptContentPart[]`, `clientTimeZone?` | `{ accepted:true, command? }` | 回合异步执行；缺 `mode`/`content` → 400 |
| `session.attachment` | `sessionId`, `attachmentId` | `{ attachment, data }` | 取编码图像附件 |
| `session.updateQueue` | `sessionId`, `itemId`, `action: QueueAction` | `{ accepted:true }` | `QueueAction={kind:'edit',content[]}\|{kind:'remove'}\|{kind:'steer'}` |
| `session.cancel` | `sessionId` | `{ accepted:true }` | |

对应 Zod（`sessions.schema.ts`）：`sessionList/Search/Create/History/Models/SelectModel/Rename/Fork/Prompt/Attachment/UpdateQueue/Cancel RequestSchema`。

### `subagent.*`（`SubagentsApi`，`subagents.ts`，4 个）

| 方法 | 载荷 | 返回 | 备注 |
|---|---|---|---|
| `subagent.list` | `parentSessionId` +`signal?` | `SubagentCatalog{ entries[], parentAvailable }` | |
| `subagent.history` | `SubagentAddress&{beforeSeq?,maxMessages?}` +`signal?` | `{ events[], hasMore, projections? }` | 地址含 `parentSessionId,childSessionId,mode:'one-shot'\|'continuable'` |
| `subagent.prompt` | `Extract<Address,{mode:'continuable'}>&{content[],clientTimeZone?}` +`signal` | `SubagentPromptReceipt{ messageId }` | 唤醒/追问子代理 |
| `subagent.interrupt` | `Extract<Address,{mode:'continuable'}>` | `SubagentInterruptReceipt{ accepted:true }` | 中断进行中子回合 |

### `host.*`（`HostApi`，`host.ts`，5 个 —— 文件系统/目录选择器，与 `events.host` 流同名不同物）

| 方法 | 载荷 | 返回 | 备注 |
|---|---|---|---|
| `host.describe` | `{}` | `{ version,cwd,provider?,model?,attachedSessions,home,canOpenPath }` | 握手探测用 |
| `host.pickDirectory` | `{}` +`signal` | `{ path: string\|null }` | null=用户取消 |
| `host.listDirectory` | `path?`（省略=家目录）+`signal?` | `DirectoryListing{ path,home,crumbs[],entries[],truncated }` | |
| `host.createDirectory` | `path`, `name`（单一无 `/`\`\ 段） | `{ path }` | |
| `host.openPath` | `path` +`signal` | `{ opened:true }` | 原生打开路径（产出文件提及） |

### `workspace.*`（`WorkspaceApi`，`workspace.ts`，7 个）

| 方法 | 载荷 | 返回 |
|---|---|---|
| `workspace.list` | `{}` | `{ items: WorkspaceView[], archivedSessionIds[] }` |
| `workspace.create` | `path`（仅已存在目录，不建） | `{ workspace, created }` |
| `workspace.rename` | `workspaceId`, `title` | `{ workspace }` |
| `workspace.delete` | `workspaceId` | `{ deleted:true }` |
| `workspace.insertBefore` | `workspaceId`, `beforeWorkspaceId?` | `{ workspaceIds[] }` |
| `workspace.insertSessionBefore` | `workspaceId`,`sessionId`,`beforeSessionId?` | `{ workspace }` |
| `workspace.archiveSession` | `sessionId` | `{ archivedSessionIds[] }` |

### `skill.*`（`SkillsApi`，`skills.ts`，1 个）

| 方法 | 载荷 | 返回 | 备注 |
|---|---|---|---|
| `skill.list` | `sessionId` | `{ skills: readonly SkillEntry[] }` | 技能调用本身是带 `/name` 首词的普通 `session.prompt` |

### `agentPreset.*`（`AgentPresetsApi`，`agent-presets.ts`，6 个）

| 方法 | 载荷 | 返回 |
|---|---|---|
| `agentPreset.list` | `{}` | `{ presets[], authorable, hasDocument }` |
| `agentPreset.select` | `sessionId`, `agentPreset` | `{ agentPreset }` |
| `agentPreset.read` | `agentPreset` | `{ agentPreset, trust:'system'\|'user', content, name?, description? }` |
| `agentPreset.copy` | `from`, `agentPreset`, `name?` | `{ agentPreset }` |
| `agentPreset.openDocument` | `agentPreset` +`signal` | `{opened:true}\|{opened:false,path}` |
| `agentPreset.remove` | `agentPreset` | `{}` |

### `goal.*`（`GoalsApi`，`goals.ts`，6 个 —— 纯变更域，读态走投影）

| 方法 | 载荷 | 返回 |
|---|---|---|
| `goal.create` | `sessionId`, `objective`(≥1), `maxGoalRounds?` | `{ ref: GoalRef }` |
| `goal.edit` | `sessionId`, `ref`, `objective?`, `maxGoalRounds?`（至少其一必填） | `{ ref }` |
| `goal.pause` | `sessionId`, `ref` | `{ ref }` |
| `goal.resume` | `sessionId`, `ref` | `{ ref }` |
| `goal.complete` | `sessionId`, `ref` | `{ ref }` |
| `goal.clear` | `sessionId`, `ref` | `{ cleared:true }` |

`GoalRef={id: GoalId(Branded),revision:number}`。目标状态本体随 `'goal'` 会话投影 + `session/projection` 帧下发，故无 `goal.get`。

### `settings.*`（`SettingsApi`，`settings.ts`，5 个）

| 方法 | 载荷 | 返回 |
|---|---|---|
| `settings.describe` | `{}` | `{ writable, hasDocument, namespaces: SettingsNamespaceView[] }` |
| `settings.openDocument` | `{}` +`signal` | `{ opened:true }` |
| `settings.update` | `ns`, `patch:object`, `expectedRevision?` | `SettingsNamespaceView` |
| `settings.replace` | `ns`, `section:object`, `expectedRevision?` | `SettingsNamespaceView` |
| `settings.mutate` | `ns`, `ops: SettingsPathOpView[]`, `expectedRevision?` | `SettingsNamespaceView` |

`SettingsPathOpView={op:'set',path:string[],value}\|{op:'unset',path:string[]}`。

### `credentials.*`（`CredentialsApi`，`credentials.ts`，3 个）

| 方法 | 载荷 | 返回 |
|---|---|---|
| `credentials.describe` | `refs: string[]`（各匹配 `[A-Za-z_][A-Za-z0-9_]*`，≤64） | `{ credentials: Record<string,CredentialView> }` |
| `credentials.set` | `ref`, `value`(≥1) | `{}` |
| `credentials.unset` | `ref` | `{}` |

`CredentialView={configured,source?,writable}`。无枚举法——引用集从 settings schema 获知。

### `llm.*`（`LlmApi`，`llm.ts`，3 个）

| 方法 | 载荷 | 返回 |
|---|---|---|
| `llm.providers` | `{}` | `{ providers: ConfigurableProviderView[] }` |
| `llm.models` | `{}` | `{ groups: ModelProviderGroup[], failures: ModelCatalogFailure[] }` |
| `llm.discoverModels` | `settingsNs`, `provider?`,`baseURL?`,`api?`,`apiKey?` +`signal?` | `{ models: DiscoveredModelView[] }` |

---

## S3 — 应答回调 `POST /api/respond`（`client-response`）

服务端把某些交互作为 **`server-request` 帧**下推（走 S2 流），客户端必须以 `client-response` 回应。`handler.ts:296-300` 拦截 `/api/respond`，解析 `clientResponseSchema` 调 `api.respond`。关键：**`rpcId` 回显发起帧的 id，绝不重铸**。两类应答（二者皆非独立 RPC 方法，属"服务器请求需客户响应"一类）：

| 触发帧（来自 `events.mux`） | 应答载荷 | 结果回执 |
|---|---|---|
| `approval/requested` | `ApprovalResponsePayload{ sessionId, approvalId, outcome:'allowed-once'\|'rejected' }`（`approvals.ts`） | `RpcReceipt{accepted:true}\|{accepted:false,reason:'not-pending'\|'bad-response'}` |
| `question/requested` | `QuestionResponsePayload{ sessionId, answer:AskUserQuestionAnswer }`（`questions.ts`） | 同上；客户发 cancelled 错误 → 记 `ASK_CANCELLED` |

实现：`api-proxy.ts:3594-3639`，先查 `pendingApprovals.get(rpcId)` / `pendingQuestions.get(rpcId)`，校验 `ok`、schema、id 一致性再 resolve；最终结果再以 `approval/resolved` / `question/resolved` mux 帧广播给所有订阅者。

---

## S4 — 网关命名空间（Typert 远程，`ns/method` 斜杠形态，约 25 方法）

经 Typert 网关派发的宿主服务，挂在同一 `/api` 前缀但方法段用**斜杠**（如 `/api/messageFeedback/put`）。挂载清单见 `packages/api/remotes/src/client/index.ts`（`apply` 内 `$mount` 七份贡献）。一个服务方法成为远程方法的条件是其携带 `@Remote('<wire>')` 标记（或 `TypertRemoteService` 公有方法默认暴露）。下列为本仓库实际装配的七个命名空间及其方法（命名空间名取自各服务类 `super(ctx,'<key>')` 构造参数）：

| 命名空间（wire） | 拥有包 | 远程方法（wire 名） |
|---|---|---|
| `commands` | `packages/interaction/commands` | `list`, `execute` |
| `goals` | `packages/goal/goal` | `create`, `edit`, `pause`, `resume`, `complete`, `clear` |
| `dynamicCordisRunner`（挂载别名 `dynamic`） | `packages/extensions/cordis-host-runner` | `runHostHalf`, `getClientCode`, `resolveRequestRun`, `settleUserRun`, `stopFromPanel`, `syncInspectManifest`, `resolveInspectQuery`, `inventory`, `reportRenderFailure`, `reportClientGuardFailure`, `invoke`, `undefinedFromPanel` |
| `fileReferences` | `packages/context/file-reference` | `list` |
| `sessionReferenceResolver`（挂载别名 `sessionReferences`） | `packages/context/session-reference` | `candidates` |
| `pluginInventory` | `packages/host/plugin-inventory` | `list` |
| `messageFeedback` | `packages/feedback/message-feedback` | `list`, `put`, `delete` |

方法级契约详见各包 `src/index.ts` 的 `@Remote` 标记处及 `packages/extensions/tool-cordis/src/api-catalog.ts`（生成式签名/描述目录）。注意 `goals` 同时存在于 S1（`goal.*` 句点 RPC）与本 S4（`goals` 斜杠远程），两者入口不同、勿混。

> 前端实测出现的就是这一族的斜杠形态：`messageFeedback/put|list|delete`（见文末）。`api-catalog.ts` 还罗列了更多**内部**服务（如 `lsp`、`permissionPresets`、`planMode`、`sandbox`），但它们无 `@Remote` 远程装配，不可经此通道触达，故不计入本表。

---

## S2 — 流式下行（两条逻辑流 + 两套帧联合）

`EventsApi`（`events.ts:47-63`）声明两个开流器，均产 `AsyncIterable<RpcRequest<Frame>>`。每条帧被 `fullFrame`（`handler.ts:194-197`）包成 `server-request` 全形态（`method`=帧 `type` 字面量）。

### 物理通道（两种并行载运器，客户端择一）

| 路径 | 裸 GET | WebSocket 升级 | 说明 |
|---|---|---|---|
| `/api/events.mux` | SSE `text/event-stream` | 浏览器 `WebApiClient` 强制升级 | `handler.ts:254-255` |
| `/api/events.host` | SSE `text/event-stream` | 同上 | `handler.ts:257-258` |

- 进程内/CLI/fetch 载运器：手动 fetch+SSE 解析（**不用 `EventSource`**，`fetch/client.ts:369-408`），开头写 `: connected` 注释行供代理保活。
- 浏览器 GUI：同源两路径上开真实 WebSocket（scheme http(s)→ws(s)，`websocket-downlink.ts:51-138`），**只下行**——任何上行消息触发 `close(1008,'downlink only')`。裸 GET 落在浏览器 GUI 服务器上会被共享 `/api` 处理短路为 **426 Upgrade Required**（`connection/src/index.ts:150-155`）。
- 无 `since` 续传（v1 忽略该参数）；重连=重新开流+重取 history。流终结于 `stream/error` 帧或客户端中止。

### `MuxFrame` 联合（`events.ts:69-108`，`type` 判别，10 变体）

| `type` | 载荷字段 | 可答？ |
|---|---|---|
| `session/event` | `sessionId`, `event: SessionEvent`, `view?: ToolEventView` | 否（LLM 流块亦嵌套于此事件内） |
| `session/subscribed` | `sessionId`, `lastSeq:int` | 否（订阅基线控制帧，打开时每会话一条） |
| `approval/requested` | `sessionId`, `approvalId`, `toolName`, `callId?`, `reason?` | **是**（经 `/api/respond` 答 `ApprovalResponsePayload`） |
| `approval/resolved` | `sessionId`, `approvalId`, `outcome:'allowed-once'\|'rejected'\|'cancelled'\|'unavailable'` | 否（广播结果） |
| `question/requested` | `sessionId`, `questions: AskUserQuestionItem[]`(≥1) | **是**（经 `/api/respond` 答 `QuestionResponsePayload`） |
| `question/resolved` | `sessionId`, `questionRpcId`, `outcome:'answered'\|'cancelled'` | 否 |
| `session/queue` | `sessionId`, `items:{ id,placement:'queued'\|'steering'\|'context',message }[]` | 否 |
| `session/jobs` | `sessionId`, `jobs: JobView[]` | 否（作业信息纯推送，无 `job.*` RPC） |
| `session/projection` | `sessionId`, `key`, `value`, `seq` | 否（标题等通用投影） |
| `stream/error` | `error: RpcError` | —（终局失败帧） |

### `HostFrame` 联合（`events.ts:127-155`，`type` 判别，10 变体）

| `type` | 载荷字段 |
|---|---|
| `host/session-added` | `sessionId`, `blank`, `parentSessionId?`, `origin?='subagent'`, `cwd?`, `agentPreset?` |
| `host/session-removed` | `sessionId` |
| `host/session-status` | `sessionId`, `running:boolean` |
| `host/agent-error` | `sessionId`, `message` |
| `host/workspace-changed` | `workspace: WorkspaceView` |
| `host/workspace-removed` | `workspaceId` |
| `host/workspace-order-changed` | `workspaceIds[]` |
| `host/archived-sessions-changed` | `archivedSessionIds[]` |
| `host/remote-event` | `event:string`, `args:JsonValue[]`（见下方转发事件白名单） |
| `stream/error` | `error: RpcError` |

---

## GET 下载通道（无信封，宿主独占，不在 `IApiClient`）

| 端点 | 方法 | 查询参数 | 返回 |
|---|---|---|---|
| `GET /api/session.export` | GET / HEAD | `sessionId`(必填)、`includeDescendants?('true'\|'false'\|缺省)` | 单个会话日志 ZIP（可含子代理日志）二进体制附；查询非法 400、缺失根会话 404、缺服务 500 |

契约 `downloads.ts:21-24`（`DownloadsApi.sessionLog`）、`downloads.schema.ts:18`（`sessionLogQuerySchema` 解析裸查询串）、`handler.ts:260-271`。刻意不入浏览器 `IApiClient`（`index.ts:34-35`）。

---

## 可转发宿主事件白名单（`host/remote-event` 帧唯一承载）

`packages/api/remotes/src/remote-events.ts:17-29` 的 `API_REMOTE_FORWARDED_EVENTS` 是**唯一**控制点：既是客户 `ctx.remote.$on` 合法键集（投射为类型 `ApiRemoteForwardedEvent`），又是宿主转发循环订阅集合。逐字转发（无投影/脱敏/改名），落 `HostFrame` 的 `host/remote-event` 变体。当前 11 个：

```
agent-preset/selected          commands/change                 credentials/reference-updated
cordis/request-run             cordis/request-run-resolved     cordis/dynamic-package
cordis/dynamic-retract         cordis/inspect-query            cordis/inspect-query-resolved
llm/adapters-updated           settings/document-updated
```

新增一条转发事件＝在该数组加一行，别无他处。宿主侧转发循环在 `api-proxy.ts:~3518`（`...API_REMOTE_FORWARDED_EVENTS.map(name => ctx.on(...))`）。

---

## 连接引导（handshake，无令牌）

1. 每个 `/api` 请求先过硬性信任围栏（上文「通用约定·安全模型」），未受信 403。
2. 浏览器就绪握手（`ConnectionController.loop`，`connection/src/client/connection.ts:107-168`）：**同开** mux 与 host 两流，再 `await Promise.all([host.describe({}), muxOnOpen ∧ hostOnOpen])`，`streamOpenTimeoutMs` 默认 3000 ms 竞速守护——严格证明两物理流已建立且 `host.describe` 一元可达后才发 `onConnected`（避免触发重同步抢跑订阅基线）。失连 → 指数退避重连（基数 500ms ×2，封顶 10s，抖动）。
3. 首个 `/api` 触碰就是握手内的 `host.describe` 一元 POST；无独立"鉴权 GET"、无 token 交换、无 origin 探测。

---

## 前端实际调用普查（`apps/web`）

`apps/web` 仅 `src/main.ts` 引导 `@deepseek-ai/dsh-client-web`；`vite.config.ts` 硬拒独立 serve，前端**不自持**任何服务端中间件/API 路由（`/api/*` 全部终止于 `dsh web` CLI 宿主）。生产调用代码在工作区包 `packages/client/*`，此处仅见于 e2e 测试桩。实测命中的 wire 标识（均在 `apps/web/tests/**`）：

**句点形态（S1/S3）**：`session.create/.prompt/.history/.list/.export/.fork/.cancel`、`workspace.list`、`subagent.list/.prompt/.interrupt`、`settings.describe/.openDocument`、`host.openPath`。动态构造家族仅三处通用包装（`rpc(baseUrl,method,payload)`→`` /api/${method} ``；`page.route(**/api/${method})`；`invoke(rpcId,endpoint,…)`→`` /api/${endpoint} ``），无其它反引号模板插值。

**斜杠形态（S4）**：`messageFeedback/put`、`messageFeedback/list`、`messageFeedback/delete` —— 这是前端**唯一**出现的斜杠族，印证 S4 网关通道的存在与命名约定差异。

前端**不存在** `ctx.remote.<ns>.<method>(…)` 直调（grep 零命中）；`settings.update`、`pluginInventory.list` 等非 `list` 的 `workspace.*` 变体虽在上游文档/AGENTS.md 列为有效 wire id，但未在 `apps/web` 字面出现——它们由 `packages/client/*` 发射，超出本树边界。

---

## 完备性核对（为何"一个不漏"成立）

1. **S1 的封闭性**：`RpcMethodMap` ↔ `UNARY_ROUTES` 编译双向锁定，74 方法穷尽且双射，不存在游离的第五种一元面。
2. **额外文件逐一归位**：`approvals`/`questions`（应答载荷，S3 承载）、`jobs`（`JobView` 仅作 `session/jobs` 帧数据）、`events`（S2 两流）、`downloads`（GET 导出）、`session-search`（常量/助手，仅供 `session.search` 限额）——无一"仅服务器内部不可达"。
3. **S4 由机器标记界定**：远程方法 ⇐ `@Remote('…')` 标记；本仓库实装七命名空间已全列出，内部无标记服务明确排除并注明原因。
4. **S2 帧联合逐变体枚举**（10+10），转发事件白名单 11 项逐条列出。
5. **负面核查均已执行**：长轮询——无；产品级 `EventSource`——无（仅测试桩）；非回环鉴权层——无（信任围栏设计使然）；`/api` 之外的 HTTP 面——除上述 GET/SSE/WS 外无。

**维护提示**：本表为交叉人工核对产物，非生成器。若新增一元方法，须同步 `rpc-map.ts`+`handler.ts`（编译器会强求）；新增远程方法须补 `@Remote` 标记；新增转发事件须改 `remote-events.ts` 数组。任一变更后请回填本表以保持权威对齐。
