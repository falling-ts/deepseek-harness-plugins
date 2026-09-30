/**
 * 探针:dsh-start-command 在运行中的 3080 实例上的端到端验证。
 *
 * 与 `sc-prestep-probe.mjs`(纯离线、桩 ctx)互补:这一支打真实的宿主——真实
 * `ctx.shell` 执行器、真实 agents 注册表、真实由 GUI 产生的 pre-step 载荷。
 *
 * 验证的是目标行为的那句话:「没有任何 agent 在跑、你主动发消息时,在模型请求**之前**
 * 执行配置好的命令」。证据分三段,缺一不可:
 *
 *   1. **命令真的跑了** —— 命令把带随机标记的一行追加到临时文件,文件里出现该标记;
 *   2. **跑在模型请求之前** —— 该文件的 mtime 早于本回合第一条 `assistant/message`
 *      的 time(会话记录里的时间戳),即命令在模型开始回答之前就已经结束;
 *   3. **模型在同一回合里看得见它的效果** —— 提示词要求模型读取该文件并原文回复,
 *      会话记录里确实出现含标记的助手文本,且那次读取发生在**第一个步骤**里并且成功
 *      (不是"文件还不存在"、也不是被别的步骤补上的)。
 *
 * 附带记录一条实测坑:命令若用 pwsh 的 `echo … >> file`,落盘是 **UTF-16LE + BOM**,
 * 宿主的 `read` 工具会把它判为 binary 而拒读;本探针因此改用
 * `Add-Content -Encoding ascii` 写纯 ASCII(见 `command` 处的注释)。
 *
 * 反向一例:把命令清空后再发一次对话,标记文件**不增长**、宿主日志**不新增**
 * `[start-command]` 行 —— 证明"空值 = 零副作用"在线上的实际表现。
 *
 * 全程只读宿主记录 + 写一个临时文件;唯一写宿主的动作是设置项的写入与**还原**
 * (原值在开头读、在 finally 里写回)。
 *
 * 用法:node exploration/sc-e2e-probe.mjs [port]
 *
 * home 的解析**故意不信 `DSH_HOME`**:从 agent 的工具 shell 里调本探针时,环境里
 * 带着桌面应用的 `DSH_HOME=~/.dsh`(见根 AGENTS.md 的"两个 home,一个 host 一个"),
 * 照单全收就会去桌面版的家找 web 实例的会话记录。改为在候选 home 里**按 sessionId
 * 实际命中**(先 `~/.dsh-web`,再 `~/.dsh`),并在输出里报告命中的是哪一个;
 * `SC_DSH_HOME` 可显式覆盖。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import zlib from 'node:zlib'

const PORT = process.argv[2] ?? '3080'
const BASE = `http://127.0.0.1:${PORT}/api`
/** 候选 home,按命中 sessionId 判定;显式覆盖优先。 */
const HOMES = [process.env.SC_DSH_HOME, join(homedir(), '.dsh-web'), join(homedir(), '.dsh')]
  .filter((home) => typeof home === 'string' && home !== '')
/** 实际命中会话记录的那个 home(命中后回填,仅供输出)。 */
let homeUsed
const LOG = join(process.cwd(), `dsh-web-${PORT}.log`)
const NS = 'falling-ts-start-command'
const FIELD = 'startCommand'

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const info = (label) => console.log(`  --   ${label}`)

