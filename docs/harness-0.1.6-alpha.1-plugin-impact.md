# harness 0.1.6-alpha.1 对三个自有插件的影响（2026-09-17）

本文记录一次上游同步的完整影响评审：从基线快进 666 个提交，逐缝核对
`dsh-force-compact` / `dsh-web-ding` / `dsh-local-no-auth` 依赖的上游契约，并记录
本轮所做的调整与其实证依据。

## 1. 落点与规模

| 项 | 值 |
|---|---|
| 旧基线 | `c291e7961a` = `dsh-v0.1.5-rc.2` + 139 提交 |
| 新落点 | `0d1f50007f` = `dsh-v0.1.6-alpha.1` + 5 提交（master 尖端） |
| 区间规模 | 666 提交 / 3123 文件 / +766 077 −39 884 行 |
| 新 tag | `dsh-v0.1.6-alpha.1`（2026-09-15）；master 的 root `package.json` 版本 = `0.1.6-alpha.1` |

依赖包版本漂移（**三个插件的 peer 区间全部因此过期**）：

| 包 | 旧 | 新 |
|---|---|---|
| `@deepseek-ai/dsh-settings` | 0.1.5-rc.2 | **0.1.6-alpha.1** |
| `@deepseek-ai/dsh-client-connection` | 0.1.5-rc.2 | **0.1.6-alpha.1** |
| `@deepseek-ai/dsh-host-webserver` | 0.1.5-rc.2 | **0.1.6-alpha.1** |
| `@deepseek-ai/dsh-client-store` / `-locale` / `-ui-settings` | 0.1.5-rc.2 | **0.1.6-alpha.1** |
| `@deepseek-ai/cordis`（vendored） | 4.0.2 | 4.0.2（**未变**） |
| `@deepseek-ai/schemastery`（vendored） | 3.18.2 | 3.18.2（**未变**） |

→ 三个插件 peer 区间统一改为 `>=0.1.5-alpha.1 <=0.1.6-alpha.1`。

## 2. 判定总表

| 插件 | 判定 | 实质影响 | 本轮动作 |
|---|---|---|---|
| `dsh-force-compact` | **NEEDS-CHANGE** | 2 处本期暴露的实质缺陷（估价器移植落后、回放绕过投影缝）+ 3 处同步时发现的既有缺陷（账单口径、退化路径漏角色开销、`no-target` 楔锁） | 改码 + 版本 0.4.2→0.4.3 |
| `dsh-web-ding` | **SAFE** | 无 | 仅 peer 区间 + 版本 0.3.1→0.3.2 |
| `dsh-local-no-auth` | **NEEDS-CHANGE** | 免鉴权机制完好，但**上游摘除了 fail-loud 保证** | 自行承担 fail-loud + 文档 + 版本 0.3.1→0.3.2 |

## 3. `dsh-force-compact`

### 3.1 会话格式稳定在 V3（最重要的正面结论）

`SESSION_FORMAT_VERSION = 3` 两版一致（`packages/core/session/src/types.ts`）。上游的
session 重构笔记明确承诺磁盘字节不变：

> Stages 1–3 only rearrange code ownership. They do not change V3 Session JSONL bytes,
> `SESSION_FORMAT_VERSION`, or the user startup flow.
> — `.agents/notes/proposed/architecture/2026-09-10-session-data-compatibility.md`

本次区间的主体是**抽象与所有权重构**（`LogicalSession` / `SessionService` /
存储提供者分离），不是格式变更。本插件写入的 V3 形状事件（`compaction/*` +
带 `surfaceOp:{op:'replace',startSeq,endSeq}` 的 `user/message`）**无需改动**。

### 3.2 compaction 契约：仅增量，无破坏

`packages/compaction/compaction` 区间内 8 文件 / +28 −8：

- **新增** `compaction/summary-error` waterfall 扩展点（后端请求持久化输入恢复）——纯增量，本插件不消费。
- `checkpoint.ts` 仅 JSDoc 措辞（`provenance` → `source`）。
- `invariant.ts` 内部 `new SurfaceManager(events, undefined, ctx.sessions.messageProjections)` 多传一个投影注册表。
- `compaction-basic/src/summarizer.ts` 唯一实质改动：失败路径改抛 `LlmError`（本插件自带摘要器，不消费该类型）。
- 官方 `COMPACTION_INSTRUCTION` / `CHECKPOINT_PREAMBLE` / `<compacted-summary>` framing **未变**（本插件的逐字对齐仍成立）。

### 3.3 实质缺陷 1：影子价格估价器移植落后于官方

**上游新行为**（`packages/llm/token-meter/src/estimate.ts`，配合本次新增的
`packages/compaction/compaction-image-offload`）：

