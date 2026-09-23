# pi-ai 0.85.1 → 0.87.1 已落地（live checkout，未提交未推送）

按授权执行：允许对 harness 代码做轻微依赖适配，目标是**真的装上 0.87.1**，不推送上游，改动保留在工作区。
执行结果：**装上了、编过了、测过了、补丁生效、生成物与文档同步**；harness 子模块与根仓库均**保持 dirty、未 add、未 commit、未 push**。

## 落盘目标达成

```
packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai  →  0.87.1（链接自 .pnpm/@earendil-works+pi-ai@0.87._ecef9fb4…）

opencode-go: 30 个模型，含 deepseek-v4.1-flash ✅（0.85.1 时 27 个、无此 id）
  + deepseek-v4.1-flash, grok-4.7, mimo-v2.6-flash, mimo-v2.6-pro   − omen-alpha
deepseek（pi-ai 官方路由）: 2 个 → deepseek-flash, deepseek-v4-pro
  （0.85.1 的 deepseek-v4-flash、deepseek-v4-flash-vision-exp 被上游改名/删除）
```

补丁生效实测（安装副本 vs 未打补丁 tarball，每个文件恰好少一次 `parseStreamingJson`——即补丁删掉的那行）：

| 文件 | 0.85.1 pristine | 0.87.1 打完补丁 |
|------|-----------------|-----------------|
| `dist/api/openai-completions.js` | 3 | 2 |
| `dist/api/anthropic-messages.js` | 3 | 2 |
| `dist/api/pi-messages.js` | 2 | 1 |

## 验证证据（全部在 live checkout 上跑）

| 检查 | 结果 |
|------|------|
| `pnpm install --no-frozen-lockfile` | **exit 0**，21.6s（`Packages: +37 -45`） |
| `pnpm exec tsc -b packages/llm/llm-pi-ai` | **exit 0** |
| `pnpm exec vitest run packages/llm/llm-pi-ai` | **exit 0：14/14 文件、336/336 测试通过**（升级前 33 failed） |
| `pnpm exec oxlint <两个改动源码>` | **exit 0**，0 warnings / 0 errors |
| `pnpm run gen-third-party-notices` + 其 37 项 spec | **exit 0**，字节级一致 |
| `pnpm run verify-dependency-catalog` | **exit 0**（"JSON matches the recorded npm resolution"） |
| 3080 宿主 | 仍在监听（PID 22320），RPC 正常（`pluginInventory/list` → `ok=True`） |

## harness 目录改了什么（15 个文件）

| 文件 | 改动 |
|------|------|
| `packages/llm/llm-pi-ai/package.json` | `@earendil-works/pi-ai`: `^0.85.1` → `^0.87.1` |
| `pnpm-workspace.yaml` | `patchedDependencies` 键改用 `@earendil-works/pi-ai@0.87.1`；`minimumReleaseAgeExclude` 的 pi-ai / pi-telemetry 由 0.85.1 改为 0.87.1 |
| `patches/@earendil-works__pi-ai@0.85.1.patch` → `…@0.87.1.patch` | **纯改名，内容 0 变更**（`git mv`；已验证在 0.87.1 上原样可打） |
| `packages/llm/llm-pi-ai/src/catalog.ts` | 4 处 drift gate：completions 删 `deferredToolsMode`、加 `supportsMidConvoSystemMessages`/`supportsMidConvoToolAdditions`；responses 加 `supportsMidConvoSystemMessages`；anthropic 删 `supportsToolReferences`、加 `sessionAffinityFormat`/`supportsMidConvoSystemMessages`/`supportsMidConvoToolChanges`；新增 `MISTRAL_COMPAT_GATE` 并登记 `'mistral-conversations'`（上游新给了该协议 compat 类型） |
| `packages/llm/llm-pi-ai/src/replay.ts` | `parseArguments` 返回类型 `Record<string, unknown>` → pi-ai 0.87.1 收紧后的 `JsonObject`（2 处 + import） |
| `packages/llm/llm-pi-ai/tests/adapter.spec.ts` | 32 处 `deepseek-v4-flash` → `deepseek-flash` |
| `packages/llm/llm-pi-ai/tests/loader-composition.spec.ts` | 8 处 |
| `packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts` | 5 处 |
| `packages/llm/llm-pi-ai/tests/catalog.spec.ts` | 4 处（含错误正则里回显的 id） |
| `packages/llm/llm-pi-ai/tests/egress.spec.ts` | 1 处 |
| `packages/llm/llm-pi-ai/tests/adapter.e2e.ts` | 2 处（key-gated，本地跳过，但 CI 有 key 时会跑，必须跟着改） |
| `packages/llm/llm-pi-ai/README.md`、`README.zh.md` | "Known Limitations" 里补丁路径 `…@0.87.1.patch` |
| `THIRD_PARTY_NOTICES.md` | 生成器重跑：补丁路径指向 0.87.1 |
| `pnpm-lock.yaml` | 重解析（pi-ai/pi-telemetry + 传递依赖 `@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`http(s)-proxy-agent`、`typebox` 等） |

diffstat：`15 files changed, 360 insertions(+), 413 deletions(-)`。

未改 `docs/dependency-catalog.json` 与 `scripts/dependency-catalog/package-lock.json`：它们记录的是**已发布**
`@deepseek-ai/dsh@latest` 在 npm 上的真实解析结果（仍为 0.85.1），只有发新版本后 `gen-dependency-catalog --refresh`
才轮得到更新；当前 `verify-dependency-catalog` 依然通过，属预期状态而非遗漏。

## 生效边界（重要）

- **3080 进程仍持 0.85.1 的内存目录**：pi-ai 在 `llm-pi-ai` 模块加载时被 import，正在跑的宿主不会重读
  `node_modules`。走廊由 `llm-pi-ai` 提供时，要让 v4.1-flash 出现在模型列表里需要**重启 3080**——
  重启主 GUI 属你的决定，我未执行（本次只改了文件系统与依赖，宿主全程在线）。
- 未跑：全仓 `pnpm run typecheck` / `lint` / `test:coverage` / `test:e2e`（无 `DEEPSEEK_API_KEY`）、`pnpm run build`。
  按仓库测试政策，证据按改动面匹配：本改动只涉及 `llm-pi-ai`（全仓唯一 pi-ai 消费者），已跑其定向
  typecheck + 全部 336 项测试 + lint + 两个生成物门。

## 复现

```powershell
# 本次实际执行的适配脚本（对 harness 根目录）
node exploration\migrate-piai-test-model-ids.mjs D:\deepseek-harness-plugins\deepseek-harness
# 升级前的隔离彩排（改完即弃，不碰活体）
powershell -NoProfile -ExecutionPolicy Bypass -File exploration\rehearse-piai-0871.ps1
```
