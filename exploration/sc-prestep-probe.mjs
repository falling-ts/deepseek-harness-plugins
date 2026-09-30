/**
 * 探针:dsh-start-command 的开启条件、执行路径与命名空间一致性。
 *
 * 这个插件的行为读起来只有一句话——"没有任何 agent 在跑、用户主动发消息时,在模型
 * 请求之前跑一条配置好的命令"——但它落在 `agent/pre-step` 这个 waterfall 上,所以
 * 真正的风险都在**边界**上:什么时候不该跑(回合中途的插话、后续工具步骤、别人还在
 * 跑、子代理自己的会话)、命令为空时是否真的一个副作用都没有、命令失败/超时/执行器
 * 缺席时是否绝不把异常抛进 waterfall、以及回合闩锁是否恰好一次。
 *
 * 全程离线:真实 import 宿主半部的 `index.js`(它的 Config 顶层 await 会走到工作区
 * 里 vendored 的 schemastery)、`src/hooks/pre-step.js` 与 `src/core/*`,用桩 ctx
 * 驱动 `apply`,再调用它注册上去的 waterfall 监听器。不连任何实例、不发任何命令。
 *
 * 用法:node exploration/sc-prestep-probe.mjs
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'dsh-start-command')

const load = (rel) => import(pathToFileURL(join(PLUGIN, rel)).href)

const index = await load('index.js')
const preStep = await load('src/hooks/pre-step.js')
const settings = await load('src/core/settings.js')
const runner = await load('src/core/runner.js')

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ── 桩 ───────────────────────────────────────────────────────────────────────
/** 一个 agent:只有 session.id / header 与 status 被插件读取。`cwd: null` 表示该会话没有 cwd。 */
function makeAgent({ sessionId = 'session-test', cwd = 'D:\\work', origin, status = 'running' } = {}) {
  const header = { id: sessionId }
  if (cwd !== undefined && cwd !== null) header.cwd = cwd
  if (origin !== undefined) header.origin = origin
  return { status, session: { id: sessionId, header } }
}

/** 一个 pre-step 载荷:默认就是"用户主动发消息、第一步骤、没有别人在跑"。 */
function makePayload({ agent = makeAgent(), turn = 1, step = 1, messages = [{ type: 'user' }] } = {}) {
  return { agent, turn, step, messages, signal: new AbortController().signal }
}

/** 记录调用的 shell 执行器桩。 */
function makeShell({ result } = {}) {
  const resolved = []
  const executed = []
  const final = result ?? { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 120000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
  return {
    resolved,
    executed,
    service: {
      resolve: (request) => {
        resolved.push(request)
        return { timeoutMs: 120000, onExpiry: 'kill', stdoutMaxBytes: 64000, workdir: 'default-cwd', ...request }
      },
      execute: async (spec) => {
        executed.push(spec)
        return { result: async () => final }
      },
    },
  }
}

/**
 * 桩 ctx。`services` 直接映射 ctx.get(name);`logger` 收下每一条日志供断言;
 * `on` 捕获注册的事件处理器供测试驱动。
 */
function makeCtx({ services = {}, handlers = [] } = {}) {
  const logger = []
  const effects = []
  const injections = []
  const ctx = {
    fiber: { id: 'stub-fiber' },
    logger: {
      info: (text) => logger.push({ level: 'info', text }),
      warn: (text) => logger.push({ level: 'warn', text }),
      error: (text) => logger.push({ level: 'error', text }),
    },
    get: (name) => services[name],
    on: (event, handler) => { handlers.push({ event, handler }); return () => {} },
    effect: (fn) => { const dispose = fn(); effects.push(dispose); return () => {} },
    inject: (deps, callback) => {
      injections.push(deps)
      callback({
        effect: (fn) => { fn(); return () => {} },
        settings: { configure: () => {} },
      })
      return () => {}
    },
  }
  return { ctx, logger, effects, injections, handlers }
}

/** 装配一次插件:返回 apply 后的现场;`applied` 是 apply 自身写下的日志条数基线。 */
function boot({ command = '', services = {} } = {}) {
  const live = makeCtx({ services })
  index.apply(live.ctx, { startCommand: { get: () => command } })
  preStep.clearLatches()
  const registered = live.handlers.find((entry) => entry.event === 'agent/pre-step')
  return { ...live, applied: live.logger.length, listener: registered === undefined ? undefined : registered.handler }
}

// ── 1. 命名空间一致性(不一致会静默让设置分区读不到值) ──────────────────────
console.log('\n=== 命名空间一致性 ===')
const patch = readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8')
const entryId = /- id:\s*(\S+)/.exec(patch)?.[1]
const clientSrc = readFileSync(join(PLUGIN, 'web/client.js'), 'utf8')
const clientNs = /const NS_SETTINGS = "([^"]+)"/.exec(clientSrc)?.[1]
check(entryId === settings.NS, `cordis.patch.yml 的条目 id 等于宿主 NS`, `entry=${entryId} host=${settings.NS}`)
check(clientNs === settings.NS, `客户端 NS_SETTINGS 等于宿主 NS`, `client=${clientNs} host=${settings.NS}`)
check(index.name === 'start-command', '插件 name 为 start-command', String(index.name))
check(typeof index.Config === 'function', 'Config 在 standalone 布局下可解析(vendored schemastery)', typeof index.Config)
check(/\bstartCommand\b/.test(String(index.Config)), 'Config 声明了 startCommand 字段', String(index.Config))
check(index.default === undefined, '不含 default 导出(混形态会让 Loader 丢掉命名空间)')