```ts
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
}
```

image 块现在**先剥离 `offloaded` 标记再计价**（每个已离线图像约差 5 tokens）。

**为什么命中本插件**：`src/engine/builtin.js` 逐字移植了这套估价数学来写
`shadowedTokenCount` 影子价格索赔，而索赔必须与折叠器对同一区间的估价**逐位相等**
（否则结算出错误 delta，计数器漂移）。移植里 image 块落在 `default` 臂，**带着
`offloaded` 一起计价**。

**修复**：`estimateContentBlocks` 增加显式 `image` 臂，镜像官方的剥离语义。

### 3.4 实质缺陷 2：回放绕过 `@messageProjection` 强制投影缝

`image/offload`（新包）是 **`@messageProjection` 事件**：它只记录"哪些图像occurrence
被丢弃"，`offloaded: true` 标记**只存在于投影输出里，不在存储事件里**；而把标记替换成
占位文本由**适配器在请求序列化时**完成（`llm-deepseek/src/protocols/.../serialize.ts`
调 `projectOffloadedImages`）。

本插件的 `projectRegion` 直接读存储事件 (`event.data`) 折叠回放消息 → 消息里**没有标记**
→ 适配器不会替换 → **用户已离线的图像会被真的发给摘要模型**（浪费 token；在路由图像
预算吃紧时可触发 `IMAGE_OFFLOAD_REQUIRED_CODE` 报错 → 摘要失败 → 压缩失败）。

**修复**：`projectRegion` 改为优先经官方投影缝取消息——

```js
const projected = projectedMessageFor(session, event)   // session.surface.deriveEventMessage(event)
```

三值语义（关键设计）：对象 = 采用；`null` = 缝明确回答"该事件不产出消息"（空内容
assistant usage 宿主）→ 尊重；`undefined` = 缝不可用（老会话核 / 抛错）→ 回退原始
payload。缝缺失时行为与修复前逐位一致。

### 3.5 附带语义修正：空内容 assistant 不得进入回放

上游对 `content.length === 0` 的 `assistant/message` 返回 `null`（"must not inject a
content-less assistant turn into the provider transcript"）。本插件原判定 `if (content)`
—— `[]` 在 JS 里是**真值** —— 会把 usage 宿主节点当成一条空 assistant 回合发出去。
现按上游同一规则跳过（两条路径一致，含无投影缝的回退路径）。

### 3.6 同步时另发现的三处既有缺陷（非本次回归，但一并修复）

逐缝核对时暴露的三处旧账。第一处尤其重要——它可能就是历史上"压缩后计数器不降反升"
那一族症状**未被根治**的原因。

**(a) 影子价账单取错了字段。** 官方折叠器（`token-meter/src/surface-fold.ts`
`planSurfaceTokens`）结算一次 replace 用的是：

```ts
const node = analyzeNode(event.seq, deriveEventMessage(event))
const removed = nodes.slice(startIdx, endIdx + 1)
  .reduce((total, c) => total + c.heuristicTokens, 0)   // ← 启发价
return { tokens: node.heuristicTokens, deltaTokens: tokens - removed }
```

而官方 `prepareCompaction` 的索赔同样是
`shadowedTokenCount = Σ node.heuristicTokens`，**路由价 `node.tokens` 走的是另一个字段
`shadowedRouteTokenCount`**（`token-meter/src/types.ts` 明文："The shadow-price protocol
prices replacements with this value"）。本插件的移植累加的是 `node.tokens` → 凡路由价高于
固定启发价的会话（图片、文件——请求价归路由所有）都**少报账单** → `delta` 偏正 →
计数器少扣。现改为 `heuristicTokens`（仅在该字段缺失的更老快照上回退 `tokens`）。

**(b) 退化路径漏角色开销。** `priceSurfaceNode`（快照不可用时的逐节点回退）只给
`tool/result` 加 `ROLE_OVERHEAD`，user/assistant 漏加 4 tokens/条。官方逐节点价是
`estimateMessage(deriveEventMessage(event))`，**非 system 一律加角色开销**。同时该路径
此前不认识 `system/message`，并把空内容 assistant（usage 宿主）当成一条 4-token 消息
（`if (content)` 对空数组 `[]` 为真）。现完整镜像官方 `deriveEventMessage` 的无投影分支。

**(c) `no-target` 路径会楔死会话。** `builtin.js` 在"摘要调用从未发出"（无 target / 无
`llm`）时用 `compaction/end { note }` 收尾。官方不变量（`compaction/src/invariant.ts`）
规定 `event.data.error === undefined && !open.summarized` 时 `fail(...)` 抛错——`note`
既不是 `error` 也没有前置 summary，于是该 append 抛错、被本行的 `try/catch` 吞掉，
**留下一条永不闭合的 `compaction/start`**，此后该会话的所有压缩都被
`assertNoActiveCompaction` 拒绝，直到进程重启。现改为 `error: why`。

