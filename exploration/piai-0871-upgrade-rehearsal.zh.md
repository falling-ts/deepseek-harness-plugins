# pi-ai 0.85.1 → 0.87.1 升级彩排（隔离 worktree，实测）

**结论：技术上能做，而且补丁/子路径/引擎都不挡路；但这不是"改个版本号"，是一次真正的仓库级改动
（9 处产物、4 处编译期 drift、2 处类型收紧、33 个测试要迁移），而且"上游化"这一步在本工作区做不到
——子模块上游是 `deepseek-ai/deepseek-harness`，根 `AGENTS.md` 明令不得向其推送。**

彩排环境：`git worktree add --detach $env:TEMP\dsh-piai-0871 HEAD`（与活体 checkout 共享对象，
互不影响），改完即弃。脚本：`exploration/rehearse-piai-0871.ps1` + `rehearse-piai-0871-bump.mjs`，
约 1.5 分钟可复现。活体 checkout 复核：`git status` 0 行、tracked 13244、HEAD `00102833df`、
pi-ai 仍链 0.85.1、opencode-go 仍 27 个模型。

## 实测结果

| 步骤 | 结果 |
|------|------|
| `pnpm install --no-frozen-lockfile` | **exit 0**，72 秒；解析到 `pi-ai@0.87.1` |
| 补丁重命名后是否生效 | **生效**：`openai-completions` 3→2、`anthropic-messages` 3→2、`pi-messages` 2→1 处 `parseStreamingJson`（每个文件恰好少一次） |
| `git apply --check` 0.85.1 补丁打 0.87.1 | **exit 0**，全部 hunk 带偏移成功（-16 ~ +7 行） |
| 导入子路径 | `providers/all`、`api/*.lazy`、`api/*`、`utils/*` 全在；`engines.node >=22.19.0` 与 harness 一致 |
| `tsc -b packages/llm/llm-pi-ai` | **exit 2**，6 条错误（见下） |
| `vitest run packages/llm/llm-pi-ai` | **exit 1**：Test Files 5 failed / 9 passed；Tests **33 failed / 303 passed**，其中 **31 条直接由 `deepseek-v4-flash` 改名引起** |

## 编译期 drift（harness 故意设计的 fail-loud）

`catalog.ts` 的 compat gate 用 `as const satisfies Record<keyof XCompat, CompatDisposition>`：
上游加字段 → 缺键报错；上游删字段 → 多余键报错。0.87.1 实测报出：

```
catalog.ts(256,3)  'deferredToolsMode' does not exist in 'OpenAICompletionsCompat'
catalog.ts(271,12) Property 'supportsMidConvoSystemMessages' is missing in 'OpenAIResponsesCompat'
catalog.ts(283,3)  'supportsToolReferences' does not exist in 'AnthropicMessagesCompat'
catalog.ts(311,7)  Property '"mistral-conversations"' is missing in 'ApiWithCompat'
replay.ts(164,9)   'Record<string, unknown>' is not assignable to 'JsonObject'
replay.ts(193,9)   ToolCall.arguments 同上（exactOptionalPropertyTypes: true）
```

字段级差异（`exploration/piai-type-drift.mjs`）：

- `OpenAICompletionsCompat`：−`deferredToolsMode`；+`supportsMidConvoSystemMessages`、`supportsMidConvoToolAdditions`
- `OpenAIResponsesCompat`：+`supportsMidConvoSystemMessages`
- `AnthropicMessagesCompat`：−`supportsToolReferences`；+`sessionAffinityFormat`、`supportsMidConvoSystemMessages`、`supportsMidConvoToolChanges`
- **新增协议 gate**：0.87.1 给 `mistral-conversations` 配了 compat 类型（1 个字段 `supportsMidConvoSystemMessages`），
  `COMPAT_GATES` 必须多一条目
- 好消息：`Model.input` 仍是 `("text" | "image")[]`（`MODALITY_GATE` 不动）、`ThinkingLevel`/`ModelThinkingLevel`/
  `CacheRetention`/`ThinkingLevelMap` 全部 SAME
- 分类归属清楚：新字段的 JSDoc 自己写着"由生成的模型目录按模型启用"，与既有
  `supportsMidConvoEffort`/`allowedFallbackModels` 同理 → 应归 `'withhold'`（目录拥有），不是 `'offer'`

## 33 个测试为什么红（`exploration/piai-catalog-data-drift.mjs`）

上游 0.87.1 把 `deepseek` 目录里的模型**改名并删了一个**：

```
deepseek: 3 -> 2
  + deepseek-flash
  - deepseek-v4-flash, deepseek-v4-flash-vision-exp
```