// ── 2. 结构门禁(qualifies) ─────────────────────────────────────────────────
console.log('\n=== 结构门禁 ===')
{
  const { ctx } = makeCtx({ services: {} })
  check(preStep.qualifies(ctx, makePayload()).reason === 'qualifies', '默认载荷通过门禁')
  check(preStep.qualifies(ctx, makePayload({ step: 2 })).reason === 'not-first-step', 'step=2(回合中途/后续步骤)被拒')
  check(preStep.qualifies(ctx, makePayload({ messages: [] })).reason === 'no-user-messages', '没有新消息(循环自唤醒)被拒')
  check(preStep.qualifies(ctx, makePayload({ messages: null })).reason === 'no-user-messages', 'messages 缺失时不抛异常')
  check(preStep.qualifies(ctx, makePayload({ agent: makeAgent({ origin: 'subagent' }) })).reason === 'subagent-session', '子代理自己的会话被拒')
  check(preStep.qualifies(ctx, { step: 1, messages: [{}] }).reason === 'no-agent', 'agent 缺失时被拒而不是抛异常')
}
{
  const running = makeAgent({ sessionId: 'other' })
  const { ctx } = makeCtx({ services: { agents: { list: () => [running] } } })
  check(preStep.qualifies(ctx, makePayload()).reason === 'other-agent-running', '别的 agent 在 running 时被拒')
}
{
  const other = makeAgent({ sessionId: 'other', status: 'idle' })
  const me = makeAgent()
  const { ctx } = makeCtx({ services: { agents: { list: () => [other, me] } } })
  check(preStep.qualifies(ctx, makePayload({ agent: me })).reason === 'qualifies', '自己 running、别人 idle 时通过')
}
{
  const { ctx } = makeCtx({ services: { agents: { list: () => { throw new Error('registry gone') } } } })
  check(preStep.qualifies(ctx, makePayload()).reason === 'qualifies', 'agents 注册表抛异常时降级为放行')
}
{
  const { ctx } = makeCtx({ services: {} })
  check(preStep.qualifies(ctx, makePayload()).reason === 'qualifies', 'agents 服务缺席时降级为放行')
}

