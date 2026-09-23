# 运行中回合的「深度求索中，用时…」标签：渲染链路与贴皮机制

> 本文回答三个问题：① 界面上那句「深度求索中，用时1分14秒」到底如何渲染？
> ② 想改它，有哪些缝、哪些是死的？③ force-compact 插件现在怎么改它？
> 结论：**文案与计时全在客户端**，由 `ui-chat` 的 `turn-process` 会话节点渲染，
> 锚点是落盘的 `turn/start` 时间戳 + 1 秒定时器；宿主 wire 层**只能驱动状态**，
> 改不了文案。插件走的是**只替换可见标签前缀、保留 harness 计时**的 DOM 贴皮。
>
> **2026-09-24 重写**：原文描述的是 harness 0.1.7 之前的
> `ui-conversation/ChatView.tsx` `TurnStatus` 组件（JSX 硬编码 `Deep diving...`、
> 未 i18n、≥15s 才出时钟、`.turnStatus` shimmer）。那一整套在 0.1.7 已删除。

## 一、渲染链路（0.1.7 实况）

```
turn/start（持久事件，带时间戳）
  │  conversation-nodes/turn-process.ts:213   match → 建节点（锚 controlAnchorSeq）
  ▼
TurnProcessNodeView（chat/TurnProcessNodeView.tsx:10-68）
  ├─ 计时：useState(now) + setInterval(LIVE_RUN_CLOCK_INTERVAL_MS=1000)   [:18-25]
  ├─ 时长：elapsedMs = max(1000, (turn.end?.time ?? now) − turn.start.time) [:30-31]
  ├─ 文案：running ? t('message.turnProcess.deepDivingFor',{duration})
  │                 : t('message.turnProcess.took',{duration}) / worked / failed / stopped [:35-40]
  └─ 结构：
       <span role="status" aria-live="polite" class="…visuallyHidden">深度求索中</span>   ← a11y 播报
       <button data-turn-process="N"><span class="…label">深度求索中，用时1分14秒</span></button>  ← 唯一可见文案
```

| 环节 | 位置 |
|---|---|
| 组件本体 | `packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx` |
| 计时与格式化 | `…/chat/message-chrome.ts:13`（`LIVE_RUN_CLOCK_INTERVAL_MS`）、`:49-78`（`formatRunDuration` 结束态补零 / `formatLiveRunDuration` 运行态秒不补零） |
| 词典 | `…/client/locale.ts:48` `'深度求索中，用时{duration}'`、`:68` `'深度求索中'`、`:147-149` 时长模板 |
| 节点定义 / 事件匹配 | `…/conversation-nodes/turn-process.ts:212-239`（`turn/start` → start，`step/*`、`turn/end` → update） |
| 渲染器注册 | `…/chat/register-node-renderers.ts:63`（`conversation.chat.node` key `turn-process`） |
| 样式 | `…/chat/TurnProcessNodeView.module.css`（`.root` / `.label`：`color: var(--dsw-alias-label-tertiary)`） |
| a11y 隐藏 | `…/chat/accessibility.module.css` `.visuallyHidden`（1px 裁剪） |

**语义要点**

- **可见文案 = 一个插值字符串**（`PREFIX + 时长`），**运行期间每秒重渲染一次**。
- `role="status"` 节点只放 `chat.deepDiving`（**不含时长**），且是 1px 裁剪的读屏专用节点。
- **0.1.7 取消了旧版「15 秒后才显示时钟」的门槛**——running 期间恒显时长。
- 计时锚点是**落盘**的 `turn/start` 时间戳，刷新页面能续上真实耗时。
- `.turnStatus` / `.turnStatusClock` 两个类与整套 shimmer 已删除（全仓只剩一个无关的
  `locationTurnStatus` 工具函数）；旧文档描述的 shimmer 贴皮路径已不存在。

### 实例 DOM（live 3080 抓取）

```html
<div data-chat-flow-kind="turn-process" data-chat-turn="6">
  <div data-slot="conversation.chat.node" style="display:contents">
    <span class="QgQmwW_visuallyHidden" role="status" aria-live="polite" aria-atomic="true">深度求索中</span>
    <button class="thT5eq_root" data-turn-process="6" disabled="" aria-expanded="true">
      <span class="thT5eq_label">深度求索中，用时1分14秒</span>
    </button>
  </div>
</div>
```

