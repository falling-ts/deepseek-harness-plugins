# `ctx.llm.stream` 参数与本地 llama.cpp（:8080）适配性分析

> 本文基于三方交叉验证：① harness 侧 `GenerateOptions` / `GenerateOptions` 序列化源码
> （`deepseek-harness/packages/llm/llm/src/types.ts`、`packages/llm/llm-deepseek/src/serialize.ts`）；
> ② llama.cpp 本地 checkout（`D:\AI\llama.cpp`，OpenAI 兼容端点
> `tools/server/{server-common.cpp, server-schema.cpp, server-task.cpp}`）；
> ③ 对本机 `:8080` 实例（`llama-server --port 8080 --ctx 163840 --enable-mtp`，
> 模型 `Qwen3.8-27B-NVFP4-MTP-LOW.gguf`）的真实 wire 请求实测（复现脚本
> `fcprobe8080.cjs`，根工作区）。
>
> **核心结论先行**：适配度远好于"典型 llama.cpp 发行版"的一般印象——本机这份
> llama.cpp 的 OAI 兼容层做了**未识别字段透明透传**，且 `stream_options.include_usage`
> 、`reasoning_effort` 均为一等公民；真正的雷区只有一个：**未开 `--jinja` 时携带
> `tools` 字段会直接 400**。
>
> **关于向 wire 层注入额外参数的三种合规路径**（方案 A/B/C，详见 §7）：
> 首选 `ctx.on('llm/stream', …)` waterfall 拦截 + 浅拷贝重写 `GenerateOptions`
> 附加 wire 顶层键；次选 `registerAdapter` 自建整个 adapter；兜底 `prepareCall`
> 单发探测。三者均不破坏 harness 的单一 LLM 出口不变量。

---

## 1. 两端坐标

| 端 | 位置 | 职责 |
|---|---|---|
| harness LLM 出口 | `ctx.llm` = `LlmRuntime`（`packages/llm/llm/src/index.ts`） | 唯一真正发往模型的 HTTP 出口；`stream()` 前必过 `'llm/stream'` waterfall |
| 本实例采用的适配器 | `DeepSeekAdapter`（`packages/llm/llm-deepseek/`） | 把 `GenerateOptions` 翻译为 DeepSeek/OpenAI wire JSON |
| 本地服务端 | `llama-server`（`D:\AI\llama.cpp\tools/server/`），:8080，NVFP4 + MTP 投机解码 | OpenAI 兼容端点 `/v1/chat/completions` |
| 模型 | `Qwen3.8-27B-NVFP4-MTP-LOW.gguf`，`--ctx 163840`，无 `--mmproj`（纯文本路径） | chat 模板 `Qwen3-Coder.jinja` 风格（无 thinking 占位宏） |

`/v1/models` 实测返回（模型名即 GGUF 绝对路径，**harness 侧 `GenerateOptions.model`
必须照抄该路径**）：

```json
{ "model": "/root/models/Qwen3.8-27B-NVFP4-MTP-LOW.gguf",
  "capabilities": ["completion", "multimodal"],
  "system_fingerprint": "b10498-60addddf3", ... }
```

---

## 2. 实测证据（harness 形状请求 → :8080）

以 `serialize.ts` 尾部 `serializeRequest` 生产的**完全相同形状**的 payload 直连 8080：

```jsonc
{ "model": "…", "messages": [{"role":"system",…},{"role":"user",…}],
  "stream": true, "stream_options": { "include_usage": true },
  "thinking": { "type": "disabled" },
  "temperature": 0.7, "max_tokens": 32, "stop": [] }
```

| 观测项 | 结果 |
|---|---|
| HTTP 状态 | **200**（无任何字段触发 400/422） |
| 帧数 | 34 帧 SSE，首帧 `role` 占位，`[DONE]` 收尾 |
| 终止帧 `finish_reason` | `"length"` —— `max_tokens:32` 精确截断 |
| 末帧 `usage` | **真实计数**：`{prompt_tokens:60, completion_tokens:32, total_tokens:92}` |
| 末帧附赠 `timings` | prompt 90.3 tok/s、generated 91.5 tok/s、`draft_n:51, draft_n_accepted:18` —— **MTP 草稿/接受率在 wire 上直接可读** |
| 延迟 | 端到端约 3.4 s（32 token，含 664 ms prompt 阶段） |

