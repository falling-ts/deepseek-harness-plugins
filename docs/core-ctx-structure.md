# DSH 核心 `ctx`（Context）结构与服务能力全景

> 本文基于在开发实例 3180 上运行的 `@falling-ts/dsh-force-compact` 插件注入的两只一次性探针实测采集，并用
> `deepseek-harness/vendor/cordis/src/{context,fiber,reflect,events,logger,registry}.ts` 与
> `packages/*/src/index.ts` 中的 `declare module '@deepseek-ai/cordis' { interface Context { … } }` 声明交叉验证。
>
> 原始证据文件（可复现）：
>
> - `~/.dsh/logs/ctx-probe/ctx-snapshot-boot-2026-08-25T01-40-19-697Z.json`（BOOT 层）
> - `~/.dsh/logs/ctx-probe/ctx-snapshot-realm-d48bc268c7c7.json`（REALM 层）
>
> 文中所有「实测」标记均来自这两个文件；「源码」标记均来自 vendor / packages 静态阅读。

---

## 0. 一句话总览

`ctx` 是 DSH 里所有插件与系统组件共用的**「当前作用域指针」**。它不是一个普通 JS 对象，而是一个由
多层匿名 `Context` 子类原型叠成的**代理（`Proxy`）对象**：唯一的自有数据属性是 `fiber`，其余一切属性
读取都被 `ReflectService.handler` 拦截并按「当前 isolate 作用域」解析。这一套机制同时承担四件事：
身份标识（哪个 plugin fiber / 哪一层 isolate）、服务定位符（跨包能力的唯一寻址方式）、
生命周期锚点（`effect/once/on/signal` 决定资源何时释放）、事件通道（`ctx.events`）。

---

## 1. 探测方法与两层 ctx

通过给 `dsh-force-compact/index.js` 的顶层 `apply(ctx)` 入口注入一次性快照探针、并在
`src/hooks/idle.js` 的 `handleAgentStatus(ctx, payload)` 监听器里挂第二次探针，对同一进程内的
两个 `ctx` 实例做了深度枚举（顺 `Object.getPrototypeOf` 一路爬到最底，逐帧列出全部属性描述符，
并对一组已知服务名逐个 `ctx.get(name)` 采样）：

| 层级 | 触发点 | 输出文件 |
|---|---|---|
| **BOOT 层**（Host 级 `apply(ctx)` 的参数） | 插件加载时一次 | `ctx-snapshot-boot-….json` |
| **REALM 层**（`agent/status` → `idle` 监听器的绑定 ctx） | 任一会话进入 `idle` 后首次 | `ctx-snapshot-realm-….json` |

两层都拿到后交叉比对：**两者的原型链形状完全一致**，只是可见的服务集合略有差异
（realm 比 boot 多解出 `tokenMeter`、`fs`、`locale`）。这与 Cordis「每个作用域都是同一类
`Context` 的子代原型」的设计吻合——**作用域切换不产生新对象，只是在原型链顶端叠一个新叶子**。

---

## 2. `ctx` 的物理形态（实测）

```js
ctx.constructor.name === 'Context'
ctxOwnKeys             == ['fiber']                       // 唯一自有属性
```

`ctxPrototypeChain`（由外向内，depth 越大越靠近最根部基础层）：

```
depth 0:  { fiber }                                     ← 最外层叶子（apply 收到的那一层）
depth 1:  { }                                           （空壳帧）
depth 2:  { baseUrl }
depth 3:  { fiber }
depth 4:  { }
depth 5:  { baseUrl }
depth 6:  { fiber }
depth 7:  { root, baseUrl, fiber, reflect, registry,
            events, logger }                             ← 最底层 = Cordis 内置六件套 + 应用根
```

> 源码印证（`vendor/cordis/src/context.ts`）：`Context` 的构造器返回的是一个
> `new Proxy(this, ReflectService.handler)`；`root / baseUrl / fiber / reflect / registry /
> events / logger` 七个字段在构造器里一次性挂到这个代理目标的"最底层"（即上面 depth 7 那帧）。
> `extend / isolate / intercept` 生成的每一个子代 context 都在这条链顶端又叠一层，
> 于是形成上面观测到的"交替出现 `fiber` 与 `baseUrl` 的中间空壳帧"。