稳定锚点（非哈希）：`button[data-turn-process]`、`data-chat-flow-kind="turn-process"`、
`data-chat-turn`。哈希类名（`thT5eq_*`、`QgQmwW_*`）不可依赖。

## 二、DOM 契约（贴皮方必须遵守）

| 事实 | 后果 |
|---|---|
| 可见文案在 `button[data-turn-process] > span` 的**文本节点**里 | 必须改 `nodeValue`；写 `textContent` 会换掉 React 持有的那个文本节点，官方计时从此更新不上来 |
| 该文本节点**每秒**被 React 重写（时长在跳） | 一次性覆盖 ≤1 秒即被抹掉；必须"React 一写就重贴" |
| `role="status"` 是读屏播报节点，且是**判断运行态的唯一语言无关信号** | 可以读它当锚，但**不能改**（改了读屏器会播报贴皮文案，且丢掉官方播报） |
| 运行态标签 = 播报文本 + 计时（`深度求索中` + `，用时1分14秒`；`Deep diving` + ` for 1m 14s`） | 用**公共前缀**切分即可拿到"属于 harness 的计时"，中英通用、无需硬编码任何文案 |
| 回合结束后标签变成「用时 2分5秒」/「Took 2m 5s」/「已完成工作」 | 这些与播报文本**没有**公共前缀 ⇒ 判据天然排除，官方原文不动 |

## 三、驱动方法：能改什么、不能改什么

| 目标 | 可行性 | 途径 |
|---|---|---|
| **让它出现** | ✅ | wire `session/prompt`（queue 模式）注入任务使该回合 running |
| **让它消失** | ✅ | 轮询 `session/list` 直到 `running=false`，或 `session/cancel` |
| **读计时锚点** | ✅ | `session/history` 提取最新 `turn/start` 时间戳 |
| **改可见文案（持久、抗每秒重渲染）** | ✅ | **只在客户端**：替换可见标签前缀 + 观察 React 重写（见 §四） |
| **改 `role="status"` 播报** | ❌ 不该做 | 那是无障碍通道；改它 = 抢播报，且不改变可见文案 |
| **改 locale 词典持久改词** | ❌ | `locale.register` 对**同一 ns+locale** 的第二人抛 `already has locale`（见 `ui-directory-picker-browse/tests/client-flow.client.spec.tsx:141-161`），外部插件无法覆盖 `ui-chat` 的 `chat` 命名空间 |
| **改上游源码字面量** | ⚠️ | 0.1.7 起文案已 i18n，改的是 `ui-chat` 词典，且属 `deepseek-harness` 上游流程 |

**为什么 wire 层改不了文案**：wire（`session/*`、`host/*`…）没有任何「改 UI 文案」的方法，
只能影响状态；文案由前端组件按状态渲染。所以持久改词只能落在客户端 DOM 或上游词典。

## 四、force-compact 插件现在的做法（前缀替换器）

`dsh-force-compact/web/client.js` 的 `paintTurnStatus` + 一组 `*Label*` 助手：

1. **定位**：`document.querySelectorAll('button[data-turn-process] > span')`（多会话/多标签页各命中）。
2. **切分**：读同级 `[role="status"][aria-live="polite"]` 的文本当锚，取它与可见标签的
   **公共前缀长度**；前缀之后即为 harness 计时（含 `，用时` / ` for ` 连接词），原样保留；
   公共前缀为 0 ⇒ 不是运行态，跳过、官方原文留着。
3. **写入**：`textNode.nodeValue = 相位文案 + 计时尾巴`。**不写颜色、不改字体**，
   官方 tertiary 灰与字号逐字不变。
4. **抗重渲染**：`MutationObserver`（`characterData` + `childList`）在 React 重写的同一微任务里
   重贴；观察器**只在有活跃相位期间连接**，清空即断开（插件卸载再兜底断开）。
   回调先用 `touchesTurnLabel(records)` 过滤，自己的写入由 `painted` 值比对短路，不会自激。
5. **清空**（宿主推 `text: ""` / `textId: 'end'`）：把贴过的标签**还原成官方原文**并断开观察器
   ——回合结束后 React 不再重渲染该标签，不还原就会永久残留贴皮文案。

