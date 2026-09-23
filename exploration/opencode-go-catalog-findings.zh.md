# 为什么 `opencode-go` 的模型列表一直没有 `deepseek-v4.1-flash`

结论：**`opencode-go` 的模型表不是运行时从 opencode.ai 拉的，而是 pi-ai 依赖包内写死的静态目录**；
本 checkout 钉的是 `@earendil-works/pi-ai@0.85.1`（目录生成于 2026-09-05），而
`deepseek-v4.1-flash` 是 **pi-ai 0.86.0** 才加进该目录的。既没有上游新目录，profile 里也没有本地补表，
所以列表永远停在 0.85.1 那一刻。

## 证据链

### 1. profile 只给了 key，没有给模型表

`~/.dsh/profiles/web/cordis.patch.yml:8-13`（与 `cordis.yml:74-79` 同形）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
```

`packages/llm/llm-pi-ai/src/config.ts:105-110` 定义了这个语义：
`models` 省略 = “serve the installed catalog for the route unchanged”。
`~/.dsh/storages` 下也没有任何 opencode 相关的 settings 覆盖（grep 只命中会话缓存）。

### 2. “installed catalog” = pi-ai 包里的静态生成文件

- 实链目标：`node_modules/.pnpm/@earendil-works+pi-ai@0.85._a68c33b4…/node_modules/@earendil-works/pi-ai`
  （`packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai` 是符号链接）
- 目录文件：`dist/providers/data/opencode-go.json`；
  `dist/providers/data/.manifest.json` → **`generatedAt: 2026-09-05T11:58:56.761Z`**
- `src/catalog.ts:15` 直接 `import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'` 读它

用实链目录跑 `getBuiltinModels('opencode-go')`（等于 GUI 会列出的那份）：

```
opencode-go: 27 models (live install)
  anthropic-messages (2): minimax-m3, qwen3.8-flash
  openai-completions (21): deepseek-v4-flash, deepseek-v4-flash-vision-exp, deepseek-v4-pro,
      glm-5.1/5.2/5.3/5.3-flash, hy3, hy4-preview, kimi-k2.6/k2.7-code/k3, longcat-2.0,
      mimo-v2.5, mimo-v2.5-pro, minimax-m2.7, omen-alpha, qwen3.6-plus, qwen3.7-max,
      qwen3.7-plus, qwen3.8-max
  openai-responses (4): gpt-5.6-luna, grok-4.6, muse-spark-1.2-contributor, muse-spark-1.3-contributor
has deepseek-v4.1-flash: false
```

### 3. 连 GUI 的“获取可用模型”也不会刷新它

`packages/llm/llm-pi-ai/src/discovery.ts:1-14`（原文）：

> A route the installed pi-ai catalog ships is answered **from that catalog, with no network call at all**…
> Only a route the catalog does not describe — a gateway, a self-hosted server — is interrogated over the wire.
> **Neither path is a catalog refresh. Nothing here is stored**… `cordis.patch.yml` remains the only thing
> that decides what a route serves.

`opencode-go` 正是“catalog ships”的 route（`getBuiltinProviders()` 里有它的描述符，且
**没有 provider 级 baseUrl**——地址写在每个模型的 `baseUrl` 上，实测 `hasBaseUrl: false`），
所以“探测模型”按钮只会把这份 0.85.1 的本地目录再答一遍。

### 4. 上游在 0.86.0 才加入该模型

从 jsdelivr 逐个版本取 `dist/providers/data/opencode-go.json`（含 `deepseek-*` 的 id）：

| pi-ai | 目录 | deepseek 相关 id | 有 v4.1-flash |
|---|---|---|---|
| 0.85.1（本机） | 2026-09-05 | deepseek-v4-flash, -flash-vision-exp, -pro | **否** |
| 0.86.0 | — | + **deepseek-v4.1-flash** | 是 |
| 0.86.1 | — | 同上 | 是 |
| 0.87.0 | — | 同上 | 是 |
| 0.87.1（npm latest） | 2026-09-22 | 同上 | 是 |

`packages/llm/llm-pi-ai/package.json` 的声明是 `"@earendil-works/pi-ai": "^0.85.1"`
（`^0.85.1` 在 0.x 下只允许 `<0.86.0`），并且带一个**版本专属**补丁
`patches/@earendil-works__pi-ai@0.85.1.patch`。该补丁只删掉流式 tool-call 的
`parseStreamingJson` 调用（`anthropic-messages` / `bedrock-converse-stream` / `mistral-conversations` /
`openai-completions` / `openai-responses-shared` / `pi-messages`），**与模型目录无关**。

0.87.1 相对 0.85.1 的净变化（opencode-go 目录，27 → 30）：