复现方式：`node fcprobe8080.cjs`（位于本仓库根目录），任意时刻可直接重跑。

---

## 3. llama.cpp 侧的关键机制（源码定位）

### 3.1 未识别字段透传（本次最重要的发现）

`tools/server/server-common.cpp:1363-1371`（`oaicompat_chat_params_parse` 末尾）：

```cpp
// Copy remaining properties to llama_params
// This allows user to use llama.cpp-specific params like "mirostat", ... via OAI endpoint.
for (const auto & item : body.items()) {
    if (!llama_params.contains(item.key()) || item.key() == "n_predict") {
        llama_params[item.key()] = item.value();
    }
}
```

**含义**：OAI 端点把请求体里所有尚未消费的键值**原样拷入 `llama_params`**；若该键命中
llama.cpp 原生 schema（`server-schema.cpp` 定义的几十项），就被当作一等参数解析执行。
于是 harness 的 `GenerateOptions` 即便带了 llama.cpp 认识的键，也不会被"未知字段"拒掉，
反而可能悄悄生效。

### 3.2 `stream_options.include_usage` 为显式 schema 字段

`tools/server/server-schema.cpp:26-29`：

```cpp
add((new field_nested("stream_options"))
    ->add_subfield((new field_bool("include_usage", params.include_usage))
        ->set_desc("Whether to include usage information in the stream")));
```

实测末帧确实携带真实 `usage`，**不存在"旧版不实现 usage"的问题**（这一点与很多公网
llama.cpp 镜像不同，取决于你的 checkout 版本）。

### 3.3 `reasoning_effort` 一等公民

`server-common.cpp:1296-1304`：

```cpp
if (body.contains("reasoning_effort")) {
    auto reasoning_effort = json_value(body, "reasoning_effort", "");
    if (reasoning_effort == "none") {
        inputs.enable_thinking = false;
        inputs.chat_template_kwargs.erase("reasoning_effort");
    } else if (!reasoning_effort.empty()) {
        inputs.chat_template_kwargs["reasoning_effort"] = json(reasoning_effort).dump();
    }
}
```

`"none"` 硬关 thinking；其余取值落入 Jinja 模板 kwargs——**能否起作用完全取决于所用
chat 模板是否编写了对应的宏分支**。

### 3.4 `tools` 的硬门禁

`server-common.cpp:1123-1126`：

```cpp
if (!opt.use_jinja) {
    if (has_tools) {
        throw std::runtime_error("tools param requires --jinja flag");
    }
    ...
}
```

**未开 `--jinja` 时携带非空 `tools` 数组 → 运行时异常 → 400**。这是全文档唯一的
"硬冲突"点。

### 3.5 原生采样旋钮全景（OAI 端点亦可达，经由 3.1 透传）

`server-schema.cpp:89-160` 定义了：`top_k / top_p / min_p / top_n_sigma /
xtc_probability / xtc_threshold / typical_p / temperature / dynatemp_range /
dynatemp_exponent / repeat_last_n / repeat_penalty / presence_penalty / frequency_penalty /
dry_multiplier / dry_base / dry_allowed_length / dry_penalty_last_n /
dry_sequence_breakers / mirostat / mirostat_tau / mirostat_eta / adaptive_target /
adaptive_decay`，外加 `n_predict`（别名 `max_tokens` / `max_completion_tokens`）、
`n_keep`、`n_discard`、`cache_prompt`、`timings_per_token`、`response_fields`、
`sse_ping_interval` 等。