宿主侧 `src/core/ui-signal.js` 只发 `{ phase, text, textId }`（**不再有 `color`**）；
相位 = `working`（每次 LLM 调用换一条随机俏皮话）/ `compressing` / `done` / `end`。

**行为验证**：`node exploration/fc-livetext-prefix-probe.mjs` —— 从 `web/client.js`
**提取真实实现**（不是副本）配最小 DOM 桩，12 项：中英前缀替换、计时保留、无时长形态、
回合结束不贴、相位切换原地重绘、React 重写后重贴、自激短路、清空还原 + 断连、
textId 未知回退、多会话并贴。

## 五、驱动脚本

```
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs [PORT] [--sid=<id>] [verbs...]
```

| 动词 | 作用 | wire 方法 |
|---|---|---|
| `smoke` | 拉会话表，打印各行 `id/running/cwd/updatedAt` | `session/list` |
| `anchor` | 从 `session/history` 读出最新 `turn/start` 时间戳（=计时的确切锚点） | `session/history` |
| `appear` | queue 模式 `session/prompt` 注入多步任务，轮询直到 `running=true` | `session/prompt` |
| `disappear` | 轮询直到 `running=false` | `session/list` |
| `cancel` | 立即停止当前回合 | `session/cancel` |
| `relabel` | 输出可粘贴到 DevTools 的片段，把可见标签文本节点换成自定义文案 | —（纯前端） |

### wire 协议要点（0.1.3 起为斜杠形态）

- **URL**：`POST /api/<namespace>/<method>`（如 `/api/session/list`）。
- **信封**：`{"type":"client-request","rpcId":"<uuid>","method":"<ns>/<method>","payload":{"args":{…}}}`。
- **`method` 与 URL 末段必须逐字一致**；`args` 内键名 = `@Remote` 方法形参名。
- **响应**：`{"type":"server-response","rpcId":"…","result":{"ok":true,"value":{…}}}`。
- **权威方法清单**：各 `packages/api/*/src` 里的 `@Remote('<name>')`（旧的
  `packages/host/apiproxy/src/api/rpc-map.ts` 已在 0.1.3 随 `apiproxy` 一起删除）。

## 六、引文表

| 位置 | 含义 |
|---|---|
| `packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx:10-68` | 组件（计时 `:18-25`、时长 `:30-33`、文案 `:35-44`、DOM `:45-66`） |
| `…/chat/message-chrome.ts:13,49-78` | 1 秒刷新常量与两个时长格式化器 |
| `…/client/locale.ts:48,68,147-149` | `deepDivingFor` / `deepDiving` / 时长模板 |
| `…/chat/TurnProcessNodeView.module.css` | `.root` / `.label`（官方 tertiary 灰） |
| `…/chat/accessibility.module.css` | `.visuallyHidden`（播报节点 1px 裁剪） |
| `…/conversation-nodes/turn-process.ts:212-239` | 事件匹配与节点状态折叠 |
| `…/chat/register-node-renderers.ts:63` | `turn-process` 渲染器注册 |
| `packages/client/locale/src/client/index.ts` | `register` / `addLanguage`（同 ns+locale 独占） |
| `dsh-force-compact/web/client.js` | 前缀替换器（`paintTurnStatus` 与 `*Label*` 助手） |
| `dsh-force-compact/src/core/ui-signal.js` | 宿主相位信令（`liveUi`，无颜色字段） |
| `exploration/fc-livetext-prefix-probe.mjs` | 贴皮行为探针（12 项） |
| `exploration/fcdrivestatus.cjs` | 会话/计时 wire 驱动脚本 |

## 七、复现命令

```bash
# 1. 冒烟：拉会话表（running 的行就是正在跑的那个）
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 smoke

# 2. 读计时锚点：最新 turn/start 时间戳
node D:\deepseek-harness-plugins\exploration\fcdrivestatus.cjs 3080 anchor

# 3. 贴皮行为（真实实现 + DOM 桩，12 项）
node D:\deepseek-harness-plugins\exploration\fc-livetext-prefix-probe.mjs

# 4. 核对官方文案与结构
rg "deepDiving" D:\deepseek-harness-plugins\deepseek-harness\packages\client\ui-chat\src
```
