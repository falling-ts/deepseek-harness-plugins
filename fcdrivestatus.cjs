#!/usr/bin/env node
/**
 * Drive the "Deep diving..." TurnStatus indicator on a live GUI instance.
 *
 * Verbs (positional args after PORT; default "all"):
 *   smoke       ping session.list and print the session table.
 *   anchor      read the newest open turn's turn/start timestamp for the
 *               target session — the EXACT moment the indicator's clock
 *               counts from (ChatView runningTurnStartTime).
 *   appear      queue a multi-step prompt so running=true persists long
 *               enough for the indicator to show; poll session.list until
 *               the row reports running, then wait past the 15s clock
 *               threshold so the elapsed counter is also visible.
 *   disappear   poll session.list until running flips false (indicator
 *               unmounts).
 *   cancel      stop whatever turn is driving the indicator NOW
 *               (session.cancel) — instant disappearance, no polling.
 *   relabel     print ready-to-paste DevTools snippet that swaps the
 *               label text at runtime (React re-render restores it).
 *
 * Target selection: --sid=<id> targets one session explicitly; otherwise
 * the newest running session wins, else the newest session overall.
 *
 * Usage: node fcdrivestatus.cjs [PORT] [--sid=X] [verbs...]
 * Example: node fcdrivestatus.cjs 3080 --sid=session-aeb1c9da… appear
 */
'use strict'

const argv = process.argv.slice(2)
let portArg = null
let sidOverride = null
const verbs = new Set()
for (const a of argv) {
  if (a.startsWith('--sid=')) sidOverride = a.slice(6)
  else if (/^\d+$/.test(a) && portArg === null) portArg = a
  else verbs.add(a)
}
const PORT = parseInt(portArg || '3080', 10)
const BASE = 'http://127.0.0.1:' + PORT
const ALL = verbs.size === 0 || verbs.has('all')
const W = v => ALL || verbs.has(v)