三处均以差分探针锁死（见 §8）。

### 3.7 弃用通告：同步读会话事件（已记录，本轮不重构）

`Session.eventAt()` / `snapshotEvents()` / `ownEvents()` 于 **2026-09-09 标记
`@deprecated`**，新调用被禁止
（`.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`）。
上游明确允许既有代码延后迁移（其自身源码里同样有 `no-deprecated` 豁免注释），且当前
实现仍完整保留内存事件序列。本插件的 `src/core/session-events.js` 依赖其中两个。

**本轮判定**：**不重构**（弃用 ≠ 破坏，且迁到投影/分页读是一次大改）；已在插件
`AGENTS.md` 记录迁移方向（`session.surface` + 投影）。这是本插件下一次上游同步的
首要技术债。

## 4. `dsh-local-no-auth`

### 4.1 接管的缝逐字节未变（机制完好）

`packages/client/connection/src/rpc-host.ts` 的三个方法
（`requestRejection` / `authorizeIndex` / `authenticatedUrl`）、四个调用点
（`/api` 路由、frontend-static 兜底席位、API 网关、web-app URL 公告）、
`packages/host/webserver/src/*`、`frontend-static` 在区间内**逐字节相同**；
`packages/ssh`（+6985 行）对鉴权链零引用。⇒ 免鉴权本身**仍然生效**。

### 4.2 破坏点：启动严格语义反转，fail-loud 承诺失效

上游 `bd4cfc7c46 feat(boot): distinguish required startup failures` 把
`assertEntriesActivated`（任何启用但未激活的 entry 都致命）换成
`auditStartupEntries`（只对**私有**必需 id 清单致命：
`agent-loop` / `webserver` / `modules` / `connection` / `headless-runner` / `acp` /
`sdk-jsonrpc-server`）。

本插件 entry 不在表内且**无受支持方式加入**，于是：`apply` 抛错不再中止启动，
`dsh web` 照常服务、鉴权完好，只留一条通用 `warning: N entry did not activate`。
⇒ 用户可能以为免鉴权已生效，实际没装上（可用性/契约退化，非安全漏洞；`0.0.0.0`
情形结果仍安全）。

### 4.3 修复：自行承担 fail-loud

四处拒载点统一走新的 `refuseStart(ctx, reason)`，做三件事：

1. 向 **stderr** 写含原因的 `refusing to start — …`，并明示"免鉴权未生效，实例仍需 token/cookie"；
2. 调 `ctx.get('appExit')(1)` 请求非零退出（启动器在树挂载前提供，见
   `packages/boot/cmdline`；`apps/cli/src/profile-boot.ts` 明确处理"退出请求在 setup
   进行中落地"这一情形）；
3. 保留**抛错**——对更老 harness 仍然致命。

`appExit` 缺失 / 服务存储抛错 / `appExit` 自身抛错三种降级都**不掩盖拒载**。
文档（`README.md` / `README.cn.md` / `AGENTS.md`）已同步为"拒载 + 服务照常启动 + 免鉴权未安装"的真实语义。

## 5. `dsh-web-ding`：SAFE

其依赖的 5 个关键包 `src/` 在区间内**一个字节未动**
（`settings/settings`、`client/ui-settings`、`client/store`、`client/ui-slots`、
`client/web/src/platform.ts`），`vendor/schemastery` 完全未触及；
`agent/status` 事件与 scope 过滤投递未变；client module 装载契约
（`window.__ModuleLoader__.load`、`exports["./client"]`、`dsh.client.platform`、
`settings.section` + thunk label + `hooks` → `useDing`）全部未变；
DOM 锚点 `[data-question-key]` 的生产者 blob 逐字节相同。**无需改码。**

## 6. 上游其它值得知道的变化（与本插件无关但影响工作区）

- **非事务 Loader 回归**：`vendor/loader` 的 `Entry.update` 重写回急进实现（删除
  `updateError` / `replaceKeys` / `_disposing` / `enqueue`）。后果：**插件激活失败
  不再回滚旧插件/旧配置**，可能留下"部分应用的树"。
- **新增包**：`compaction-image-offload`（离线图像）、`ssh`（+6985）、
  `subprocess`（+1728）。
- **删除事件**：`agent/session-start`（`agent/created` 改为 serial 且 payload 增字段）。
- **typert 生成物需要重建**：`e459e32637 perf(typert): materialize generated schemas
  on first use` 之后，各包 `lib/typert.host.js` 必须由新源码重新生成；**拉取后不重建
  会让 `dsh web` 启动报 `parameter/result codec has no create() factory`**（详见 §7）。
