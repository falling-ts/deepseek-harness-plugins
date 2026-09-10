/**
 * fc-plugin-load-probe.mjs — load smoke for the three workspace plugins under a
 * mocked Cordis context: every module in each plugin's import graph must
 * resolve, and each `apply` must register its listeners without throwing.
 *
 * This is a module-graph / registration check, NOT a functional harness test.
 *
 * Run: node D:\deepseek-harness-plugins\exploration\fc-plugin-load-probe.mjs
 */

const ROOT = new URL('../', import.meta.url)

function mockCtx() {
  const listeners = []
  const effects = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    get: () => undefined,
    on: (name, fn) => { listeners.push(name); void fn },
    effect: (fn) => { effects.push(fn) },
    listeners,
    effects,
  }
  return ctx
}

let failed = false
function check(name, ok, detail = '') {
  if (!ok) failed = true
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── dsh-force-compact ──────────────────────────────────────────────────────
console.log('— dsh-force-compact —')
{
  const mod = await import(new URL('dsh-force-compact/index.js', ROOT))
  check('exports apply/name', typeof mod.apply === 'function' && typeof mod.name === 'string')
  const ctx = mockCtx()
  let threw
  try { mod.apply(ctx) } catch (e) { threw = e }
  check('apply does not throw', threw === undefined, threw && threw.message)
  const want = ['agent/request', 'agent/pre-step', 'agent/status', 'session/flush']
  for (const name of want) check(`registered ${name}`, ctx.listeners.includes(name))
}

// ── dsh-web-ding ───────────────────────────────────────────────────────────
console.log('— dsh-web-ding —')
{
  const mod = await import(new URL('dsh-web-ding/index.js', ROOT))
  check('exports apply/name', typeof mod.apply === 'function' && typeof mod.name === 'string')
  const ctx = mockCtx()
  let threw
  try { mod.apply(ctx) } catch (e) { threw = e }
  check('apply does not throw', threw === undefined, threw && threw.message)
  check('registered agent/status', ctx.listeners.includes('agent/status'))
}

// ── dsh-local-no-auth ──────────────────────────────────────────────────────
console.log('— dsh-local-no-auth —')
{
  const mod = await import(new URL('dsh-local-no-auth/index.js', ROOT))
  check('exports apply/name/inject', typeof mod.apply === 'function' && typeof mod.name === 'string' && Array.isArray(mod.inject))
  const connection = {
    requestRejection: () => 401,
    authorizeIndex: () => false,
    authenticatedUrl: (u) => `${u}?token=secret`,
  }
  const ctx = {
    connection,
    webServer: { host: '127.0.0.1' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (name, fn) => { if (name === 'dispose') ctx._dispose = fn },
  }
  let threw
  try { mod.apply(ctx) } catch (e) { threw = e }
  check('apply does not throw', threw === undefined, threw && threw.message)
  check('requestRejection bypassed', connection.requestRejection() === undefined)
  check('authorizeIndex bypassed', connection.authorizeIndex() === true)
  check('authenticatedUrl clean', connection.authenticatedUrl('http://x') === 'http://x')
  if (typeof ctx._dispose === 'function') {
    ctx._dispose()
    check('dispose restores originals', connection.requestRejection() === 401 && connection.authorizeIndex() === false)
  } else {
    check('dispose hook registered', false)
  }
}

console.log(failed ? '\nPROBE FAILED' : '\nPROBE PASSED')
process.exit(failed ? 1 : 0)
