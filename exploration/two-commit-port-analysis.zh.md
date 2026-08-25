# dsh-force-compact 近两次提交的官方移植分析

## 提交一 `fe90cc6` ——「Port official compaction safety machinery」（5 文件 +551/−93）

### 1. 工具配对账本
- **官方来源**：`packages/compaction/compaction/src/tool-pairing.ts`——模块级 `balanceCacheBySession: WeakMap<Session, BalanceCache>`、`eventDelta`、`eventForSeq`、`extendCache`、`balanceCache`、`cutBalance`、导出 `toolPairingBalancedBefore` / `toolPairingBalancedAfter`。
- **目的地**：新建 `src/core/pairing.js`（188 行，逐函数对应移植；新增 `toolPairingBalancedBeforeSafe` / `AfterSafe` 两个安全变体）。
- **功能**：精确的工具配对平衡定义——`assistant/message` 按其内容块中 `tool-call` 的数量贡献 +N、`tool/result` −1、其余 0；表面 N 个节点有 N+1 个切点，切点平衡 ⇔ 该处未应答 tool-call 数为 0。按 session 缓存增量折算（只折新后缀），`replaceGeneration` 换代时从空面状态重折；损坏面 loud-fail（`eventForSeq` 槽位不符、无主 `tool/result` 均在变异前校验并抛错，绝不留下半成品缓存）。
- **解决的问题**：取代旧的 `user/message` 集合启发式——任何配对闭合处（step 末节点、收尾 tool result 之后……）都可下刀，选区可在比"退到下一条人类消息"更早的位置停下；防止劈裂 tool-call/result 对被送入摘要。
- **偏差**：① TS `interface BalanceCache` 转为 JSDoc `@typedef`（plain JS 无类型层）；② 新增官方没有的 `Safe*` 变体——捕获抛错并**假定平衡**（返回 `true` + `console.warn` 记 `pairing-ledger degraded`），理由是插件热路径不能被损坏面楔死，会话核自身的 replace 校验仍是最后一道网（注释明述）；③ `balanceCache` 增加 `replaceGeneration === undefined → 0` 容错（官方直接读取）。

### 2. 选区判据切换到账本
- **官方来源**：`compaction-basic/src/region.ts:98-134` `selectCompactableRange` 第二阶段吸附循环 `while (keepFromIdx > 0) { if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break; keepFromIdx -= 1 }`。
- **目的地**：`src/engine/region.js` 四个选择器——`__selectRegionBody`（尾部向头吸附改查 `toolPairingBalancedBeforeSafe`）、`__selectEarliestByMeasurementsBody` / `__selectRetainingLatestTokensBody`（end 向后吸附改查 `toolPairingBalancedAfterSafe`）、`__selectEarliestByTokensBody`（forward-walk 同理）；删除死代码 `userMessageEventSeqs`（grep 确认零调用者）；文件头注释同步改写。
- **功能**：边界对齐从"user/message 位置"（充分非必要子集）升格为官方精确判据——保留段 overshoot 显著减小（活体验证：旧规则会一路退到下一条人类消息，账本可在非人类消息的闭合切口处下刀）。
- **附加新增（非官方逐字）**：`__selectRetainingLatestTokensBody` 新增 `boundaryKind ∈ {'pairing'|'user-message'|'crossing-fallback'}` 字段（判据：snap 未触及原始 cross 点 → `crossing-fallback`；否则按 `events[endIdx].type === 'user/message'` 二选一），供 guard.js 的 REGION-PICK 诊断行观察吸附落在哪种切点。

### 3. `validateSurfaceRegion` 双侧平衡校验
- **官方来源**：`compaction-basic/src/region.ts:315-336` `validateSurfaceRegion`（非导出私有）。
- **目的地**：`region.js` 导出 `validateSurfaceRegion`（`guardFn` crash-net 包裹的 throwing 版，官方四条错误字符串逐字保留：`compactRegion: start seq ${start} not found in surface` / `end seq …` / `start seq … (position X) is after end seq … (position Y) on the surface` / 两侧各一条 `is not a balanced boundary (would split …)`）+ `validateSurfaceRegionSafe`（catch → `null` 的安全壳，注释声明对应官方把拒绝归一为 `SurfaceChangedError` 的路由方式）。
- **功能**：花钱摘要前先验界：界点必须是当前表面的合法节点、索引不倒置、且**双侧**各自坐在平衡切点上；不平衡候选在此被 fail-loud 拒掉并记日志。
- **偏差**：① 官方返回 `{start, end, startIdx, endIdx, shadowedSeqs}`，我们相同；② 官方内部用 throwing 谓词直调，我们用 `Safe*` 变体——损坏面降级为"假定平衡"（见上）；③ 官方 `endIdx` 用 `indexOf(end)`，我们用 `lastIndexOf(end)`（防御重复 seq 语义偏保守一侧）。