**推论**：`Object.getOwnPropertyNames(ctx)` 只能看到 `["fiber"]`；任何别的东西（包括 `ctx.get` /
`ctx.provide` / `ctx.on` / `ctx.logger` 等等）都不可能是 ctx 的自有属性，只能通过
**Proxy 拦截器动态解析出来**。这就是为什么在插件里直接 `ctx.compaction` / `ctx.fs` 之类的写法
既不安全也不稳定（是否能看到取决于当前 isolate 作用域是否挂了同名服务）——正确姿势永远是
`ctx.get('<name>')` 加显式判空。

---

## 3. 六个基础成员（全部源自 Cordis 内核）

| 成员 | 类型 | 职责 |
|---|---|---|
| `ctx.root` | `this`（最根部 Context 引用） | 整个应用共享的根 context；任何子作用域的祖先查询最终都指回它 |
| `ctx.baseUrl` | `string \| undefined` | 相对插件 / 模块 specifier 解析用的基准 URL（Loader、HMR 用它定位 `./relative.specifier`） |
| `ctx.fiber` | `Fiber` | 持有当前这个 Context 所隶属的 **plugin runtime 实例**：config、effects、listeners、生命周期状态都在这里 |
| `ctx.reflect` | `ReflectService` | **核心调度器**——Proxy handler 背后的反射层；`ctx.get(name)` / `ctx.provide(name, val)` / `ctx.getOrCreate(name, factory)` 都经由它 |
| `ctx.registry` | `RegistryService` | 插件注册表；其方法被 mix-in 到 `ctx` 上（`ctx.plugin` / `ctx.inject` / `ctx.service` …） |
| `ctx.events` | `EventsService` | 事件总线；其方法同样被 mix-in 到 `ctx` 上（`ctx.on` / `ctx.once` / `ctx.off` / `ctx.emit` / `ctx.event` …） |
| `ctx.logger` | `LoggerService` | 日志门面；`ctx.logger(name)` 返回具名 logger（`info/warn/error/debug` 四档） |

前四个是"基础设施"，后三个是"被 mix-in 的能力面"。特别注意 `ctx.logger` 是 **LoggerService 实例**
（本身是个对象），而不是字符串；真正的具名 logger 要通过 `ctx.logger('[force-compact]')` 取回。

> `ctxOnEvent` / `ctxOnce` / `ctxEffect` 等方法并不是独立列出来的属性——它们是
> `EventsService` / `Fiber` 的公有方法被 `RegistryService` 的 mixin 过程批量转发到 ctx 表面上的。
> 从实测的描述符枚举看不到这些转发后的名字（因为 mixin 发生在 Proxy handler 层面、不走原型描述符），
> 但它们是可稳定调用的公开 API。

---

## 4. `ctx` 上的公共方法全集（按用途归类）

> 下表是**从插件视角**能够稳定调用的完整 API。由于非 `fiber` 的属性全部经由 Proxy 暴露，
> 这里按"功能面"分组列举，而非按原型帧逐一罗列。

### 4.1 服务存取（经由 `ReflectService`）

| 方法 | 行为 |
|---|---|
| `ctx.get(name)` | 严格按当前 isolate 作用域读全局 / 作用域服务存储；未挂载返回 `undefined`；永不抛错 |
| `ctx.provide(name, val)` | 在当前 fiber 作用域里 `val` 挂到 `name` 名下；此后同作用域 `ctx.get(name)` 命中它 |
| `ctx.getOrCreate(name, factory)` | 若已有返回已有，否则执行 `factory` 并 `provide` 其返回值（懒创建） |
| `ctx.has(name)` | 仅判断存在性，不取值 |
| `ctx.service(name)` | 等同 `ctx.get(name)` 但要求必存在，否则立刻抛错（适合必填依赖） |

### 4.2 作用域派生（`extend` / `isolate` / `intercept` 的组合糖）