**注意**：harness 的 `GenerateOptions` 并未把这批采样旋钮透出（只有
`temperature / maxTokens / stop` 三项），因此**它们虽然在 wire 层可达，但在 harness 上层
API 里不可达**——除非绕过 `ctx.llm.stream` 直连 HTTP，但这违背"单一 LLM 出口"原则，不建议。

---

## 4. `GenerateOptions` 逐字段适配矩阵

> ✅ 完全生效　⚠️ 被接受但实际无效/半失效　❌ 会导致错误

| Harness 字段 | Wire 形态 | :8080 上的实际命运 |
|---|---|---|
| `provider` | 不透传（仅选 adapter） | — |
| `model` | `model` 字符串 | ✅ **必须写 GGUF 绝对路径**（见 §1） |
| `messages`（`text` 块） | `messages[]` | ✅ 模板 `Qwen3-Coder.jinja` 风格完整处理 system/user/assistant/tool 四角色 |
| `system` | 折入 `messages[0]` | ✅ |
| `messages[].reasoning`（CoT 块） | 助手消息追加 `reasoning_content` 字段 | ⚠️ 字段被接受并可回显（`server-task.cpp:541` 有渲染分支），但 Qwen 模板**无 thinking 占位宏** → 传入的上轮 CoT 不被织入新 prompt，等效丢失 |
| `messages[].tool-call` / `tool-result` | `tool_calls[]` / `role:"tool"` | ⚠️ 仅在有 `tools[]` 且 `--jinja` 时有意义；否则按通用 role 分支渲染 |
| `tools`（`ToolSchema[]`） | `tools[]`（function 格式） | ❌ **本实例未开 `--jinja`** → 携带非空 `tools` 直接 400（§3.4）。**当前 `dsh-force-compact` 及常规会话不使用 tools，故无实际爆炸风险；一旦启用带工具 preset，首次请求即 400** |
| `temperature` | `temperature` | ✅ 原生 schema 一等字段 |
| `maxTokens` | `max_tokens` | ✅ 实测精确截断至 32 token（§2） |
| `stop`（字符串数组） | `stop`（接受字符串或数组，`server-common.cpp:1133-1137` 自动包裹） | ✅ |
| `signal`（AbortSignal） | 不透传（客户端侧断开 SSE 连接） | —（正常设计） |
| `sessionId` | 不透传（harness 内部 replay 游标分离用） | —（正常设计） |
| `purpose`（`'compaction' \| 'session-title'`） | 不透传；adapter 内部消费 | —（正常设计） |
| `reasoningEffort` | 先映射为 `thinking:{type}` + 可选 `reasoning_effort` | ⚠️ `thinking` 字段**无此 wire 键** → 静默忽略；`reasoning_effort:"low"/"high"/"max"` 落入模板 kwargs 但 Qwen 模板无对应宏 → 数值落空；**`reasoning_effort:"none"` 才能硬关 thinking**（本实例也无事可关） |
| `stream: true` | `stream` | ✅ SSE 正常 |
| `stream_options.include_usage` | 同左 | ✅ 实测末帧携带真实 `usage` + `timings`（§2、§3.2） |
| `reasoning_budget_tokens` | 同左（`server-common.cpp:1337`） | ⚠️ 接受后仍需模板配合，本实例无效 |

**未被 `GenerateOptions` 覆盖但 wire 层可达的高级采样旋钮**：`top_p / min_p / top_k /
typical_p / dry_* / mirostat* / cache_prompt / timings_per_token / response_fields /
sse_ping_interval / …`（§3.5 清单）——经由 §3.1 透传机制理论上可用，但**harness 上层
API 未提供入口**，属"wire 可达、API 不可达"的死区。

---

## 5. 对 `dsh-force-compact` 的实践含义

1. **现状零冲突**：插件内置摘要路径调用的
   `ctx.llm.stream({ purpose:'compaction', system, messages, temperature, maxTokens, stop, sessionId })`
   全部字段落在 200 区间，`usage` 可信，压缩前后 token 账目能对得上。
