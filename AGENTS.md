# AGENTS.md — deepseek-harness-plugins（根工作区）

## 仓库性质

本仓库是**工作区容器**（workspace container）：不含业务源码，只跟踪
子模块指针（gitlink）与工作区级文件。远程：`git@github.com:falling-ts/deepseek-harness-plugins.git`（branch `main`）。

## 目录结构

| 路径 | 性质 | 远程 |
|------|------|------|
| `deepseek-harness/` | 子模块（上游 monorepo：`apps/cli`、`apps/web`、`packages/*`、`examples/*`，pnpm workspace） | `git@github.com:deepseek-ai/deepseek-harness.git`（branch `master`） |
| `dsh-force-compact/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-force-compact`，plain JS 无构建步骤） | `git@github.com:falling-ts/dsh-force-compact.git`（branch `main`） |
| `docs/` | 工作区级技术文档（后端接口目录、上下文管理/会话结构分析、llama.cpp 适配方案等） | — |
| `harness-server.sh` | 跨平台（Linux + Windows Git Bash）服务器启动脚本 | — |
| `.idea/`、`*.log` | 已忽略（IDE 配置；`harness-server.sh` 运行日志） | — |

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
- 插件是**纯 Host 监听器**：不引入 timer、内存态存储或 Client UI；
  各插件自身的规则见其 `AGENTS.md`（中文）。
- 各插件 `AGENTS.md` 中的 `../AGENTS.md`（collection conventions）指向本文件。
- 插件仓库内的 `CLAUDE.md` 固定只写一行 `@AGENTS.md`（引用本插件的 AGENTS.md），
  规则内容一律维护在 AGENTS.md，避免双写。

## harness-server.sh

- 用法：`bash harness-server.sh`（Linux 或 Windows Git Bash 均可）；
  环境变量覆盖：`PORT`（默认 `3080`）、`BIND_HOST`（默认 `127.0.0.1`）、`WAIT`（默认 `10` 秒；
  未命中视为启动失败退出非零，慢机可覆写 `WAIT=<秒>`）。
- 日志写入**脚本调用时的当前目录**：`dsh-web-<PORT>.log`（故根目录忽略 `*.log`）。
- 脚本第 1 步会杀掉端口占用进程：若当前 harness 自身占用该端口，
  运行脚本会导致承载本 GUI 的 harness 重启。
- `echo Y |` 前缀是修复 pnpm 交互式重装提示（`Proceed? (Y/n)`）：
  后台进程无 stdin 时会永久挂死在该提示上。

## harness-server-dev.sh（隔离第二实例 / 开发端口 3180）

- 用法：`bash harness-server-dev.sh`；`DEV_PORT`（默认取 `${DEV_PORT:-${PORT:-3180}}`）。
- 作用：在**独立的第二个实例**上起 `dsh web`，专用于在不打断主 GUI（3080）的前提下验证
  新插件源。它**永不触碰 3080**；仅杀 3180 上的占用者后 `nohup` 后台启动，
  日志追加到 `./dsh-web-dev-${DEV_PORT}.log`，`DSH_HOME=$USERPROFILE/.dsh`。
- **授权**：3180 是完全的开发端口，可在任意时刻随意重启 / 停掉（脚本自带"先杀该端口再启动"）。
- **边界**：承载本 GUI 的主实例在 **3080**（见上节警告），切勿对其套用上述随意重启；
  重启 3080 属于用户决定。

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

## 会话级授权：全程放权 + 默认推荐 + 3180 随手重启（本工作区约定，长期生效）

- 用户在**本工作区**授予：开发过程中**无需逐步请示**，直接推进；遇到多选一
  **默认采用推荐方案**并在结果中标注所选为何；仅在不可逆 / 破坏性动作
  （如推送、删除、改用户主目录数据）前才简短说明。
- **3180 为开发专用端口**：可随时 `bash harness-server-dev.sh` 重启或停掉（脚本 `DEV_PORT` 可覆盖默认 3180），
  不必事先询问（见上节"授权"）。3080 为主 GUI 所在端口，不适用此随意重启。
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