| 方法 | 行为 |
|---|---|
| `ctx.extend(meta)` | 创建一个子代 context；`meta` 中的键会**遮蔽**父代同名键（原型链顶端新叶子） |
| `ctx.isolate(serviceName, label?)` | 子代中该服务的读 / 写都落到新标签；父代不受影响。两个同 `label` 的 isolate 会**合并**作用域 |
| `ctx.intercept(serviceName, cfg)` | 子代加载的插件会在该服务的配置上**额外合并** `cfg`（用于按插件叠加默认值） |

这三个方法是理解「同一个 `ctx` 变量在不同作用域看到不同服务视图」的关键：`ctx.get('compaction')`
在 Host 层可能 `undefined`、在 `agent-presets:*` 之下可能是官方 `CompactionBasic` 实例——
**服务解析永远以最近的 isolate 标签为准**，这正是 `dsh-force-compact` 选择"双引擎"
（官方优先、内置兜底）的根本原因（详见 `dsh-force-compact/AGENTS.md` 历史背景节）。

### 4.3 事件与生命周期

| 方法 | 行为 |
|---|---|
| `ctx.on(event, fn)` | 注册监听器；随 fiber 卸载自动清理 |
| `ctx.once(event, fn)` | 单次版 |
| `ctx.off(event, fn)` | 手动移除 |
| `ctx.emit(event, ...args)` | 同步发射（waterfall 语义：listener 可短接 chain） |
| `ctx.event(event, handler)` | 装饰型：返回包装过的 handler |
| `ctx.effect(disposeFn)` | 向当前 fiber 登记副作用；fiber 销毁时反向调用 |
| `ctx.signal(signal)` | 订阅外部 `AbortSignal`；signal 中止时销毁 fiber |

> Waterfall 语义（见 `docs/cordis-primer.md#waterfall`）：多个同名 listener 依次调用，
> 每个 listener 都可决定是否调用 `next()` 交棒；不调用等于短接 chain。这是 `session/event`
> 等长链事件的标准协作模型。

### 4.4 插件装载

| 方法 | 行为 |
|---|---|
| `ctx.plugin(spec, config?)` | 在当前 fiber 下启动一个子 fiber 跑目标插件，可 `await` 等待其就绪 |
| `ctx.inject(names…)` | 声明式注入：立刻在当前作用域拉取这些服务，并把引用记到 fiber 元数据 |
| `ctx.service(name)` | 见 §4.1 |

> **AGENTS.md 强规**（`packages/AGENTS.md`）："Optional services use `ctx.get(name)`.
> Reserve `ctx.<name>` for declared injections; the property proxy is topology-sensitive,
> while strict `ctx.get` reads the global service store." —— 插件代码里凡是出现裸 `ctx.xxx`
> 的地方都应该改成 `ctx.get('xxx')` 加显式判空。

---

## 5. `ctx` 可读出的主要业务服务（两层对比）

> 「✔ 可见」表示对应 `ctx.get(name)` 在本次实测验采中拿到了真实服务对象；
> 「✘ 不可达」表示本次实测验采返回 `undefined`。

| 服务名 | BOOT 层 | REALM 层 | 构造器 | 核心职责 |
|---|---|---|---|---|
| `settings` | ✔ | ✔ | `FileSettingsProvider` | `settings.yaml` 文档的读写队列 + 命名空间注册 / 刷新；`settings.ns('…').get()/update()` |
| `sessions` | ✔ | ✔ | `SessionStore` | 会话持久化：`create / prepare / enter / fork / list / get / detachEntered`；事件源 |
| `llm` | ✔ | ✔ | `LlmRuntime` | 适配器注册、模型发现、`stream` 流式调用、`resolveCallConfig` |
| `agents` | ✔ | ✔ | `AgentRegistry` | Agent 生命周期：`create / resume / register / enter / initiator 管理` |
| `commands` | ✔ | ✔ | `CommandRuntime` | `/slash` 命令的 `register / list / find / execute / settleThrown / mintCommandId` |
| `tokenMeter` | ✘ | ✔ | `TokenMeterService` | 估算任意消息序列的 token 数（`estimateMessage` / `estimateMessages` / `estimateBlocks`） |
| `compaction` | ✘（被 isolate 隔离掉） | ✘（本插件实测仍未挂载；需视 preset 组合而定） | `CompactionBasic`（官方） | `compactNow / compactRegion` 的官方压缩事务 |
| `fs` | ✘ | ✔ | `SandboxedFileSystem` | 沙箱内文件操作（`writeText / editText / checkedTarget`，受 `workspace-write` 围栏约束） |
| `locale` | ✘ | ✔ | `LocaleService` | i18n 文案本地化 |
| `slots` | ✘ | ✘ | — | 预留占位符（当前无实际挂载） |
| `logger` | ✘（仅作符号存在） | ✘（同上） | — | 真正的 logger 取自 `ctx.logger`（§3），而不是 `ctx.get('logger')` |