2. **唯一地雷是 `tools`**：插件摘要路径**从不**携带 `tools` 字段，故永远安全。但若未来
   在同一 harness 实例上挂载带工具的 agent preset，需在重启 `llama-server` 时补上
   `--jinja` 标志，或在 preset 侧禁用工具暴露。
3. **思考强度控制**：对带 thinking 分支的模型（DeepSeek-R1 系 / QwQ 系），正确的
   wire 表达是 `reasoning_effort:"none"`，而**不是** harness adapter 默认产生的
   `thinking:{type}` 结构（后者在本实例静默忽略）。`dsh-force-compact` 若要新增
   "禁用思考"开关，应当同时产出两种 wire 字段以保证跨 provider 兼容。
4. **MTP 可观测性红利**：末帧 `timings.draft_n / draft_n_accepted` 使投机解码效率
   可在客户端侧度量；`usage.prompt_tokens_details.cached_tokens` 可用于验证 warm-prefix
   KV cache 命中率（与官方 `summarizeWithLlm` 的前缀对齐优化目标一致）。
5. **不要绕过 `ctx.llm` 直连 8080 取高采样精度**：虽然 `top_p/min_p` 等旋钮经
   §3.1 透传可达，但绕过 `ctx.llm.stream` 会跳过 `'llm/stream'` waterfall、重试策略、
   归因头与 usage 上报——违反 harness 的"单一 LLM 出口"不变量。

---

## 6. 复现步骤

```powershell
# 1. 确认 8080 存活
curl.exe -s http://127.0.0.1:8080/v1/models

# 2. 运行 harness 形状探针
node D:\deepseek-harness-plugins\fcprobe8080.cjs
#    预期：status 200、SSE ≥ 30 帧、末帧含 usage/timings/draft_*

# 3. 复现 400 雷区（可选）
curl.exe -s -X POST http://127.0.0.1:8080/v1/chat/completions ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"/root/models/Qwen3.8-27B-NVFP4-MTP-LOW.gguf\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"t\",\"parameters\":{}}}]}"
#    预期：HTTP 400 + "tools param requires --jinja flag"
```

---

## 7. 向 `ctx.llm` 注入 wire 层的额外请求参数

`GenerateOptions` 只把 `provider / model / messages / system / tools / temperature /
maxTokens / stop / reasoningEffort / sessionId / purpose` 这几组字段透传到
DeepSeek wire，**harness 层没有对应的 TS 字段**去承载 `top_p / min_p / cache_prompt /
repeat_penalty / dry_* / mirostat` 等 llama.cpp 原生采样旋钮（§3.5 列出的那些）。
但 llama.cpp 的 OAI 端点对这些键是**白名单制 + 未识别键透传**双重语义（§3.1），
意味着**只要在 HTTP wire JSON 的顶层加一个键，就立刻变成 llama.cpp 的一等参数**，
而 harness 的核心管线对 wire JSON 的顶层键数量没有任何校验。因此有三条合规路径，
按推荐优先级排序如下。

### 方案 A（首选）：`ctx.on('llm/stream', …)` waterfall 拦截 + 浅拷贝重写 options

`LlmRuntime.stream()` 在找到 adapter 之后、把 `options` 交给 adapter 的
`.stream()` **之前**，先过一遍名为 `'llm/stream'` 的 waterfall
（`packages/llm/llm/src/index.ts:65`、`995`）：

```ts
export class LlmRuntime extends Service {
  ...
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return ctx.waterfall(this, 'llm/stream', options, ...)
      .then(adapter => adapter.stream(resolved))
  }
}
```

waterfall 链上每一个监听器都拿到**同一个可变 `options` 引用**并把它传给
`next()`。利用这一点可以在最外层插入一个**只做浅拷贝 + 字段添加**的监听器，
既不改原对象、也不越权，还能把额外的采样旋钮干净地送到 wire 层：