- 新增：`deepseek-v4.1-flash`、`mimo-v2.6-flash`、`mimo-v2.6-pro`、`grok-4.7`
- 移除：`omen-alpha`

0.87.1 里 `deepseek-v4.1-flash` 的条目（可直接抄进本地补表）：

```json
{ "id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "api": "openai-completions",
  "provider": "opencode-go", "baseUrl": "https://opencode.ai/zen/go/v1", "reasoning": true,
  "thinkingLevelMap": { "off": null, "minimal": null, "low": "low", "medium": null,
                        "high": "high", "xhigh": null, "max": "max" },
  "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 384000,
  "compat": { "supportsStore": false, "supportsDeveloperRole": false, "supportsStrictMode": true,
              "maxTokensField": "max_tokens", "requiresReasoningContentOnAssistantMessages": true,
              "thinkingFormat": "deepseek" } }
```

### 5. 顺带更正一条笔记

根 `AGENTS.md`（2026-09-17）写“本机 `opencodego` 的 `deepseek-v4.1-flash` 是 `input: [text, image]`”：
**与当前安装不符**——0.85.1 目录里根本没有这个 id，profile 里也没有名为 `opencodego` 的 route。
该字段组合（text+image）与 0.87.1 的条目一致，所以这条大概来自当时装过更新 pi-ai 的一次运行。

## 三条可选修法

**A. 本地补表（立刻生效，只动你自己的 profile 层）**

注意 `models` 一给就**整体替换**安装目录（`catalog.ts:868-870`），没列出的模型从选择器里消失；
`modelOverrides` 只能改目录里**已有**的模型，写未知 id 会被 strict 写入拒绝（`catalog.ts:853-856`），
且不能与 `models` 并存。新 id 没有“同 id 目录条目”兜底，`api` / `baseURL` 必须自己给
（`catalog.ts:888-896`；`opencode-go` 无 provider 级 baseUrl，所以要写在 route 或该条目上）。

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
        baseURL: https://opencode.ai/zen/go/v1   # 只给“目录里没有的新 id”兜底
        api: openai-completions                  # 同上；同 id 目录条目的 api 优先
        models:
          - { id: deepseek-v4-flash }
          - { id: deepseek-v4-flash-vision-exp }
          - { id: deepseek-v4-pro }
          # …把 27 个旧 id 逐个列出（可只写 id，其余字段自动继承目录）…
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 384000
            input: [text, image]
```

代价：从此这份列表由你维护，上游再加新模型不会自动出现。

**B. 另开一个自建 route（不动内置 `opencode-go` 的列表）**

```yaml
      opencodego:            # 自己的 route 名，出现在选择器里
        apiKeyEnv: OPENCODE_GO_API_KEY
        api: openai-completions
        baseURL: https://opencode.ai/zen/go/v1
        models:
          - { id: deepseek-v4.1-flash, contextWindow: 1000000, maxTokens: 384000, input: [text, image] }
```

`config.ts:100-104`：目录里没有的 route 必须自带 `api`；`discovery.ts` 对这类 route **会**发
`GET {baseURL}/models` 探测，所以这条路是唯一能用“获取可用模型”按钮的。

**C. 上游升级（正路，但属于 harness 仓库的改动）**

把 `packages/llm/llm-pi-ai/package.json` 的 `@earendil-works/pi-ai` 抬到 `^0.87.1`、
重新生成版本专属补丁、跑 `pnpm run typecheck / test / hygiene`，再移动子模块指针。
不要在这个锁发布版本的 checkout 里临时 `pnpm update`——那会让 lockfile 偏离上游发布态，
并且补丁、drift gate（`catalog.ts` 的 `MODALITY_GATE` / `THINKING_LEVEL_GATE` /
`MAX_TOKENS_FIELD_GATE`）都要重验。

## 复现命令

```
cd D:\deepseek-harness-plugins\deepseek-harness
# 当前实际提供的 opencode-go 目录（等价于 GUI 会列的那份）
node --input-type=module -e "const a=await import('file:///D:/deepseek-harness-plugins/deepseek-harness/node_modules/.pnpm/@earendil-works+pi-ai@0.85._a68c33b4430d43f3230a6ca4636f469a/node_modules/@earendil-works/pi-ai/dist/providers/all.js');console.log(a.getBuiltinModels('opencode-go').map(m=>m.id).join('\n'))"
# 上游各版本的目录（看 v4.1-flash 从哪版开始有）
curl -s https://cdn.jsdelivr.net/npm/@earendil-works/pi-ai@0.87.1/dist/providers/data/opencode-go.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s)['openai-completions'].models['deepseek-v4.1-flash'],null,2)))"
```