### 关键观察

1. **`compaction` 在两层实测中都不可达**。这不是 bug，而是 Cordis「顶层 disabled ≠ 服务缺失」
   的具体体现（见 `dsh-force-compact/AGENTS.md` "历史背景"一节）：`compaction-basic` 顶层虽然
   `disabled`，但 `agent-presets:compaction-basic` 处于 `enabled+active` 的状态意味着**只有在
   特定 preset 作用域内**才能 `ctx.get('compaction')` 拿到真身。本插件的 Host 层与
   `agent/status` realm 层都没命中那条 preset 作用域，所以两层都读 `undefined`。
   —— 这是插件"内置引擎兜底"的直接动机。
2. **`tokenMeter` / `fs` / `locale` 只在 REALM 层可见**。它们属于 `agent-presets:*` 挂载后
   才就位的服务；Host 层的 `ctx` 在这些 preset 还没展开时就读不到。这也解释了为什么插件的
   自动压缩 / 内置摘要两条路径都必须在 `agent/status` 回调里**重新解析**一遍服务，
   而不能沿用 `apply` 阶段缓存下来的引用。
3. **REALM 层比 BOOT 层多约 3 个可达服务**——正是 `dsh-force-compact` 选择在
   `hook/idle.js` 里"用监听器绑定 ctx 重新定位后端"（`resolveCompaction(ctx, agent, mode)`）
   的原因：监听器的 `this` 才是真正的 realm 上下文，`apply` 阶段的 ctx 在这里只是"曾经的外壳"。

---

## 6. `ctx` 的核心作用归纳

一句话：**`ctx` 是整棵插件树的"当前作用域指针"**。它同时承担四件事：

1. **身份标识**：哪个 plugin fiber、哪一层 isolate 作用域。
2. **服务定位符**：一切跨包能力的唯一寻址方式（避免到处 `import` 具体实现）。
3. **生命周期锚点**：fiber 的 `effect / once / on / signal` 决定了资源何时释放。
4. **事件通道**：`ctx.events` 让所有子系统围绕同一事件总线协作。

**设计取舍**：这种 Proxy + 多层原型的方案用很小的运行时开销（每次属性访问过一次 handler）
换来了三件大事：

- **同一份代码树可以在不同 preset 拓扑下看到不同的服务视图**（无需条件分支）；
- **作用域切换零拷贝**——只是换一个原型链顶端的叶子节点；
- **子代可以"局部重绑"某个服务而不污染父代**（`isolate` 的价值）。

代价是**可读性门槛**：光看 `ctx.foo` 的代码无法分辨 `foo` 是自有属性还是 Proxy 动态解析，
也不能靠 `typeof ctx.foo === 'function'` 来判断它是不是真的可调（可能只是一个"暂未挂载"
的空洞）。这就是 `packages/AGENTS.md` 那条「optional services 用 `ctx.get`」规则的由来。

---

## 7. 对 `dsh-force-compact` 的实践含义

| 代码位置 | 拿到的 ctx | 应该读什么 | 不应做什么 |
|---|---|---|---|
| `index.js` 顶层 `apply(ctx)` | BOOT 层 | `ctx.logger` / `ctx.fiber` / `ctx.registry` / 早期就位的 `settings` `sessions` `llm` `agents` `commands` | 不要假设 `ctx.get('compaction')` 必有值（会被 isolate 挡掉） |
| `hooks/idle.js` 的 `handleAgentStatus(ctx, payload)` | REALM 层 | 上述 + `tokenMeter` + `fs` + `locale` | 不要把这里取得的 ctx 缓存回 BOOT 作用域复用（会越权访问 isolate 外的资源） |
| `engine/builtin.js` 的 `builtinBackend(ctx, agent)` | 传入的是哪层就用哪层 | 只使用 `agent.session` + `ctx.llm.stream` + `ctx.tokenMeter.estimateMessage` 三者公开接口 | 不要碰 `ctx.sessions` 的私有字段（如 `_forkSeed`），那些属于 `SessionStore` 的内部实现 |
| `src/engine/official.js` | 透传监听器 ctx | 只在 `ctx.get('compaction')` 拿到真身后才走这条路；否则降级 | 不要试图通过 `ctx.provide('compaction', fake)` 自己伪造官方后端（会污染作用域） |