// ── 3. 命令为空 = 零副作用 ──────────────────────────────────────────────────
console.log('\n=== 命令为空 ===')
{
  const shell = makeShell()
  const booted = boot({ command: '', services: { shell: shell.service } })
  const outcome = await preStep.maybeRunStartCommand(booted.ctx, makePayload())
  check(outcome.reason === 'no-command', '未配置时 reason=no-command', JSON.stringify(outcome))
  check(shell.resolved.length === 0 && shell.executed.length === 0, '未配置时完全不碰 shell 执行器')
  check(booted.logger.slice(booted.applied).length === 0, '未配置时不写任何运行日志')
  check(booted.listener !== undefined, 'agent/pre-step 监听器已注册')
}
{
  const blank = boot({ command: '   \n  ' })
  check((await preStep.maybeRunStartCommand(blank.ctx, makePayload())).reason === 'no-command', '纯空白命令同样跳过')
}
{
  // 空白命令 + 有人在跑:仍然先报 no-command(最省的短路)。
  const busy = boot({ command: '', services: { agents: { list: () => [makeAgent({ sessionId: 'x' })] } } })
  check((await preStep.maybeRunStartCommand(busy.ctx, makePayload())).reason === 'no-command', '空白命令短路优先于其它门禁')
}

// ── 4. 执行路径 ─────────────────────────────────────────────────────────────
console.log('\n=== 执行路径 ===')
{
  const shell = makeShell()
  const booted = boot({ command: 'git pull', services: { shell: shell.service } })
  const outcome = await preStep.maybeRunStartCommand(booted.ctx, makePayload({ turn: 3 }))
  check(outcome.ran === true && outcome.reason === 'completed', '执行成功 ran=true', JSON.stringify(outcome))
  check(shell.executed.length === 1, '命令恰好执行一次')
  check(shell.resolved[0].command === 'git pull', '命令原文交给执行器')
  check(shell.resolved[0].workdir === 'D:\\work', 'workdir 取会话 header.cwd', String(shell.resolved[0].workdir))
  check(shell.resolved[0].signal !== undefined, '把本回合的 signal 交给执行器(取消可杀进程)')
  const logs = booted.logger.slice(booted.applied)
  check(logs.length === 1 && logs[0].level === 'info', '成功只写一条 info 日志', JSON.stringify(logs))
}
{
  const shell = makeShell()
  const { ctx } = boot({ command: '  npm  ci  ', services: { shell: shell.service } })
  await preStep.maybeRunStartCommand(ctx, makePayload())
  check(shell.resolved[0].command === 'npm  ci', '命令两侧空白被裁掉、内部保留', JSON.stringify(shell.resolved[0].command))
}
{
  const shell = makeShell()
  const noCwd = makeAgent({ cwd: null })
  const { ctx } = boot({ command: 'ls', services: { shell: shell.service } })
  await preStep.maybeRunStartCommand(ctx, makePayload({ agent: noCwd }))
  check(shell.resolved[0].workdir === undefined, '会话无 cwd 时不传 workdir(交给执行器默认)')
}
{
  // 会话级沙箱策略:应当按会话解析后透传。
  const seen = []
  const shell = makeShell()
  const policyService = { resolve: (request) => { seen.push(request); return { mode: 'read-only', workspaceRoot: 'D:\\work', sessionId: 'session-test' } } }
  const { ctx } = boot({ command: 'ls', services: { shell: shell.service, sandboxPolicy: policyService } })
  await preStep.maybeRunStartCommand(ctx, makePayload())
  check(seen.length === 1 && seen[0].session !== undefined, 'sandboxPolicy 按调用会话解析')
  check(shell.resolved[0].sandboxPolicy?.mode === 'read-only', '解析出的沙箱策略透传给执行器')
}
{
  const shell = makeShell()
  const { ctx } = boot({ command: 'ls', services: { shell: shell.service, sandboxPolicy: { resolve: () => { throw new Error('bad policy') } } } })
  const outcome = await preStep.maybeRunStartCommand(ctx, makePayload())
  check(outcome.ran === true, 'sandboxPolicy 解析失败时降级(交给执行器默认)而不是中断')
}
{
  const shell = makeShell()
  const ok = boot({ command: 'true', services: { shell: shell.service } })
  const outcome = await preStep.maybeRunStartCommand(ok.ctx, makePayload())
  const failing = makeShell({ result: { exitCode: 3, signal: null, timedOut: false, aborted: false, timeoutMs: 120000, stdout: { text: '', truncated: false }, stderr: { text: 'boom', truncated: false } } })
  const second = boot({ command: 'false', services: { shell: failing.service } })
  const failedOutcome = await preStep.maybeRunStartCommand(second.ctx, makePayload())
  check(outcome.ran === true && outcome.exitCode === 0, '零退出算已执行', JSON.stringify(outcome))
  check(failedOutcome.exitCode === 3 && failedOutcome.stderrTail === 'boom', '非零退出带上 exitCode 与 stderr 尾巴')
  check(second.logger[second.applied].level === 'warn', '非零退出记 warn')
  check(ok.logger[ok.applied].level === 'info', '零退出记 info')
}
{
  const shell = makeShell({ result: { exitCode: null, signal: 'SIGKILL', timedOut: true, aborted: false, timeoutMs: 120000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } } })
  const { ctx, logger } = boot({ command: 'sleep 999', services: { shell: shell.service } })
  const outcome = await preStep.maybeRunStartCommand(ctx, makePayload())
  check(outcome.timedOut === true && outcome.exitCode === null, '超时(被信号杀死)如实上报')
  const line = runner.describeOutcome('sleep 999', outcome)
  check(line.level === 'warn' && /timedOut/.test(line.text), '超时日志标出 timedOut 而不是普通失败', line.text)
}
{
  const shell = makeShell({ result: { exitCode: null, signal: 'SIGTERM', timedOut: false, aborted: true, timeoutMs: 120000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } } })
  const { ctx } = boot({ command: 'sleep 999', services: { shell: shell.service } })
  const outcome = await preStep.maybeRunStartCommand(ctx, makePayload())
  check(outcome.aborted === true, '回合被取消时如实上报 aborted')
}
{
  const throwing = { resolve: (r) => r, execute: async () => { throw new Error('spawn failed') } }
  const booted = boot({ command: 'nope', services: { shell: throwing } })
  const outcome = await preStep.maybeRunStartCommand(booted.ctx, makePayload())
  check(outcome.ran === false && outcome.reason === 'execute-failed' && outcome.error === 'spawn failed', '执行器抛异常被收容', JSON.stringify(outcome))
  check(booted.logger[booted.applied].level === 'warn', '执行器异常记 warn')
}
{
  const booted = boot({ command: 'ls', services: {} })
  const outcome = await preStep.maybeRunStartCommand(booted.ctx, makePayload())
  check(outcome.reason === 'no-shell' && outcome.ran === false, 'shell 服务缺席时安静跳过', JSON.stringify(outcome))
  check(booted.logger[booted.applied].level === 'warn', 'shell 缺失记 warn(便于排障)')
}

