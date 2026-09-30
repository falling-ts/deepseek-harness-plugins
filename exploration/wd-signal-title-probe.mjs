/**
 * wd-signal-title-probe.mjs — the host half's turn-end signal contract.
 *
 * Loads the REAL `src/hooks/idle.js` + `src/core/signal.js` (plain ESM, no bundling) against a
 * stub cordis ctx and pins what the browser receives:
 *
 *   • the session display title is read on the HOST from the `sessionProjections` `title`
 *     unit and rides the `signal` payload — the client half never fetches it (no RPC, no
 *     hand-minted rpcId in a cosmetic path);
 *   • the write still lands on the `falling-ts-web-ding` namespace's single `signal` field;
 *   • the idle-TRANSITION latches still hold (a fresh session that never ran stays silent, a
 *     repeated idle tick does not re-ding, `turnEndEnabled=false` publishes nothing);
 *   • every degradation (no registry, unfolded unit, throwing snapshot, empty/non-string
 *     title) publishes an untitled signal instead of throwing or skipping the ding.
 *
 * Usage: node exploration/wd-signal-title-probe.mjs
 */
const IDLE = new URL('../dsh-web-ding/src/hooks/idle.js', import.meta.url)
const SETTINGS = new URL('../dsh-web-ding/src/core/settings.js', import.meta.url)

const { handleAgentStatus } = await import(IDLE)
const { bindConfig } = await import(SETTINGS)

let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}

/** Recorded `settings.update(ns, patch)` calls of the case in flight. */
let updates = []

/**
 * Build a stub ctx. `projections` is whatever `ctx.get('sessionProjections')` should answer
 * for the case (undefined = service absent, a throwing snapshot, etc.).
 */
function makeCtx(projections, { updateFails = false } = {}) {
  return {
    get(name) {
      if (name === 'settings') {
        return {
          update: async (ns, patch) => {
            if (updateFails) throw new Error('settings write rejected')
            updates.push({ ns, patch })
          },
        }
      }
      if (name === 'sessionProjections') return projections
      return undefined
    },
    logger: { debug: () => {}, warn: () => {} },
  }
}

/** A live session handle plus the projections service that knows its title. */
const sessionWith = (id, title) => {
  const session = { id }
  return {
    session,
    projections: { snapshot: (subject) => (subject === session ? { values: { title } } : { values: {} }) },
  }
}

const reset = () => { updates = [] }
bindConfig({ turnEndEnabled: { get: () => true } })

// ── A. running → idle publishes one signal carrying the host-read title ──────
reset()
{
  const { session, projections } = sessionWith('s-title', '画饼会话')
  const ctx = makeCtx(projections)
  await handleAgentStatus(ctx, { agent: { session }, status: 'running' })
  check('no signal on the running status', updates.length === 0, String(updates.length))
  await handleAgentStatus(ctx, { agent: { session }, status: 'idle' })
  check('idle transition published exactly one signal', updates.length === 1, String(updates.length))
  const patch = updates[0]?.patch ?? {}
  check('the write targets only the signal field', Object.keys(patch).join(',') === 'signal', Object.keys(patch).join(','))
  check('the namespace is falling-ts-web-ding', updates[0]?.ns === 'falling-ts-web-ding', String(updates[0]?.ns))
  const signal = patch.signal ?? {}
  check('the signal phase is done', signal.phase === 'done', String(signal.phase))
  check('the signal carries the sessionId', signal.sessionId === 's-title', String(signal.sessionId))
  check('the signal carries the title read from sessionProjections', signal.title === '画饼会话', String(signal.title))
  check('the signal carries a numeric at', typeof signal.at === 'number' && Number.isFinite(signal.at), String(signal.at))
}

// ── B. repeated idle ticks do not re-ding ───────────────────────────────────
{
  const { session, projections } = sessionWith('s-title', '画饼会话')
  const ctx = makeCtx(projections)
  await handleAgentStatus(ctx, { agent: { session }, status: 'idle' })
  await handleAgentStatus(ctx, { agent: { session }, status: 'idle' })
  check('a repeated idle tick publishes nothing', updates.length === 1, String(updates.length))
}

// ── C. a fresh session that never ran stays silent ──────────────────────────
reset()
{
  const { session, projections } = sessionWith('s-fresh', 'New session')
  await handleAgentStatus(makeCtx(projections), { agent: { session }, status: 'idle' })
  check('the first idle of a never-running session stays silent', updates.length === 0, String(updates.length))
}

// ── D. turnEndEnabled=false gates the publish (host side) ───────────────────
reset()
{
  const { session, projections } = sessionWith('s-off', 'Off')
  const ctx = makeCtx(projections)
  bindConfig({ turnEndEnabled: { get: () => false } })
  await handleAgentStatus(ctx, { agent: { session }, status: 'running' })
  await handleAgentStatus(ctx, { agent: { session }, status: 'idle' })
  check('turnEndEnabled=false publishes nothing', updates.length === 0, String(updates.length))
  bindConfig({ turnEndEnabled: { get: () => true } })
}

// ── E. degradation: the title is optional, the ding is not ──────────────────
const degradations = [
  ['projections service absent', undefined],
  ['projections has no snapshot()', {}],
  ['snapshot throws', { snapshot: () => { throw new Error('projection exploded') } }],
  ['snapshot has no values', { snapshot: () => ({}) }],
  ['title is not folded yet', { snapshot: () => ({ values: {} }) }],
  ['title is blank', { snapshot: () => ({ values: { title: '   ' } }) }],
  ['title is not a string', { snapshot: () => ({ values: { title: 42 } }) }],
]
for (const [label, projections] of degradations) {
  reset()
  const session = { id: `s-${label.replace(/\W+/gu, '-')}` }
  const ctx = makeCtx(projections)
  await handleAgentStatus(ctx, { agent: { session }, status: 'running' })
  await handleAgentStatus(ctx, { agent: { session }, status: 'idle' })
  const signal = updates[0]?.patch?.signal
  check(`${label}: the ding still publishes`, updates.length === 1 && signal?.phase === 'done', JSON.stringify(updates))
  check(`${label}: no title key is emitted`, signal !== undefined && !('title' in signal), JSON.stringify(signal))
}

// ── F. a failing settings write is swallowed (cosmetic path) ────────────────
reset()
{
  const { session, projections } = sessionWith('s-fail', 'Failing write')
  await handleAgentStatus(makeCtx(projections, { updateFails: true }), { agent: { session }, status: 'running' })
  await handleAgentStatus(makeCtx(projections, { updateFails: true }), { agent: { session }, status: 'idle' })
  check('a rejected settings write does not throw out of the listener', true)
}

// ── G. at is monotonic across two publishes in the same millisecond ─────────
reset()
{
  const first = sessionWith('s-mon-1', 'One')
  const second = sessionWith('s-mon-2', 'Two')
  await handleAgentStatus(makeCtx(first.projections), { agent: { session: first.session }, status: 'running' })
  await handleAgentStatus(makeCtx(first.projections), { agent: { session: first.session }, status: 'idle' })
  await handleAgentStatus(makeCtx(second.projections), { agent: { session: second.session }, status: 'running' })
  await handleAgentStatus(makeCtx(second.projections), { agent: { session: second.session }, status: 'idle' })
  const [a, b] = updates.map((u) => u.patch.signal.at)
  check('two publishes never collide on at', typeof a === 'number' && typeof b === 'number' && b > a, `${a} -> ${b}`)
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
