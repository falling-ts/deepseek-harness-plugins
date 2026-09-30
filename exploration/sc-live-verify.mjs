/**
 * 探针:dsh-start-command 的**门 5(没有别的 agent 在跑)** 在真实实例上的两支表现。
 *
 * 为什么单开一支:`sc-e2e-probe.mjs` 验证的是"命令在模型请求之前跑完"这条主链,但它
 * **默认窗口是干净的**——它不管宿主上此刻有没有别的 agent 在 running。而门 5 恰恰是
 * "有活在飞时压制",所以有两件事只有本支能验:
 *
 *   A. **干净窗口 → 执行**(正例)。同时**等**窗口:本探针可安全地由"另一个 agent 的
 *      工具调用"发起——它会先轮询等到 `session/list` 里没有任何 `running:true`,再发话。
 *
 *      这条等待是必需的不是偷懒。2026-09-30 实测教训:本会话自己就跑在 3080 这台 host
 *      上(`session-43cbabb4` 一直是 `running:true`),于是我**在自己的回合里**连发三次
 *      真实回合去测"开始前命令",三次都没执行——因为"我"正是那个正在运行的 agent,
 *      门 5 每次都正确命中。把命令换成不依赖 node 的 `Add-Content` 做隔离也照样不执行,
 *      这才排除掉脚本本身的嫌疑。**判据:先看 `session/list` 的 running,再谈探针结果。**
 *
 *   B. **脏窗口 → 压制**(反例)。会话 A 的回合还在 running 时投递会话 B 的回合,B 的
 *      pre-step 必定看到 A 在跑,于是 B **不执行**命令;而 B 的回合照常跑完(压制不等于
 *      卡住)。这一支证明门 5 不是"永久静音":A 自己那一条仍然执行了。
 *
 * 用法:
 *   node exploration/sc-live-verify.mjs [port] [--clean-wait=秒] [--demo]
 *
 *   --demo(旧名 `--toast` 仍接受)  额外验一次**工作区根的真实 demo 命令**
 *             `node <repo>/test-start.js`,断言它写的
 *             `%TEMP%/dsh-start-command-last-run.txt` 被刷新、且标记里的 `text=`
 *             正是本探针这次写进命令的那一个。该段一律加 `--no-launch` 跑:只写文档与
 *             标记、不开记事本窗口——自动化里弹窗口只会抢焦点。默认关闭:那个文件属于
 *             工作区容器仓库、不属于插件仓库,不该成为插件的门禁依赖。
 *
 * 只读宿主记录 + 写一个临时目录;唯一写宿主的动作是设置项的写入与 finally 里的**还原**。
 * 退出码 0 = 全部通过,1 = 有失败,2 = 拿不到干净窗口(环境不满足,非插件缺陷)。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PORT = process.argv[2] ?? '3080'
const BASE = `http://127.0.0.1:${PORT}/api`
const NS = 'falling-ts-start-command'
const FIELD = 'startCommand'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO_SCRIPT = join(ROOT, 'test-start.js')
const DEMO_MARKER = join(homedir(), 'AppData', 'Local', 'Temp', 'dsh-start-command-last-run.txt')
const argNum = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(name.length + 3)) * 1000 : fallback
}
const WANT_DEMO = process.argv.includes('--demo') || process.argv.includes('--toast')
const CLEAN_WAIT_MS = argNum('clean-wait', 180_000)
const RUN_WAIT_MS = argNum('run-wait', 40_000)

let passed = 0
let failed = 0
let inconclusive = false
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const info = (label) => console.log(`  --   ${label}`)

async function call(method, args) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
  })
  const json = await res.json().catch(() => null)
  if (res.status !== 200 || json?.result?.ok !== true) {
    throw new Error(`${method} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  }
  return json.result.value
}

async function waitFor(probe, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

const sessions = async () => (await call('session/list', { _request: {} })).items ?? []
const runningIds = async () => (await sessions()).filter((s) => s.running === true).map((s) => s.sessionId)

/** 等到没有任何会话在 running。返回 `{ ok, waited, blockers }`。 */
async function waitCleanWindow() {
  const started = Date.now()
  let blockers = []
  const ready = await waitFor(async () => {
    blockers = await runningIds()
    return blockers.length === 0
  }, CLEAN_WAIT_MS, 1000)
  return { ok: Boolean(ready), waited: Date.now() - started, blockers }
}

async function describeNamespace() {
  const value = await call('settings/describe', {})
  return value.namespaces.find((view) => view.ns === NS)
}

async function writeSetting(command) {
  const before = await describeNamespace()
  await call('settings/update', { ns: NS, patch: { [FIELD]: command }, expectedRevision: before.revision })
  return describeNamespace()
}

/** 发一条真实对话,返回会话 id。 */
async function prompt(text, cwd = ROOT) {
  const created = await call('session/create', { request: { cwd } })
  const sessionId = created.sessionId
  await call('session/prompt', {
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
  })
  return sessionId
}

const READY = '只回复两个字:完成'
/** 稍长一点的提示词:让 A 的回合**确实在跑**,好给 B 制造"脏窗口"。 */
const LONG = '从 1 数到 30,每行一个数字,不要其它内容。'

const readMarker = (file) => {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}
const countToken = (file, token) => readMarker(file).split(token).length - 1
const mtimeOf = (file) => { try { return statSync(file).mtimeMs } catch { return 0 } }