// ── 5. 回合闩锁 ─────────────────────────────────────────────────────────────
console.log('\n=== 回合闩锁 ===')
{
  const shell = makeShell()
  const { ctx } = boot({ command: 'ls', services: { shell: shell.service } })
  const first = await preStep.maybeRunStartCommand(ctx, makePayload({ turn: 1 }))
  const again = await preStep.maybeRunStartCommand(ctx, makePayload({ turn: 1 }))
  const nextTurn = await preStep.maybeRunStartCommand(ctx, makePayload({ turn: 2 }))
  check(first.ran === true, '第 1 回合执行')
  check(again.reason === 'already-served', '同一回合第二次被闩锁拦住', JSON.stringify(again))
  check(nextTurn.ran === true, '下一个回合重新执行')
  check(shell.executed.length === 2, '三个请求只产生两次执行')
}
{
  // 闩锁在 await 之前就打上:重入的 pre-step 不会并发跑第二条命令。
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const executed = []
  const shell = {
    resolve: (r) => r,
    execute: async (spec) => { executed.push(spec.command); await gate; return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: '' }, stderr: { text: '' } }) } },
  }
  const { ctx } = boot({ command: 'ls', services: { shell } })
  const inFlight = preStep.maybeRunStartCommand(ctx, makePayload({ turn: 5 }))
  const reentrant = await preStep.maybeRunStartCommand(ctx, makePayload({ turn: 5 }))
  check(reentrant.reason === 'already-served', '命令尚未结束时重入请求已被闩锁拦住')
  release()
  await inFlight
  check(executed.length === 1, '重入没有启动第二条命令')
}
{
  // 被门禁拒绝时**不**打闩锁:同一个回合里若门禁后来放开,仍可执行。
  const shell = makeShell()
  const { ctx } = boot({ command: 'ls', services: { shell: shell.service } })
  const refused = await preStep.maybeRunStartCommand(ctx, makePayload({ step: 2, turn: 7 }))
  const inTurn = await preStep.maybeRunStartCommand(ctx, makePayload({ step: 2, turn: 7 }))
  check(refused.reason === 'not-first-step' && inTurn.reason === 'not-first-step', '被门禁拒绝不消耗闩锁')
}
{
  const { ctx } = makeCtx({ services: {} })
  for (let i = 0; i < 400; i += 1) preStep.markServed(`session-${i}`, 1)
  check(preStep.alreadyServed('session-399', 1) === true, '闩锁记录最新会话')
  check(preStep.alreadyServed('session-0', 1) === false, '闩锁按上限淘汰最旧会话(内存有界)')
  preStep.clearLatches()
}

