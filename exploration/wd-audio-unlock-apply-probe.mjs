// Load probe for the dsh-web-ding client half's AUDIO path.
//
// It evaluates web/client.js exactly the way the browser module loader does
// (`window.__ModuleLoader__.load({ id, factory })`), runs `apply(ctx)` against a stub
// context, and drives the settings snapshot to fire the turn-end ding against a stubbed
// AudioContext. It pins the contract that makes a ding audible in an embedded window
// (WebView2 / Pake), where the AudioContext is created WITHOUT a user gesture and therefore
// starts `suspended`:
//
//   • a signal arriving while the context is suspended must RESUME first and only then
//     schedule the tone against the post-resume timeline (scheduling on a frozen
//     currentTime is what makes "signal arrives, toast shows, no sound" happen);
//   • a refused resume must stay silent rather than throw or queue a stale tone;
//   • the unlock listeners are capture-phase, multi-gesture and re-armed (not `{once:true}`),
//     so a missed first gesture or a UI that stops propagation cannot disable audio forever;
//   • the unlock listeners are FACTORY-FREE and APPLY-OWNED: evaluating the factory registers
//     nothing, `apply` owns them through `ctx.effect`, and that effect's disposer removes
//     every listener (ui-plugin.md: factories stay free of side effects);
//   • the client half is a pure mirror of the settings namespace: the session title rides the
//     signal payload and the browser performs NO RPC of its own (no hand-minted rpcId).
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../dsh-web-ding/web/client.js', import.meta.url), 'utf8')

// ── window / DOM stubs ───────────────────────────────────────────────────────
const listeners = []
const removals = []
const fetchCalls = []
const storage = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { globalThis.__loaded = spec } },
  addEventListener: (type, handler, options) => { listeners.push({ type, handler, options }) },
  removeEventListener: (type, handler, options) => { removals.push({ type, handler, options }) },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
  },
  setTimeout: () => 0,
  clearTimeout: () => {},
  crypto: { randomUUID: () => 'uuid-stub' },
  location: { origin: 'http://127.0.0.1:3080' },
}
globalThis.location = globalThis.window.location
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url))
  return { json: async () => ({ result: { ok: true, value: { items: [] } } }) }
}
globalThis.document = {
  body: { contains: () => false, appendChild: () => {} },
  head: { appendChild: () => {} },
  getElementById: () => null,
  createElement: () => ({ style: {}, addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {} }),
  querySelectorAll: () => [],
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }

// ── AudioContext stub ───────────────────────────────────────────────────────
let audioStats
class StubAudioContext {
  constructor() {
    this.state = audioStats.startState
    this.currentTime = 0
    this.destination = {}
    audioStats.created += 1
    audioStats.instances.push(this)
  }
  createOscillator() {
    const stats = audioStats
    return {
      type: 'sine',
      frequency: { setValueAtTime: () => {} },
      connect: () => {},
      start: (at) => { stats.oscillators.push({ at, state: this.state, currentTime: this.currentTime }) },
      stop: () => {},
    }
  }
  createGain() {
    return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }
  }
  resume() {
    const stats = audioStats
    stats.resumes += 1
    if (stats.resumeOutcome === 'reject') return Promise.reject(new Error('NotAllowedError'))
    return new Promise((resolve) => {
      // unlock happens asynchronously, exactly like a real resume()
      queueMicrotask(() => {
        if (this.state === 'closed') { resolve(); return }
        this.state = 'running'
        this.currentTime = 5.0
        stats.stateChanges.push('running')
        resolve()
      })
    })
  }
}
window.AudioContext = StubAudioContext

// ── module loader + ctx stub ────────────────────────────────────────────────
new Function(SRC)()
const loaded = globalThis.__loaded
if (loaded === null || loaded === undefined) throw new Error('module loader was never called')
const face = loaded.factory((id) => {
  if (id === 'react') return { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {} }
  if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (init) => ({ update: (f) => f(init), getSnapshot: () => init }) }
  throw new Error(`unexpected require("${id}")`)
})
// Factory purity: evaluating the factory must register NOTHING; listeners belong to apply.
const factoryListenerCount = listeners.length