### 4. busy-lock 入口态
- **官方来源**：`region.ts:286-312` `assertCompactionInactive`（官方抛 `ManualCompactionError('busy', "${stage}: compaction already in progress; the session compaction lock is already active")`）+ `assertNoActiveCompaction`；`inspectCompactionEntryState`（反向单次扫描收集 `openTurn` / `unmatchedCompactionStart` / `latestEndSeedSeq`，三项齐备即停）。
- **目的地**：`src/engine/builtin.js`——`inspectCompactionEntryState(events)`（同结构反向扫描，早停条件 `openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined`）、`assertNoActiveCompaction(session, stage)`（返回**可读 note 字符串或 `null`** 的非抛错版，busy 文案与官方逐字一致：`${stage}: compaction already in progress; the session compaction lock is already active`）、原 `hasOpenFctLock` 降为薄兼容壳 `assertNoActiveCompaction(...) !== null`；`runTransaction` 入口处（追加 `compaction/start` 之前）接入，命中则 `info(ctx, …SKIPPED (${busyNote}))` 并 `return null`。
- **功能**：堵住此前"双括号"竞态——未配对的 `compaction/start` 意味着有在途事务（典型为崩溃前任开了括号没关），嵌套第二个括号会违反官方 `invariant.ts` 的单在途事务契约（其逐字校验：start/summary/end 共享 `compactionId`、无错 `end` 紧跟 `summary` 等，见 `invariant.ts:52/70/180/207/211`）。
- **孤儿规则（官方语义逐字保留）**：`latestEndSeedSeq > unmatchedCompactionStart.seq` ⇒ 该 start 属于更早生命周期的 constructor 继承残留（resume 重载重播种后幸存的旧标记），**忽略**之，不得楔死后续压缩。

### 5. 摘要输入的 `tools` 前缀恢复
- **官方来源**：`compaction-basic/src/summarizer.ts` `summarizeWithLlm` 的 prefix-cache 对齐——把会话最新请求头的 `system` 提示词与 `tools` 模式原样传入辅助调用，使其成为上次路由请求的真前缀、复用 provider 热 KV 缓存。
- **目的地**：`builtin.js` 摘要 `input` 构造（撤销此前的二分法临时注释切换，恢复 `...(prefix.tools !== undefined ? { tools: prefix.tools } : {})`；diff 注释记录了结论：先前怀疑 `tools` 引发 provider `reading 'kind'` 崩溃，后经活体验证证实该崩溃源于 vendor 侧重放路径、与本字段无关）。
- **功能**：摘要调用命中 KV 缓存而非每次冷启动；同时加载标记升级为 `v2026-08-25-official-parity`（列出本次五项对齐），替换旧的 `crash-harness` 标记。

### 6. guard.js 两道新门 + 诊断增强
- **官方来源**：`region.ts:339-357` `prepareCompaction` 的一致性复查（meter 快照选定区间必须与 `shadowedSeqs` 逐位对齐，否则抛 `SurfaceChangedError`）及其上游 `selectCompactableRange:107-110` 的全面比对（长度 + 逐位 seq，不等抛 `compaction: token-meter surface does not match the current session surface`）。
- **目的地**：`hooks/guard.js` `__compactRetainingLatestBody`：选区完成后、花钱之前插入 (a) surface 一致性交叉校验（`measurement.nodes` 与 `session.surface.nodes` 长度 + 逐位 seq 比对，失配则记 `REFUSING this compaction attempt…retrying on the next step` 并 `return false`）；(b) `validateSurfaceRegionSafe` 双平衡门（`null` → 记 `FAILED the official surface/balance validation` 并跳过，会话核 replace 校验兜底）；(c) REGION-PICK 行新增 `boundaryKind=${region.boundaryKind ?? 'unknown'}`。
- **功能**：并发修改若在 measure 与选区之间落了新节点，本次尝试整体放弃（下一步新鲜快照重试），绝不摘要错误字节。
- **已知缺陷**：(a) 门的比较表达式 `pricedNodes.some((seq, index) => seq !== surfaceNodes[index]?.seq)` 把 `measurement.nodes` 的对象元素误作裸 seq 与 `session.surface.nodes`（裸 seq 数组）比较——对象恒不等于数字，导致**每次都拒**，压缩永久停摆（活体日志指纹："priced=N vs current=N" 仍 REFUSING）。由下一提交修复。

## 提交二 `15886e5` ——「Fix surface-consistency cross-check false positive」(+13/−2)

- **来源/目的地**：同一机制（官方 `region.ts:107-110` 全表面比对思想），仅修 `hooks/guard.js` 一处比较表达式。
- **功能与根因**：`measurement.nodes` 的元素是 `{seq, tokens}` 计价对象，`session.surface.nodes` 是裸 seq 数组；旧式写法 `pricedNodes.some((seq, index) => seq !== surfaceNodes[index]?.seq)` 中的第一个回调参数是**对象本身**，与数字 `seq` 比较永远为真 → 等长表面也被判失配、压缩永不进行。修正为按提取后的 seq 对称比较，并对畸形元素 fail-closed：

```js
const misaligned = pricedNodes.length !== surfaceNodes.length
  || pricedNodes.some((node, index) => node === null || typeof node !== 'object'
    || typeof node.seq !== 'number' || node.seq !== surfaceNodes[index])
if (pricedNodes !== null && misaligned) { /* REFUSING … 日志与原先一致 */ }
```

- **偏差说明**：官方源码（`selectCompactableRange`）的两边恰是"裸 seq vs 对象"的镜像关系（`surfaceNodes.some((seq, i) => seq !== pricedNodes[i]?.seq)`），我们的方向相反（对象在前）——这正是上一提交抄反了形状的方向；修复后两侧都取 `.seq` 数值比较，官方"拒绝陈旧跨度"语义保持不变，另增对 `node` 非对象 / `seq` 非数字的防御分支（超出官方信任级别，plain-JS 插件热路径惯例）。
- **活体证据**：修复后 3180 全新实例（PID 17044，无陈旧源）上会话 `e6f6b64f` 完成首次真实压缩——`REGION-PICK … boundaryKind=crossing-fallback retainedTokens=11155` → `builtin compaction OK — replaced span seq[7..798] (39 nodes, ~9184 tokens)`；重启后 gate-fire 2 次、假 REFUSAL 0 次。