而 harness 的 pi-ai 测试几乎全部用 route `deepseek` + model `deepseek-v4-flash`
（`adapter.spec` 23 条、`catalog.spec` 3 条、`dynamic-config.spec` 3 条、`loader-composition.spec` 3 条、`egress.spec` 1 条），
于是统一以 `UNKNOWN_MODEL: pi-ai provider "deepseek" has no configured model "deepseek-v4-flash"` 失败。
**这是同一个机械迁移，不是 33 个独立 bug。**

顺带说明这次升级"顺带"改变的东西（产品可见）：opencode-go 27→30、opencode 68→73、
openrouter 366→386、amazon-bedrock 121→165、新增两个 provider 数据文件（`meta.json`、`radius.json`），
以及上面那条 `deepseek` 路由的模型 id 迁移——GUI 的 Models 页快照可能也要跟着更新。

## 要动的产物（9 处）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/llm/llm-pi-ai/package.json` | `"@earendil-works/pi-ai": "^0.85.1"` → `"^0.87.1"` |
| 2 | `pnpm-workspace.yaml` | `patchedDependencies` 键 0.85.1→0.87.1；`minimumReleaseAgeExclude` 增 `@earendil-works/pi-ai@0.87.1`、`@earendil-works/pi-telemetry@0.87.1`（**pnpm 安装时自己就写了这 2 行**，必须一起提交） |
| 3 | `patches/@earendil-works__pi-ai@0.85.1.patch` | 改名 `…@0.87.1.patch`，**内容不变**（已验证可打） |
| 4 | `…/src/catalog.ts` | 3 个 gate 增删字段 + `COMPAT_GATES` 增 `mistral-conversations` |
| 5 | `…/src/replay.ts` | 2 处 `Record<string, unknown>` → `JsonObject` |
| 6 | `…/tests/**`（含 fixtures） | `deepseek-v4-flash` → `deepseek-flash` 迁移；顺手确认 33 条全绿 |
| 7 | `pnpm-lock.yaml` | 重新解析（pi-ai + `@anthropic-ai/sdk` 0.123→0.124、`@aws-sdk/client-bedrock-runtime` 3.1048→3.1127、`@google/genai` 1.52→2.21、`http(s)-proxy-agent` 7→9、`typebox` 1.3.7→1.3.27） |
| 8 | `scripts/dependency-catalog/package-lock.json` | 仍钉 0.85.1；`verify-dependency-catalog` 会红。它按**已发布**的 dsh 包生成，故必须先发版才轮得到重新生成 |
| 9 | 文档/笔记/生成物 | `.agents/notes/…/2026-09-05-pi-ai-upgrade-compatibility.md` 的 "follows pi-ai 0.85.1" 与新增字段分类；`gen-third-party-notices`；`docs/` 相关描述 |

补丁为什么必须留：`patches/@earendil-works__pi-ai@0.85.1.patch` 删的是流式 tool-call 里逐 delta 的
`parseStreamingJson` 赋值。彩排里 `tool-argument-streaming.spec.ts` 2 条**通过**，说明该行为在 0.87.1 上仍兼容。

## 为什么"直接上游升级"做不到

- 子模块 `deepseek-harness/` 的远程是 `git@github.com:deepseek-ai/deepseek-harness.git`（branch `master`），
  根 `AGENTS.md`：**"不要绕过子模块直接向子仓库的上游（`deepseek-ai/*`）推送"**。
- 若在本地子模块提交这次升级并把根仓库 gitlink 指过去，该 commit 在上游不存在 →
  新机器 `git clone --recurse-submodules` / `git submodule update` 直接失败。
- 因此只有两条：**① 给上游提 PR**（这是"上游升级"的唯一形态）；**② 本地分叉**（工作树保持 dirty 或
  本地分支，永远不推）——那就与"根仓库变更必须提交并推送"的约定冲突，需要单独记账。

## 建议

| 目标 | 做法 | 成本 |
|------|------|------|
| 只是让 3080 立刻能看到 `deepseek-v4.1-flash` | profile 补表（`~/.dsh/profiles/web/cordis.patch.yml`，见 `opencode-go-catalog-findings.zh.md` 的方案 A/B） | 2 分钟，零风险，不动子模块 |
| 想让整个 harness（含上游）受益 | 走 PR：上面 9 处 + 33 条测试迁移 + `typecheck/lint/hygiene/coverage` | 半天量级，且必须由上游收 |

**不要在锁发布态的 checkout 里本地 `pnpm update` 收工**：lockfile 会偏离上游发布态，补丁、catalog drift gate、
`verify-dependency-catalog`/third-party notices 都还没对齐，等于把一个半成品升级留在了发布基线上。

## 复现

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File exploration\rehearse-piai-0871.ps1   # ~1.5 分钟，改完即弃
node exploration\piai-type-drift.mjs <0.85.1包目录> <0.87.1包目录>        # 类型声明级 drift
node exploration\piai-catalog-data-drift.mjs <0.85.1包目录> <0.87.1包目录> # 目录数据全量 drift
```