let snapshot = { status: 'ready', value: { turnEndEnabled: true, turnEndVolume: 1, turnEndFreq: 880, turnEndDecayMs: 900, signal: { phase: 'done', at: 1000 } }, writable: true }
let onSnapshot = () => {}
const effects = []
const ctx = {
  effect: (body) => { const dispose = body(); effects.push(dispose); return dispose },
  locale: { bind: () => (key) => key, register: () => () => {}, addLanguage: () => () => {} },
  configForms: {
    get: () => ({
      getSnapshot: () => snapshot,
      subscribe: (callback) => { onSnapshot = callback; return () => { onSnapshot = () => {} } },
      set: () => Promise.resolve(true), unset: () => Promise.resolve(true),
    }),
  },
  slots: { inject: (_name, callback) => callback(), register: () => () => {} },
  logger: { debug: () => {}, warn: () => {} },
}
// ── assertion helpers (defined before apply: the load-time residue must be observable) ──
let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}

/** The cached turn-end records, newest first (see `recordTurnEnd` + `saveNotifyCache`). */
const cachedRecords = () => {
  try { return JSON.parse(storage.get('falling-ts-web-ding.notify.v1') ?? '[]') } catch { return [] }
}

// A live audioStats object from the start, so a ding fired by the load-time residue would be
// recorded rather than lost.
audioStats = { created: 0, resumes: 0, oscillators: [], stateChanges: [], resumeOutcome: 'ok', startState: 'suspended', instances: [] }
face.apply(ctx)
// The namespace opens on a RESIDUE (`signal.at = 1000`, written before this page load):
// the first frame must establish the baseline without playing it.
check('a residue done signal present at load does not play', audioStats.oscillators.length === 0 && audioStats.created === 0, JSON.stringify(audioStats))

// ── assertions ──────────────────────────────────────────────────────────────
const listenerCalls = []
const reset = (resumeOutcome, startState = 'suspended') => {
  // Closing every known context forces the plugin's cached AudioContext to be rebuilt,
  // so each case starts from a genuinely fresh context.
  for (const instance of audioStats.instances) instance.state = 'closed'
  audioStats = { created: 0, resumes: 0, oscillators: [], stateChanges: [], resumeOutcome, startState, instances: [] }
  listenerCalls.length = 0
}

// A. listener registration shape + ownership (factory-free, apply-owned)
check('factory evaluation registered no listener (side-effect free)', factoryListenerCount === 0, String(factoryListenerCount))
check('unlock listeners registered', listeners.length >= 5, String(listeners.length))
check('all unlock listeners are capture-phase', listeners.every((l) => l.options?.capture === true), JSON.stringify(listeners.map((l) => l.options)))
check('no unlock listener is one-shot', listeners.every((l) => l.options?.once !== true), JSON.stringify(listeners.map((l) => l.options)))
check('several gesture types covered', ['pointerdown', 'keydown', 'click', 'touchstart', 'focus'].every((t) => listeners.some((l) => l.type === t)), JSON.stringify(listeners.map((l) => l.type)))

// B. signal while suspended → resume first, schedule after, on the post-resume timeline
reset('ok')
snapshot = { ...snapshot, value: { ...snapshot.value, signal: { phase: 'done', at: 2000, sessionId: 'sid-1', title: '画饼会话' } } }
onSnapshot()
await new Promise((r) => setTimeout(r, 0))
check('suspended ding resumed the context', audioStats.resumes === 1, String(audioStats.resumes))
check('the context reached running', audioStats.stateChanges.includes('running'), JSON.stringify(audioStats.stateChanges))
check('tone scheduled after the resume (3 oscillators)', audioStats.oscillators.length === 3, String(audioStats.oscillators.length))
check('oscillators scheduled on the running timeline', audioStats.oscillators.every((o) => o.state === 'running' && o.at >= 5.0), JSON.stringify(audioStats.oscillators))
check('toast/cache path still ran', storage.has('falling-ts-web-ding.notify.v1'), [...storage.keys()].join(','))
check('the signal title reaches the cached record', cachedRecords()[0]?.title === '画饼会话', JSON.stringify(cachedRecords()[0]))
check('the sessionId still reaches the cached record', cachedRecords()[0]?.sessionId === 'sid-1', JSON.stringify(cachedRecords()[0]))
check('the client half performs no RPC of its own', fetchCalls.length === 0, fetchCalls.join(','))

// C. running context → immediate schedule, no extra resume
check('running ding schedules immediately', audioStats.oscillators.length === 3)
const resumesBefore = audioStats.resumes
snapshot = { ...snapshot, value: { ...snapshot.value, signal: { phase: 'done', at: 3000 } } }
onSnapshot()
check('no resume needed once running', audioStats.resumes === resumesBefore, String(audioStats.resumes))
check('second ding scheduled 3 more oscillators', audioStats.oscillators.length === 6, String(audioStats.oscillators.length))