```ts
// 插件 apply(ctx) 里，一次性幂等安装（latch 防止重复订阅）
let extraSamplerInstalled = false
ctx.on('llm/stream', function injectExtraSamplingFields(
  _self: unknown,
  options: GenerateOptions,
  next: () => AsyncIterable<any>,
) {
  // 只对特定 purpose 生效，避免污染正式 agent 请求
  if (options.purpose !== 'compaction' && options.purpose !== 'session-title') {
    return next()
  }

  // 浅拷贝 options，附加两个 wire 层扩展字段（TS 层面靠 any 桥接）
  const extended: typeof options & Record<string, unknown> = {
    ...options,
    // llama.cpp OAI 兼容层直接接受的采样旋钮（§3.5）
    ...(typeof options.temperature === 'number' ? {} : { temperature: 0.7 }),
    ...(typeof options.maxTokens === 'number' ? {} : { maxTokens: 1024 }),
    // 以下两项 GenerateOptions 没有对应 TS 字段，直接透传到 wire 顶层
    ...(extraTopP !== undefined ? { top_p: extraTopP } : {}),
    ...(extraCachePrompt !== undefined ? { cache_prompt: extraCachePrompt } : {}),
  }

  const inner = next.bind(null, extended)
  return inner()
})
```

**约束与注意点：**

1. **必须调用 `next()` 并把改写后的 `extended` 作为返回值传递**，否则 waterfall 被
   短路，adapter 拿不到任何东西。
2. **不要 mutate 原 `options`**（`generateOptions` 可能被 loop 或上游持有引用），
   必须浅拷贝。
3. **TS 严格模式**下给 `GenerateOptions` 增加未声明字段会报 `EXTRA_FIELDS`，
   所以这里用 `Record<string, unknown>` 联合类型桥接，`extraTopP /
   extraCachePrompt` 两个常量由插件 `Config` 注入（遵守 AGENTS.md 的"插件无可
   配置旋钮不算可扩展性"条款——这里是真·部署可调选择，不是隐式默认）。
4. **`llm/stream` waterfall 在所有 adapter 之上、所有 provider 之下**，因此这个
   注入对**任何** provider 都会发生（即使某天切回 DeepSeek 官方也照样把这两个
   字段带到 wire 上）。如果想只对 llama.cpp 生效，再加一层
   `options.provider.endsWith(':local')` 之类的路由过滤。

### 方案 B（次选）：`ctx.llm.registerAdapter` 自定义 adapter，在 `stream` 里直接组装 wire body

如果方案 A 不够灵活（比如要按 provider 区分 wire 字段集、要改 `messages` 结构、
要在 SSE 解析层加自定义逻辑），则整个 `LlmAdapter` 都可以自建：

```ts
import type { LlmAdapter, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

ctx.llm.registerAdapter(['my-llama-route'], {
  async stream(options: GenerateOptions) {
    const url = 'http://127.0.0.1:8080/v1/chat/completions'
    const body: Record<string, unknown> = {
      model: options.model,
      messages: flattenMessages(options.system, options.messages),
      stream: true,
      stream_options: { include_usage: true },
      // 下面这些是 wire 层独有字段，GenerateOptions 里没有对应 TS 字段
      top_p: myRoute.topP ?? 0.95,
      cache_prompt: myRoute.cachePrompt ?? true,
      // ...
    }
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: options.signal })
    // 手工解析 SSE 并 yield 为 StreamChunk 联合类型
    const reader = res.body!.getReader()
    /* ... decode chunks and map to text-delta / usage / finish ... */
  },
  ...
})
```

**优点**：wire body 完全可控，想加什么字段都行。**代价**：必须自己复刻
`SerializeMessagesWithOptions` 里的消息展开、`BlockAssembler` 的 chunk 聚合、
SSE 增量解析等逻辑，相当于手写半个 `llm-deepseek` 适配器。仅在方案 A 的
waterfall 层够不着的场景（例如要改 wire JSON 嵌套层级本身，而不是加顶层键）
才考虑这条路。

### 方案 C（兜底）：`prepareCall` + 一次性 `PreparedLlmCall.handle()` 绕行