**经验法则**（本插件已在实践中沉淀）：

- 凡是要用 `compaction` / `tokenMeter` / `fs` / `locale` 这类"preset 平面服务"的地方，
  必须写在 `agent/status`（或类似监听器）回调里，**绝不**写在 `apply` 顶层。
- `apply` 顶层能安全用的只有 `settings` `sessions` `llm` `agents` `commands` 五个早期服务
  （加上 Cordis 六件套本身）。
- 任何 `ctx.get(x)` 的结果都要 `=== undefined` 判空后再用，并且判空失败要**静默降级**
  到内置兜底，而不是抛异常。

---

## 8. 附：复现方法

要自行复现本文的所有实测结论，只需两步：

1. **部署两只探针**（临时改动，交付前必须移除）：
   - 在 `dsh-force-compact/index.js` 顶层 `apply(ctx)` 内挂一个一次性 IIFE，
     遍历 `Object.getPrototypeOf` 链（上限 8 层）逐帧枚举描述符，同时对一组已知服务名
     逐个 `ctx.get(name)` 采样，把结果写到 `~/.dsh/logs/ctx-probe/ctx-snapshot-boot-<UTCISO>.json`。
   - 在 `dsh-force-compact/src/hooks/idle.js` 的 `handleAgentStatus` 顶部挂同样的采集逻辑，
     用 `ctx-snapshot-realm-<last12sid>.json` 做文件名（防重复）。
2. **重启 3180 开发实例**：`bash harness-server-dev.sh`（本工作区已授权的随意重启），
   然后通过 wire 协议触发一次真实的 `agent/status` → `idle` 循环：

   ```powershell
   POST http://127.0.0.1:3180/api/session.create   {}
   POST http://127.0.0.1:3180/api/session.prompt  { sessionId:"…", mode:"queue", content:[{type:"text",text:"hi"}] }
   # 等 ~30 s 让 agent 走完一轮进入 idle
   ```

3. 两份 JSON 落在 `~/.dsh/logs/ctx-probe/` 下，用任意 JSON viewer 打开即可对照本文表格。

> ⚠️ 探针代码**不得进入正式发布的插件**（`package.json` 的 `files` 白名单只包含
> `index.js` / `src/` / `web/` / `cordis.patch.yml`，探针代码即便留着也不会被打进 tarball；
> 但为了保持仓库整洁，仍应在交付前手工删掉）。

---

## 9. 参考文献（源码路径）

- `deepseek-harness/vendor/cordis/src/context.ts` — `Context` 类 + `extend / isolate / intercept`
- `deepseek-harness/vendor/cordis/src/fiber.ts` — `Fiber` 与 `resolveConfig`
- `deepseek-harness/vendor/cordis/src/reflect.ts` — `ReflectService` + Proxy handler
- `deepseek-harness/vendor/cordis/src/events.ts` — `EventsService` + waterfall 派发
- `deepseek-harness/vendor/cordis/src/logger.ts` — `LoggerService`
- `deepseek-harness/vendor/cordis/src/registry.ts` — `RegistryService` + mixin 转发
- `deepseek-harness/packages/core/session/src/index.ts` — `sessions: SessionStore` 服务定义
- `deepseek-harness/packages/settings/*`、`packages/llm/*`、`packages/interaction/*` — 各业务服务的 `declare module` 扩展
- `deepseek-harness/packages/AGENTS.md` — "Optional services use `ctx.get(name)`" 规则出处
- 本文 §2 引用的实测 JSON 文件（路径见文首）