// ── 6. 落盘运行日志(每一次"有命令的决策"都留一行) ──────────────────────────
/** 把日志指向一个临时文件,返回读取函数;`undefined` 表示关掉这个 sink。 */
function withOutcomeLog(file) {
  const previous = process.env.DSH_START_COMMAND_LOG
  if (file === undefined) process.env.DSH_START_COMMAND_LOG = ''
  else process.env.DSH_START_COMMAND_LOG = file
  return () => {
    if (previous === undefined) delete process.env.DSH_START_COMMAND_LOG
    else process.env.DSH_START_COMMAND_LOG = previous
  }
}
const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [])

console.log('\n=== 落盘运行日志 ===')
{
  const file = join(mkdtempSync(join(tmpdir(), 'sc-log-')), 'run.log')
  const restore = withOutcomeLog(file)
  try {
    const shell = makeShell()
    const booted = boot({ command: 'git pull', services: { shell: shell.service } })
    await preStep.maybeRunStartCommand(booted.ctx, makePayload({ turn: 7 }))
    const lines = readLog(file)
    check(lines.length === 1, '命令跑完写一行', JSON.stringify(lines))
    check(/\[start-command\] ran/.test(lines[0] ?? ''), '记录 kind=ran', lines[0])
    check(/session=session-test/.test(lines[0] ?? ''), '记录会话 id', lines[0])
    check(/turn=7/.test(lines[0] ?? ''), '记录回合号', lines[0])
    check(/exit=0/.test(lines[0] ?? ''), '记录退出码', lines[0])
    check(/^\d{4}-\d{2}-\d{2}T/.test(lines[0] ?? ''), '行首是 ISO 时间戳', lines[0])

    // 门禁拒绝同样留痕 —— 从外面看"没弹窗"和"没跑"是一样的,所以这条必须可查。
    const busy = boot({ command: 'ls', services: { agents: { list: () => [makeAgent({ sessionId: 'x' })] } } })
    await preStep.maybeRunStartCommand(busy.ctx, makePayload({ turn: 2 }))
    const refused = readLog(file).at(-1)
    check(/reason=other-agent-running/.test(refused ?? ''), '被门禁压制也留一行(含稳定 reason)', refused)
    check(readLog(file).length === 2, '两次决策共两行', String(readLog(file).length))

    // 空命令 = 零副作用,连日志都不写。
    const blank = boot({ command: '   ' })
    await preStep.maybeRunStartCommand(blank.ctx, makePayload())
    check(readLog(file).length === 2, '未配置命令时不写日志(零副作用)', String(readLog(file).length))

    // 执行器缺席 / 抛异常:仍然是一行 failed,且带原因。
    const noShell = boot({ command: 'ls', services: {} })
    await preStep.maybeRunStartCommand(noShell.ctx, makePayload({ turn: 3 }))
    check(/\[start-command\] failed .*did not run \(no-shell\)/.test(readLog(file).at(-1) ?? ''), '执行器缺席记为 failed', readLog(file).at(-1))
  } finally { restore() }
}
{
  // 关掉 sink:一行都不写,且不抛。
  const restore = withOutcomeLog(undefined)
  try {
    const shell = makeShell()
    const booted = boot({ command: 'ls', services: { shell: shell.service } })
    const outcome = await preStep.maybeRunStartCommand(booted.ctx, makePayload())
    check(outcome.ran === true, 'DSH_START_COMMAND_LOG 为空 = 关掉 sink,命令照常执行')
  } finally { restore() }
}
{
  // 路径不可写时绝不抛(日志失败不能失败一个回合)。
  const restore = withOutcomeLog('Z:\\definitely\\missing\\drive\\run.log')
  try {
    const shell = makeShell()
    const booted = boot({ command: 'ls', services: { shell: shell.service } })
    const outcome = await preStep.maybeRunStartCommand(booted.ctx, makePayload())
    check(outcome.ran === true, '日志路径不可写时命令照常执行、绝不抛')
  } finally { restore() }
}

