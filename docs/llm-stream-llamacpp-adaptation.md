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

## 7. 引用与定位

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