let rpcSeq = 0
async function rpc(method, payload) {
  const rpcId = 'fcdrv-' + (++rpcSeq) + '-' + Date.now().toString(36)
  // URL segment joins the two parts with a DOT; the method FIELD joins them
  // with a SLASH — both required by the bridge.
  // Bridge validates method FIELD === PATH SEGMENT (both dotted form):
  // POST /api/session.list with {"method":"session.list"} — a slash field
  // ("session/list") is rejected as a mismatch.
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(method + ' → HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 400))
  if (json.result && json.result.ok === false) {
    throw new Error(method + ' → ' + JSON.stringify(json.result).slice(0, 400))
  }
  return json.result ? json.result.value : undefined
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const fmtTs = n => n === undefined ? '?' : new Date(n).toLocaleTimeString()

async function pickTarget() {
  const rows = await rpc('session.list', {})
  const items = Array.isArray(rows) ? rows : (rows && (rows.sessions || rows.items || rows.rows)) || []
  if (!items.length) throw new Error('no sessions exist; create one first')
  if (sidOverride) {
    const hit = items.find(s => (s.sessionId || s.id) === sidOverride)
    if (!hit) throw new Error('session ' + sidOverride + ' not in catalog')
    return hit
  }
  const running = items.filter(s => s.running)
  const pool = running.length ? running : items
  // Newest = largest updatedAt/createdAt if present, else last in array.
  const sorted = [...pool].sort((a, b) =>
    ((b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)))
  return sorted[0]
}

async function newestOpenTurnStart(sid) {
  const h = await rpc('session.history', { sessionId: sid })
  const events = (h && (h.events || h.items)) || (Array.isArray(h) ? h : [])
  let best = null
  for (const ev of events) {
    const d = ev.event ?? ev
    const type = ev.type || d.type
    const data = ev.data ?? d.data ?? {}
    if (type === 'turn/start') {
      const t = (ev.time ?? d.time ?? data.time ?? data.start)
      const num = typeof t === 'number' ? t : (typeof t === 'object' && t && typeof t.time === 'number' ? t.time : NaN)
      if (!Number.isNaN(num) && (best === null || num > best)) best = num
    }
  }
  return best
}

async function main() {
  console.error('[drive] port ' + PORT + (sidOverride ? ' sid=' + sidOverride : '') + ' verbs=[' + [...(ALL ? ['smoke','anchor','appear','disappear','cancel','relabel'] : verbs)].join(',') + ']')

  const target = await pickTarget()
  const sid = target.sessionId || target.id
  console.error('[drive] target ' + sid + ' running=' + !!target.running + ' cwd=' + (target.cwd || '?'))

  if (W('smoke')) {
    const rows = await rpc('session.list', {})
    const items = Array.isArray(rows) ? rows : (rows && (rows.sessions || rows.items || rows.rows)) || []
    console.log(JSON.stringify(items.map(s => ({
      id: s.sessionId || s.id,
      running: !!s.running,
      cwd: s.cwd || null,
      updatedAt: s.updatedAt || null,
    })), null, 2))
  }

  if (W('anchor')) {
    const t = await newestOpenTurnStart(sid)
    console.log(JSON.stringify({
      sessionId: sid,
      turnStartEpochMs: t,
      turnStartWall: t === null ? null : new Date(t).toISOString(),
      note: t === null
        ? 'no turn/start in window (session idle, or outside loaded tail)'
        : 'clock displays elapsed since this moment; counter appears at 15s',
    }, null, 2))
  }

  if (W('appear')) {
    // A queue-mode prompt keeps the turn open across steps; the indicator
    // is visible for the WHOLE running span (first-token wait, tools, stream).
    const accepted = await rpc('session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [{
        type: 'text',
        text: '用 glob 列出工作区目录下最近修改的 5 个文件，只要文件名，逐行列出。',
      }],
    })
    console.error('[drive] queued; accepted=' + JSON.stringify(accepted && (accepted.accepted !== undefined ? accepted.accepted : accepted)).slice(0, 120))
    // Wait for running flag (up to 30s).
    const deadline = Date.now() + 30000
    let saw = false
    for (;;) {
      if (Date.now() > deadline) throw new Error('running flag did not appear within 30s')
      const rows = await rpc('session.list', {})
      const items = Array.isArray(rows) ? rows : (rows && (rows.sessions || rows.items || rows.rows)) || []
      const me = items.find(s => (s.sessionId || s.id) === sid)
      if (me && me.running) { saw = true; break }
      await sleep(500)
    }
    console.error('[drive] running=' + saw + ' — indicator now visible under the last node; clock joins at +15s')
  }

  if (W('cancel')) {
    const r = await rpc('session.cancel', { sessionId: sid })
    console.error('[drive] cancel → ' + JSON.stringify(r && (r.ok !== undefined ? r.ok : r)).slice(0, 200))
  }

  if (W('disappear')) {
    const deadline = Date.now() + 5 * 60 * 1000
    for (;;) {
      if (Date.now() > deadline) throw new Error('still running after 5min')
      const rows = await rpc('session.list', {})
      const items = Array.isArray(rows) ? rows : (rows && (rows.sessions || rows.items || rows.rows)) || []
      const me = items.find(s => (s.sessionId || s.id) === sid)
      if (me && !me.running) {
        console.error('[drive] idle — indicator unmounted at ' + new Date().toISOString())
        break
      }
      await sleep(1000)
    }
  }

  if (W('relabel')) {
    console.log(`// Paste into DevTools console ON THE GUI PAGE while the
// "Deep diving..." indicator is visible. React re-renders (next
// streaming frame) restore the original label — this is a transient
// cosmetic swap, not a source change.
(async () => {
  const els = [...document.querySelectorAll('div[role="status"][aria-live="polite"]')]
    .filter(d => d.textContent.startsWith('Deep diving'));
  if (!els.length) return 'not visible now (session idle?)';
  for (const d of els) for (const c of d.childNodes)
    if (c.nodeType === 3 && c.textContent.includes('Deep diving'))
      c.textContent = '⚡ 深挖中… ';
  return 'replaced in ' + els.length + ' element(s)';
})()`)
  }

  console.error('[drive] done')
}

main().catch(err => { console.error('[drive] FAILED:', err && err.message || err); process.exit(1) })