// ── 7. waterfall 语义(apply 注册的那个监听器) ──────────────────────────────
console.log('\n=== waterfall 语义 ===')
{
  const shell = makeShell()
  const { listener, ctx } = boot({ command: 'ls', services: { shell: shell.service } })
  const decision = { kind: 'enter', messages: [{ type: 'user' }] }
  const returned = await listener(makePayload(), async () => decision)
  check(returned === decision, '下游决定被原样返回(对象同一性)')
  check(shell.executed.length === 1, '进入步骤时命令已执行')
}
{
  const shell = makeShell()
  const { listener } = boot({ command: 'ls', services: { shell: shell.service } })
  const rejected = { kind: 'reject' }
  const returned = await listener(makePayload(), async () => rejected)
  check(returned === rejected, '下游 reject 被原样返回')
  check(shell.executed.length === 0, '被下游拒绝的步骤绝不执行命令')
}
{
  const throwing = { resolve: (r) => r, execute: async () => { throw new Error('kaboom') } }
  const { listener } = boot({ command: 'ls', services: { shell: throwing } })
  const decision = { kind: 'enter', messages: [] }
  const returned = await listener(makePayload(), async () => decision)
  check(returned === decision, '命令抛异常也不污染 waterfall 返回值')
}
{
  // next() 只被调用一次正是 waterfall 契约的要点。
  let calls = 0
  const { listener } = boot({ command: '', services: {} })
  await listener(makePayload(), async () => { calls += 1; return { kind: 'enter', messages: [] } })
  check(calls === 1, 'next() 恰好被委托一次')
}
{
  const { listener } = boot({ command: 'ls', services: {} })
  check(typeof listener === 'function', '监听器已注册在 agent/pre-step 上')
}
{
  // 工厂期无副作用:模块求值阶段不得注册任何东西。
  const { handlers } = makeCtx({ services: {} })
  check(handlers.length === 0, '构造 ctx 本身不注册任何监听器')
  const fresh = boot({ command: 'ls', services: {} })
  check(fresh.handlers.filter((e) => e.event === 'agent/pre-step').length === 1, 'apply 只注册一个 agent/pre-step 监听器')
  check(fresh.injections.length === 1 && fresh.injections[0][0] === 'settings', '设置表单声明走 ctx.inject([settings])')
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