// D. refused resume stays silent and never throws
reset('reject')
snapshot = { ...snapshot, value: { ...snapshot.value, signal: { phase: 'done', at: 4000 } } }
onSnapshot()
await new Promise((r) => setTimeout(r, 5))
check('refused unlock did not schedule a tone', audioStats.oscillators.length === 0, String(audioStats.oscillators.length))
check('refused unlock did not throw', true)
check('refused unlock still answered the signal (cache written)', storage.has('falling-ts-web-ding.notify.v1'))
check('a signal without a title still records the turn end', cachedRecords()[0]?.at === 4000 && cachedRecords()[0]?.title === undefined, JSON.stringify(cachedRecords()[0]))

// E. re-armed warmup: a later gesture still unlocks (fresh suspended context)
reset('ok', 'suspended')
listeners[0].handler()
await new Promise((r) => setTimeout(r, 5))
check('a later gesture resumed the still-suspended context', audioStats.resumes === 1, String(audioStats.resumes))
check('the gesture created a fresh context', audioStats.created === 1, String(audioStats.created))
check('that gesture left the context running', audioStats.stateChanges.includes('running'), JSON.stringify(audioStats.stateChanges))

// F. once running, gestures short-circuit
reset('ok', 'running')
listeners[0].handler()
check('warmup short-circuits once running', audioStats.resumes === 0, String(audioStats.resumes))

// H. a residue-FREE namespace must still play its FIRST done signal.
//    A second, independent module instance (fresh factory closure state) whose namespace
//    never carried a signal: the first-frame baseline must be 0, not "swallow whatever
//    arrives first" — otherwise a brand-new install stays silent until the second turn ends.
storage.clear()
new Function(SRC)()
const face2 = globalThis.__loaded.factory((id) => {
  if (id === 'react') return { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {} }
  if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (init) => ({ update: (f) => f(init), getSnapshot: () => init }) }
  throw new Error(`unexpected require("${id}")`)
})
let snapshot2 = { status: 'ready', value: { turnEndEnabled: true, turnEndVolume: 1, turnEndFreq: 880, turnEndDecayMs: 900 }, writable: true }
let onSnapshot2 = () => {}
const ctx2 = {
  effect: (body) => { const dispose = body(); effects.push(dispose); return dispose },
  locale: { bind: () => (key) => key, register: () => () => {}, addLanguage: () => () => {} },
  configForms: {
    get: () => ({
      getSnapshot: () => snapshot2,
      subscribe: (callback) => { onSnapshot2 = callback; return () => { onSnapshot2 = () => {} } },
      set: () => Promise.resolve(true), unset: () => Promise.resolve(true),
    }),
  },
  slots: { inject: (_name, callback) => callback(), register: () => () => {} },
  logger: { debug: () => {}, warn: () => {} },
}
face2.apply(ctx2)
reset('ok')
check('a residue-free namespace plays nothing at load', audioStats.oscillators.length === 0 && audioStats.created === 0, JSON.stringify(audioStats))
snapshot2 = { ...snapshot2, value: { ...snapshot2.value, signal: { phase: 'done', at: 7, sessionId: 'first-ever', title: '第一次' } } }
onSnapshot2()
await new Promise((r) => setTimeout(r, 0))
check('the FIRST done signal of a residue-free namespace plays', audioStats.oscillators.length === 3, String(audioStats.oscillators.length))
check('that first ding still records the turn end', cachedRecords()[0]?.at === 7 && cachedRecords()[0]?.title === '第一次', JSON.stringify(cachedRecords()[0]))
check('that first page performs no RPC either', fetchCalls.length === 0, fetchCalls.join(','))

// G. apply-owned disposal: every unlock listener leaves with the plugin, same capture flag
const registeredCount = listeners.length
const removalsBefore = removals.length
for (const dispose of effects) { if (typeof dispose === 'function') dispose() }
check('an apply-owned disposer removed every unlock listener',
  removals.length - removalsBefore === registeredCount, `${removals.length - removalsBefore} of ${registeredCount}`)
check('removal reuses the capture flag used at registration',
  removals.every((r) => r.options?.capture === true) && removals.every((r) => listeners.some((l) => l.type === r.type)), JSON.stringify(removals.map((r) => r.type)))

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
