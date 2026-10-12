---
name: dsh-s-backend-api
description: Use when driving the harness over HTTP (no GUI automation), auditing client-reachable endpoints, or debugging 404/415/gateway errors. Covers the four physical channels, the S1 dot vs S4 slash RPC split, the 0.1.3 wire-envelope change, and the minimal create-session-then-prompt sequence.
---

# 后端接口全景与 wire 协议驱动（免 GUI 自动化）

权威来源与各方法详细签名字段见 [docs/backend-api-catalogue.zh.md](../../docs/backend-api-catalogue.zh.md)（跨源核对总表）；本节为浓缩。

## 0.1.3 传输漂移（重要）

旧 `packages/host/apiproxy` 的**句点**形态 `/api/<ns>.<method>` 与 `RpcMethodMap` 路由表属于 0.1.3 已删的旧层。0.1.3 起一元 RPC 改走 `client/connection` + typert gateway，wire 路径为**斜杠** `/api/<ns>/<method>`、信封 `payload:{args:{...}}`，方法清单以各 `packages/api/*/src` 的 `@Remote('<name>')` 为准。句点形态与 `RpcMethodMap` 不再成立。

## 四类物理通道

| 面 | 通道 / 形式 | 规模 |
|----|-------------|------|
| S1 一元 RPC | `POST /api/<ns>.<method>`（**句点**分隔），信封 `{"type":"client-request","rpcId","method","payload"}` | **74 个方法**（`RpcMethodMap` 编译期锁定路由表，0.1.3 前） |
| S2 流式下行 | `GET /api/events.mux`、`/api/events.host`（裸 GET=SSE；浏览器强制 WS 升级，否则 426） | 2 条流 + `MuxFrame`(10 变体) + `HostFrame`(10 变体) |
| S3 应答回调 | `POST /api/respond`（`client-response`，**回显**发起方 rpcId，不重铸） | 承载审批 / 问答应答 |
| S4 网关命名空间 | `POST /api/<ns>/<method>`（**斜杠**分隔段，经 Typert 网关派发） | **7 个命名空间 ≈ 25 个 `@Remote` 方法** |
| 下载 | `GET /api/session.export`（无信封，宿主独占，不进浏览器 IApiClient） | ZIP 导出 |

> 易混淆点：S1 用**句点**、S4 用**斜杠**；两者同 `/api` 前缀但派发机制不同。`method` 字段必须与 URL 末段逐字一致（句点面写斜杠会被 `bad-request` 拒绝）。

## S4 — 7 个网关命名空间（`@Remote` 标记的方法，斜杠形态）

| wire 命名空间 | 拥有包 | 远程方法 |
|---------------|--------|----------|
| `commands` | `packages/interaction/commands` | list, execute |
| `goals` | `packages/goal/goal` | create, edit, pause, resume, complete, clear |
| `dynamicCordisRunner` | `packages/extensions/cordis-host-runner` | runHostHalf, getClientCode, resolveRequestRun, settleUserRun, stopFromPanel, syncInspectManifest, resolveInspectQuery, inventory, reportRenderFailure, reportClientGuardFailure, invoke, undefinedFromPanel |
| `fileReferences` | `packages/context/file-reference` | list |
| `sessionReferenceResolver` | `packages/context/session-reference` | candidates |
| `pluginInventory` | `packages/host/plugin-inventory` | list |
| `messageFeedback` | `packages/feedback/message-feedback` | list, put, delete |

> 前端实测唯一出现的斜杠族就是 `messageFeedback/{list,put,delete}`。`goals` 同时存在句点形态（S1 的 `goal.*`）与斜杠远程形态（S4），入口不同，勿混。

## S3 — 应答（非独立 RPC，走 S2 流下发的 server-request 帧）

`approval/requested` → 答 `ApprovalResponsePayload`（outcome: allowed-once/rejected）；`question/requested` → 答 `QuestionResponsePayload`。均以 `POST /api/respond` + 回显 rpcId 回应。

## 11 个可转发宿主事件白名单（`API_REMOTE_FORWARDED_EVENTS`）