- **新增依赖未随 `git pull` 安装**：`packages/ssh` 需要 `zod`、`website` 需要 `vue` /
  `@panzoom/panzoom`——纯 `pnpm install` 之外不做事会导致 `build` 在这些包上失败。

## 7. 环境后果：拉取后必须重装 + **完整**重建

本次同步暴露的工作区运维事实（**下次拉取后照做**）：

1. `pnpm install`（新包依赖；pnpm 11 的 `verify-deps-before-run` 不足以保证）；
2. **`pnpm run build`（完整构建，两个面都要）**；
3. 再启动 `dsh web`。

**为什么必须是完整 build 而不是 `build:lib:host`**（2026-09-17 实测踩到）：
本区间新增了两个**客户端包**（`@deepseek-ai/dsh-client-ui-sidebar-terminal`、
`@deepseek-ai/dsh-client-ui-settings-unarchive-sessions`）。只跑 host 面时它们的
`lib/client.js` 不会产出，启动会以**必需 entry 失败**终止（退出码 1）：

```
Error: dsh: plugin tree failed to load: required startup failure: 1 entry did not activate
modules (@deepseek-ai/dsh-client-modules): client bundles not found;
  run `pnpm run build` before launch:
    - @deepseek-ai/dsh-client-ui-sidebar-terminal
    - @deepseek-ai/dsh-client-ui-settings-unarchive-sessions
```

同理，**产物过期**（拉取后不重建）会让 `lib/typert.*.js` 停留在旧契约上，
报 `typert-loader: <pkg> … codec has no create() factory` 并最终退出——
两者都是**生成物问题，不是插件缺陷**。

> 判别要点：插件自身的加载标记（`[force-compact] debug logging enabled`、
> `[dsh-local-no-auth] active: …`）在**启动早期**就会写出，因此"标记出现"不等于
> "服务可用"。要判定实例真的活着，必须看端口是否持续监听 / 能否应答 wire 请求。

## 8. 本轮验证（可复跑）

| 探针 | 覆盖 | 结果 |
|---|---|---|
| `exploration/fc-shadow-price-parity-probe.mjs` | 与官方 `planSurfaceTokens` / `estimateMessage` **逐例对拍**：消息级估价 8 例、逐节点价 7 例 + 4 项回归、投影感知 5 项、`nodeHeuristicPrice` 5 项、整区间账单 7 项（快照路径 / 旧快照回退 / 快照不完整 / 日志退化 / 子区间 / 非法界） | **37/37 PASS** |
| `exploration/fc-estimate-parity-probe.mjs` | Part A：**直接加载官方 `estimate.ts`**（Node 22 原生类型擦除）与插件移植逐例对拍 13 组 + 4 组回归；Part B：`projectRegion` 投影缝 5 种场景 16 项 | **33/33 PASS** |
| `exploration/lna-refusestart-probe.mjs` | 四种拒载触发点、正常路径与 dispose 还原、三种降级（无 `appExit` / `ctx.get` 抛错 / `appExit` 抛错） | **28/28 PASS** |
| `exploration/fc-timeout-guard-probe.mjs` | 上一轮的摘要超时守卫（回归） | ALL PASSED |
| `exploration/fc-badge-i18n-parity-probe.mjs` | 徽标双语词典逐元素一致（回归） | 20/20 一致 |
| `dsh-force-compact/verify-region-order.mjs` | 选区乱序容错（回归） | 7 组断言通过 |

另有活体证据：重建后的 3180 实例在新 harness 上启动成功（dev 日志零 typert 报错），
`[force-compact] debug logging enabled` 与 `[dsh-local-no-auth] active: …` 均正常写出。

## 9. 遗留与未决

- **弃用读的迁移**（§3.6）：`session.surface` + 投影替代同步读，是本插件首要技术债。
- **`dsh.client.inject` 冗余项**：`@deepseek-ai/dsh-client-store` 已被上游列为隐式
  baseline external；`inject` 目前纯信息性，不构成缺陷，但若上游收紧该校验，这是
  首个会被点名的行（`dsh-web-ding` / `dsh-force-compact` 各一处）。
- **`appExit` 的进程级时序**：已由源码证据（`profile-boot.ts` 对"退出请求在 setup
  期间落地"的显式处理）与单元级探针支撑，尚未做"真让 3180 拒载并观察退出码"的
  进程级实测。
- **live patch reload 与实例替换的交互**：`connection` entry 若重载而插件 entry 未重启，
  补丁会留在旧实例上（既有形状，非本次回归）。