console.log(`dsh-start-command 门 5 活体验证 — port ${PORT}`)
console.log(`  实例: ${BASE}`)

const markerDir = mkdtempSync(join(tmpdir(), 'sc-live-'))
const marker = join(markerDir, 'marker.txt')
const token = `sc-live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
// 写标记一律 ASCII:实测 pwsh 的 `echo … >> file` 落 UTF-16LE + BOM,宿主 read 会判 binary 而拒读。
const command = `Add-Content -LiteralPath '${marker}' -Value ${token} -Encoding ascii`

const original = (await describeNamespace())?.value?.[FIELD] ?? null
info(`本次运行前的 startCommand = ${JSON.stringify(original)}`)
let exitCode = 0

try {
  await writeSetting(command)
  info(`已写入标记命令(标记文件 ${marker})`)

  // ── A. 干净窗口 → 执行 ────────────────────────────────────────────────
  console.log('\n[A] 干净窗口:必须执行')
  const clean = await waitCleanWindow()
  check(clean.ok, `等到没有任何 agent 在 running(等了 ${Math.round(clean.waited / 1000)}s)`,
    clean.blockers.length ? `一直有: ${clean.blockers.join(', ')} —— 门 5 正在正常工作,换个空窗再跑` : '')
  if (!clean.ok) {
    inconclusive = true
    exitCode = 2
  } else {
    const sessionA = await prompt(READY)
    const hit = await waitFor(async () => countToken(marker, token) >= 1, RUN_WAIT_MS)
    check(Boolean(hit), `干净窗口里投递的回合执行了命令(${sessionA})`)
    if (!hit) info('本次窗口里没执行:若期间又有别的 agent 起来了,属门 5 正常表现,重跑本支')
  }

  // ── B. 脏窗口 → 压制 ──────────────────────────────────────────────────
  if (clean.ok) {
    console.log('\n[B] 脏窗口:有别的 agent 在跑时必须压制')
    // 让 A 保持 running:先用长提示词起一条,并等它真的进 running。
    const busyA = await prompt(LONG)
    const sawRunning = await waitFor(async () => (await sessions()).some((s) => s.sessionId === busyA && s.running === true), 15_000)
    check(Boolean(sawRunning), `会话 A(${busyA})已进入 running`)
    if (!sawRunning) {
      inconclusive = true
      exitCode = 2
    } else {
      const before = countToken(marker, token)
      const sessionB = await prompt(READY)
      // B 必须**照常跑完**,只是不执行命令。判据用投影里的 `turnOutline`(回合结束后才出现),
      // 而不是 `running !== true`:后者在"回合尚未开始"时也为真,会与 pre-step 抢跑、
      // 把"命令其实执行了"误判成通过。
      const bDone = await waitFor(async () => {
        const row = (await sessions()).find((s) => s.sessionId === sessionB)
        const outline = row?.projections?.values?.turnOutline
        return Array.isArray(outline) && outline.length >= 1 ? row : undefined
      }, 90_000, 1000)
      check(Boolean(bDone), `会话 B(${sessionB})的回合照常结束(压制不等于卡住)`)
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const after = countToken(marker, token)
      check(after === before, `B 的回合没有执行命令(A 在跑,门 5 压制;标记仍为 ${after} 行)`,
        `新增了 ${after - before} 行 —— 门 5 没生效`)
      info(`B 的回合记录已落盘:被压制的是**命令**,不是这一回合`)
    }
  }

  // ── C. 真实 demo 命令(可选)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (WANT_DEMO) {
    console.log('\n[C] 真实 demo:node test-start.js(记事本模式 / headless + 时间戳标记)')
    if (!existsSync(DEMO_SCRIPT)) {
      check(false, `存在 ${DEMO_SCRIPT}`)
    } else {
      await writeSetting(`node ${DEMO_SCRIPT} --text=sc-live-verify --no-launch`)
      const cleanC = await waitCleanWindow()
      if (!cleanC.ok) {
        inconclusive = true
        exitCode = 2
        info(`拿不到干净窗口(${cleanC.blockers.join(', ')}),跳过 C`)
      } else {
        const before = mtimeOf(DEMO_MARKER)
        await prompt(READY)
        const hit = await waitFor(async () => mtimeOf(DEMO_MARKER) > before, RUN_WAIT_MS)
        check(Boolean(hit), 'test-start.js 被真实回合执行(标记文件已刷新)')
        const marked = readMarker(DEMO_MARKER)
        check(marked.includes('text=sc-live-verify'), '标记里的 text= 就是本探针写进命令的那一个',
          `实际: ${marked.trim().split('\n').slice(0, 4).join(' | ')}`)
        if (hit) info(`标记内容: ${marked.trim().split('\n').slice(0, 3).join(' | ')}`)
      }
    }
  }
} catch (error) {
  failed++
  console.log(`  FAIL 探针异常: ${error?.message ?? error}`)
} finally {
  rmSync(markerDir, { recursive: true, force: true })
  try {
    await writeSetting(original ?? '')
    info(`设置已还原为 ${JSON.stringify(original)}`)
  } catch (error) {
    console.log(`  FAIL 设置还原失败: ${error?.message ?? error}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed${inconclusive ? ', 含环境不满足(未拿到干净窗口)' : ''}`)
process.exit(exitCode !== 0 ? exitCode : failed > 0 ? 1 : 0)