`agent-preset/selected` `commands/change` `credentials/reference-updated` `cordis/request-run` `cordis/request-run-resolved` `cordis/dynamic-package` `cordis/dynamic-retract` `cordis/inspect-query` `cordis/inspect-query-resolved` `llm/adapters-updated` `settings/document-updated`。新增一条 = 在 `packages/api/remotes/src/remote-events.ts` 该数组加一行，别无他处。

## 状态码 / 安全

- 未知路径 **404**；body 非 JSON **400**；非 JSON media（POST）**415**；>300 MiB **413**；崩溃 **500**；未受信 **403**；浏览器裸 GET 事件流 **426**。业务错误永远 200（错误在 `result.{ok:false,error}`）。
- **无鉴权令牌**，靠信任围栏（Host 回环/受信主机 + sec-fetch-site + Origin==Host）。一批**特权方法仅回环可达**（`settings.*`、`credentials.*`、`llm.discoverModels`、`agentPreset.read/copy/openDocument/remove`、`host.pickDirectory/openPath`）；`llm.providers`/`models` **不在**其中。

## 通过 wire 协议驱动一次对话（免 GUI 自动化）

- **URL 形态**：`POST http://127.0.0.1:<port>/api/<namespace>/<method>`——namespace 与方法之间是**斜杠**（如 `/api/pluginInventory/list`、`/api/session/create`）。**0.1.3 起为斜杠**：旧 apiproxy 句点形态已删，现在用句点 / 裸 `/api` 一律 **404**。
- **请求体信封**：`{"type":"client-request","rpcId":"<uuid>","method":"<ns>/<method>","payload":{"args":{...}}}`，`Content-Type: application/json`。`method` 与 URL 路径段同为**斜杠**；`payload` 必须包一层 `{"args":{...}}`（gateway 要求 "exactly one plain-object args field"）；`args` 内**键名 = `@Remote` 方法的形参名**。
- **响应**：`{"type":"server-response","rpcId":"...","result":{"ok":true,"value":{...}}}`。
- **权威方法清单**：各 `packages/api/*/src` 里的 `@Remote('<name>')` 装饰器——wire 路径 = `<ns>/<name>`（`<ns>` 为 camelCase 命名空间，`<name>` 即装饰器参数）。常用：`session/create`、`session/prompt`、`session/list`、`session/history`、`pluginInventory/list`、`settings/describe`、`settings/update`、`workspace/list`。
- **创建会话并发一句话（最小可复现序列）**：
  1. `POST /api/session/create`，`payload:{"args":{"request":{}}}`（`request` 形参，字段全可省）→ 返回 `value.sessionId`。
  2. `POST /api/session/prompt`，`payload:{"args":{"request":{"requestId":"<uuid>","sessionId":"<上一步 id>","mode":"queue","content":[{"type":"text","text":"…"}]}}}`（`requestId` 为客户端铸的 uuid，必填）→ 返回 `value.accepted:true`，回合异步执行。
  冒烟连通性用 `session/list`：`payload:{"args":{"_request":{}}}`（`list` 的形参名是 `_request`）。
- **排障要点**：URL/`method` 用句点或裸 `/api` → **404**；`payload` 缺 `args` 包层 → `gateway/internal`（"…exactly one plain-object args field"）；`args` 字段不符 descriptor → `gateway/arguments-invalid`（typert 点名缺哪个字段）。
- 传输细节载体：`@deepseek-ai/dsh-client-connection/src/{client/rpc.ts, api-path.ts, rpc-schema.ts}`；网关宿主侧契约 `handler('<ns>/<method>', { args }, signal)`（`packages/api/gateway/tests/gateway.host.spec.ts`）。

## 探测 / 驱动脚本集中在 `exploration/`

早期探测与 wire 驱动脚本现已集中在 `exploration/`（`.cjs`/`.mjs` 探针，不属于任何插件源码）。典型用法：`node exploration/fcprobe8080.cjs`、`node exploration/fcdrivestatus.cjs 3080 smoke anchor`。引用这些脚本的文档一律指向 `exploration/` 下新路径。个别文件名带历史后缀，保留原名以便对照既有笔记，勿据此推断功能。

## 相关技能

- `dsh-s-server-run`：起 web 实例、端口与 home 约定。
- `dsh-s-computer-use`：`pluginInventory/list` 的 args 写法与字段名。