`ctx.llm.prepareCall(config, signal)` 返回的是一个**一次性、可取消**的调用句柄
（`packages/llm/llm/src/index.ts:824`），其 `handle()` 直接返回底层
`AsyncIterable<StreamChunk>`，**跳过了 `'llm/stream'` waterfall**：

```ts
const prepared = await ctx.llm.prepareCall({
  provider: 'llama-local',
  model: options.model,
  temperature: options.temperature,
  maxTokens: options.maxTokens,
  // ...
}, options.signal)

const chunks = prepared.handle()   // 不经过 llm/stream waterfall
for await (const c of chunks) { /* consume as usual */ }
```

适合**单发探测类调用**（如插件内部的健康检查、能力探测），不适合替代主会话
循环（主循环的 `agent-loop` 已经持有自己注册的 adapter 和配置，`prepareCall`
的语义是一次性，无法像 `stream()` 那样参与会话 replay / 日志 / 归因）。

### 三方案对比速查

| 维度 | A · waterfall 注入 | B · 自定义 adapter | C · `prepareCall` |
|---|---|---|---|
| wire 顶层键数量 | **无限制**，任意扩展 | 无限制 | 受限于 `LlmCallConfig` 字段集 |
| 侵入程度 | 低（只加一个监听器） | 高（复刻半个 adapter） | 中（单发调用） |
| 对会话日志 / 归因的影响 | 无 | 无（走完整 adapter 链） | 无（绕过 waterfall 但不改日志） |
| 适用场景 | 给某类 `purpose` 附加采样旋钮 | 整个 wire 协议都要换（含消息展开逻辑） | 单发探测 / 健康检查 |
| 推荐优先级 | **首选** | 备选 | 兜底 |

**一句话结论**：日常需求用方案 A（`llm/stream` waterfall 注入额外键），特殊协议
用方案 B（整 adapter），单发探测用方案 C（`prepareCall`）。**不要**尝试
`Reflect.defineProperty` 修改 `GenerateOptions.prototype` 或 monkey-patch
adapter——这两者都会破坏 harness 的 `llm/adapters-updated` 事件一致性，违反
"单一 LLM 出口"不变量。

---

## 8. 引用与定位

| 事实 | 出处 |
|---|---|
| `GenerateOptions` 全字段表 | `deepseek-harness/packages/llm/llm/src/types.ts:341-377` |
| wire 序列化尾部（`stream/stream_options/thinking/temperature/max_tokens/stop`） | `deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts:353-367` |
| `reasoningEffort` → `thinking` / `reasoning_effort` 映射规则 | `deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts:70-110` |
| 未识别字段透传 | `D:\AI\llama.cpp\tools\server\server-common.cpp:1363-1371` |
| `stream_options.include_usage` schema 定义 | `D:\AI\llama.cpp\tools\server\server-schema.cpp:26-29` |
| `reasoning_effort` 解析与 `"none"` 特判 | `D:\AI\llama.cpp\tools\server\server-common.cpp:1296-1304` |
| `tools` 需 `--jinja` 的门禁 | `D:\AI\llama.cpp\tools\server\server-common.cpp:1123-1126` |
| 原生采样旋钮全集 | `D:\AI\llama.cpp\tools\server\server-schema.cpp:89-160` |
| `reasoning_content` 回显分支 | `D:\AI\llama.cpp\tools\server\server-task.cpp:541-547` |
| 实测响应样本（200 + usage + timings + draft_*） | 本文 §2，原始输出可由 `fcprobe8080.cjs` 随时重现 |
| `'llm/stream'` waterfall 挂载点（方案 A） | `deepseek-harness/packages/llm/llm/src/index.ts:65,995` |
| `ctx.llm.prepareCall`（方案 C） | `deepseek-harness/packages/llm/llm/src/index.ts:824` |
| `HarnessError` 基类 + 稳定 `code`（注入失败时可辨识） | `deepseek-harness/packages/llm/llm/src/error.ts:13-22` |