/** 一元 RPC:`{type:'client-request',rpcId,method,payload:{args}}`,失败即抛。 */
async function call(method, args) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
  })
  const json = await res.json().catch(() => null)
  const result = json?.result
  if (res.status !== 200 || result?.ok !== true) {
    throw new Error(`${method} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  }
  return result.value
}

/** 轮询直到 `probe()` 返回真值,或超时。 */
async function waitFor(probe, timeoutMs, stepMs = 750) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** 读一个设置命名空间的当前视图。 */
async function describeNamespace() {
  const value = await call('settings/describe', {})
  return value.namespaces.find((view) => view.ns === NS)
}

/** 写设置并回报写后的视图。 */
async function writeSetting(command) {
  const before = await describeNamespace()
  await call('settings/update', { ns: NS, patch: { [FIELD]: command }, expectedRevision: before.revision })
  return describeNamespace()
}

/**
 * 会话记录是**多帧拼接**的 zstd(首帧只有 header),同步 API 只解第一帧,故按
 * magic 逐帧推进、逐段验证边界后再拼接。
 * @param {string} file session.v4.jsonl.zstd 路径
 * @returns {object[]} 解析后的事件数组
 */
function decodeTranscript(file) {
  const raw = readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; i + 4 <= raw.length; i++) if (raw.subarray(i, i + 4).equals(MAGIC)) offsets.push(i)
  offsets.push(raw.length)
  const chunks = []
  let cursor = 0
  while (cursor < offsets.length - 1) {
    let advanced = false
    for (let j = cursor + 1; j < offsets.length; j++) {
      try {
        chunks.push(zlib.zstdDecompressSync(raw.subarray(offsets[cursor], offsets[j])))
        cursor = j
        advanced = true
        break
      } catch { /* 假 magic:继续找下一个候选边界 */ }
    }
    if (!advanced) break
  }
  return Buffer.concat(chunks).toString('utf8').split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/** 在候选 home 的会话目录里按 sessionId 找到记录文件(命中即记下是哪个 home)。 */
function findTranscript(sessionId) {
  for (const home of HOMES) {
    const root = join(home, 'sessions')
    if (!existsSync(root)) continue
    for (const workspace of readdirSync(root)) {
      const candidate = join(root, workspace, sessionId, 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) { homeUsed = home; return candidate }
    }
  }
  return undefined
}

/** 等待会话记录出现某回合的 turn/end,然后返回该会话的全部事件。 */
async function awaitTurn(file, turn, timeoutMs) {
  return waitFor(() => {
    if (!existsSync(file)) return undefined
    try {
      const events = decodeTranscript(file)
      if (events.some((event) => event.type === 'turn/end' && event.data?.turn === turn)) return events
    } catch { /* 半个帧:稍后重读 */ }
    return undefined
  }, timeoutMs)
}

/** 会话记录里助手可见的文本(含工具结果),用于判断模型是否读到标记。 */
function assistantVisibleText(events) {
  const parts = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (typeof block?.text === 'string') parts.push(block.text)
      }
    }
    if (event.type === 'tool/result') parts.push(JSON.stringify(event.data ?? {}))
  }
  return parts.join('\n')
}

/** 把一条标记行追加到文件(模拟"开始前命令"的副作用)。 */
const marker = join(mkdtempSync(join(tmpdir(), 'sc-e2e-')), 'sc-e2e.txt')
const token = `sc-e2e-${Date.now().toString(36)}`
/**
 * 命令用 `Add-Content -Encoding ascii` 而不是 `echo … >> file`。原因是一次实测发现:
 * 宿主 `read` 工具会把 **UTF-16LE(带 BOM)** 的文件判为 "binary file" 而**拒读**
 * (`Error: cannot read "…": binary file …`),而 pwsh 的 `>>` 重定向默认正是那个编码。
 * 写 ASCII 才能让模型在**本回合第一个步骤**里直接读回标记,证据链更干净。
 */
const command = `Add-Content -LiteralPath '${marker}' -Value ${token} -Encoding ascii`
/** 会话记录里检索这次读取用的键:临时目录名不含反斜杠,故不受 JSON 转义影响。 */
const markerKey = basename(dirname(marker))

/**
 * 读标记文件的文本。宿主执行器的 pwsh `>>` 重定向默认落 **UTF-16LE + BOM**
 * (Windows PowerShell 5.1 的 `Out-File` 默认编码),按 UTF-8 读会得到穿插 NUL 的乱码
 * ——探针第一版就栽在这里(把"命令跑了一次"误判成失败),故按 BOM 判定解码。
 * @returns {string}
 */
function markerText() {
  if (!existsSync(marker)) return ''
  const buf = readFileSync(marker)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2)
  return buf.toString('utf8')
}

/** 标记文件里本次标记出现的行数(即命令实际执行的次数)。 */
function tokenCount() {
  return markerText().split(/\r?\n/).filter((line) => line.trim() === token).length
}

const original = await describeNamespace()
const originalCommand = original?.value?.[FIELD] ?? ''
const logBefore = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
const startCommandLines = (text) => text.split('\n').filter((line) => line.includes('[start-command]')).length

let sessions = []
try {
  console.log(`\n=== 0. 现场 ===`)
  info(`候选 home=${HOMES.join(' , ')}`)
  info(`log=${LOG} (${existsSync(LOG) ? '存在' : '缺席'})`)
  info(`原命令=${JSON.stringify(originalCommand)}`)
  info(`本次标记=${token}`)
  check(original !== undefined, `宿主注册了 ${NS} 命名空间`)
  check(original?.autoGenerate === false, '分区由插件自己提供(autoGenerate=false)')

  console.log(`\n=== 1. 写入开始前命令 ===`)
  const written = await writeSetting(command)
  check(written.value[FIELD] === command, '设置写入后立即生效(volatile 提交)', JSON.stringify(written.value))

  console.log(`\n=== 2. 配置了命令时的一次真实对话 ===`)
  const created = await call('session/create', { request: { cwd: process.cwd() } })
  const sessionA = created.sessionId
  sessions.push(sessionA)
  check(typeof sessionA === 'string' && sessionA.length > 0, '创建会话', String(sessionA))

  const prompt = `用 read 工具读取 ${marker} 这个文件,然后把它里面的内容去掉换行后原样回复给我。不要做任何别的事。`
  const accepted = await call('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: sessionA,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    },
  })
  check(accepted?.accepted === true, '提示词被接受', JSON.stringify(accepted))

  const eventsA = await waitFor(() => {
    const file = findTranscript(sessionA)
    if (file === undefined) return undefined
    try {
      const events = decodeTranscript(file)
      return events.some((event) => event.type === 'turn/end' && event.data?.turn === 1) ? events : undefined
    } catch { return undefined }
  }, 240_000)
  check(eventsA !== undefined, '第 1 回合结束(turn/end)')

  const fileA = findTranscript(sessionA)
  if (homeUsed !== undefined) info(`会话记录命中 home=${homeUsed}`)
  const events = eventsA ?? (fileA === undefined ? [] : decodeTranscript(fileA))

  // 证据 1:命令真的跑了,且本回合只跑一次。
  check(tokenCount() === 1, '命令执行:标记文件里本次标记恰好出现 1 行',
    `${tokenCount()} 行 / 原文 ${JSON.stringify(markerText().slice(0, 120))}`)

  // 证据 2:命令在模型开始回答之前就已结束(文件 mtime < 本回合首条 assistant/message)。
  const firstAssistant = events.find((event) => event.type === 'assistant/message' && event.data?.turn === 1)
  const mtime = existsSync(marker) ? statSync(marker).mtimeMs : Number.NaN
  check(Number.isFinite(mtime) && firstAssistant !== undefined && mtime <= firstAssistant.time,
    '命令早于本回合首条模型消息(文件 mtime <= assistant/message.time)',
    `mtime=${mtime} assistant=${firstAssistant?.time}`)

  // 证据 3:模型在同一回合里看得见命令的效果。
  const visible = assistantVisibleText(events)
  check(visible.includes(token), '模型在同一回合内读到了命令写下的标记',
    `可见文本 ${visible.length} 字符`)
  // 证据 3b:标记是模型**真读到的**(而非提示词里猜的)——把那次 read 的工具结果与调用点对上。
  const readCall = events.find((event) => event.type === 'tool/call'
    && String(event.data?.arguments ?? '').includes(markerKey))
  const readResult = readCall === undefined ? undefined
    : events.find((event) => event.type === 'tool/result'
      && event.data?.message?.toolCallId === readCall.data?.callId)
  check(readCall !== undefined && readResult !== undefined, '模型在第一个步骤里发起了对标记文件的读取',
    `step=${readCall?.data?.step}`)
  const resultText = readResult === undefined ? '' : JSON.stringify(readResult.data)
  check(readCall?.data?.step === 1 && resultText.includes(token)
    && !/no such file|not found|ENOENT|cannot find|binary file/i.test(resultText),
    '读取成功,结果里就是命令写下的标记(命令产物在首个步骤内已就位)')
  check(events.some((event) => event.type === 'turn/end' && event.data?.turn === 1
    && event.data?.reason?.kind === 'completed'), '回合正常结束(reason=completed)')

  const logNow = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
  const newLines = startCommandLines(logNow) - startCommandLines(logBefore)
  if (newLines > 0) {
    check(true, `宿主日志新增 ${newLines} 条 [start-command] 行`)
    const line = logNow.split('\n').filter((l) => l.includes('[start-command]')).pop()
    info(`日志:${line.trim().slice(0, 200)}`)
  } else {
    info('宿主日志没有新增 [start-command] 行(stdout 未落到本探测的日志文件,非行为问题)')
  }

  console.log(`\n=== 3. 清空命令后的第二次对话 ===`)
  const blanked = await writeSetting('')
  check(blanked.value[FIELD] === '', '设置已清空并生效', JSON.stringify(blanked.value))

  const created2 = await call('session/create', { request: { cwd: process.cwd() } })
  const sessionB = created2.sessionId
  sessions.push(sessionB)
  await call('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: sessionB,
      mode: 'queue',
      content: [{ type: 'text', text: '只回复两个字:完成' }],
    },
  })
  const fileB = await waitFor(() => findTranscript(sessionB), 60_000)
  check(fileB !== undefined, '第二次对话产生了会话记录')
  const eventsB = fileB === undefined ? undefined : await awaitTurn(fileB, 1, 180_000)
  check(eventsB !== undefined, '第 2 个回合结束')
  const linesAfter = tokenCount()
  check(linesAfter === 1, '命令为空时不再执行(标记文件未增长)', `${linesAfter} 行`)
  const logAfter = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
  check(startCommandLines(logAfter) === startCommandLines(logNow), '命令为空时宿主日志无新增 [start-command] 行')
} catch (error) {
  failed += 1
  console.log(`  FAIL 探针异常中止 — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  // 还原用户原本的设置项(这是本探针唯一对宿主的写入)。
  try {
    const restored = await writeSetting(originalCommand)
    console.log(`\n=== 4. 还原 ===`)
    info(`设置还原为 ${JSON.stringify(restored.value[FIELD])}`)
  } catch (error) {
    console.log(`\n=== 4. 还原失败(需人工检查) — ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
  try { rmSync(dirname(marker), { recursive: true, force: true }) } catch { /* 临时目录可留 */ }
  info(`本次创建的会话:${sessions.join(', ')}`)
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
