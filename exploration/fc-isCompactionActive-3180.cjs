#!/usr/bin/env node
/**
 * Focused test for `isCompactionActive(session)` — the "is the current session
 * genuinely compacting?" detector used by the per-model-request guard to tell a
 * GENUINE in-progress [强制压缩中>>>] banner (preserve) apart from STALE residue
 * (safe to override).
 *
 * Constructs synthetic sessions (modern `snapshotEvents()` shape) and asserts the
 * detector's verdict across every branch:
 *   1. open `compaction/start`, no later end-seed      → TRUE  (genuinely in flight)
 *   2. closed bracket (start + end)                    → FALSE (committed)
 *   3. orphan start cleared by a LATER end-seed        → FALSE (constructor-inherited, ignored)
 *   4. no compaction events                            → FALSE (never compacted)
 *   5. open start with a turn/start after it (no seed) → TRUE  (turn doesn't clear the lock)
 *   6. malformed session (null)                        → FALSE (degrades safely)
 */
const path = require('node:path')
const fs = require('node:fs')

const BUILTIN = path.join(__dirname, '..', 'dsh-force-compact', 'src', 'engine', 'builtin.js')

// Load the ESM module via dynamic import (plain JS, no build step).
let isCompactionActive
try {
  // builtin.js is ESM; require() can't load it directly. Use a small ESM loader bridge.
} catch {}

async function main() {
  const mod = await import(pathToFileURL(BUILTIN))
  isCompactionActive = mod.isCompactionActive
  if (typeof isCompactionActive !== 'function') {
    console.error('FAIL: isCompactionActive is not exported as a function (got', typeof isCompactionActive, ')')
    process.exit(1)
  }

  // Helper: build a synthetic session whose snapshotEvents() returns the given rows.
  const fake = (rows) => ({ snapshotEvents: () => rows, eventAt: (seq) => rows[seq] })
  const ev = (type, seq, data) => ({ type, seq, data: data === undefined ? undefined : data })

  const cases = [
    {
      name: '1. open compaction/start, no end-seed',
      session: fake([ev('turn/start', 0, { turn: 1 }), ev('compaction/start', 3), ev('user/message', 4)]),
      expected: true,
    },
    {
      name: '2. closed bracket (start + end)',
      session: fake([ev('compaction/start', 2), ev('compaction/summary', 3), ev('compaction/end', 4)]),
      expected: false,
    },
    {
      name: '3. orphan start cleared by LATER end-seed',
      session: fake([ev('compaction/start', 5), ev('session/end-seed', 20)]),
      expected: false,
    },
    {
      name: '4. no compaction events',
      session: fake([ev('user/message', 0), ev('assistant/message', 1)]),
      expected: false,
    },
    {
      name: '5. open start + turn/start after (no seed)',
      session: fake([ev('compaction/start', 1), ev('turn/start', 2, { turn: 2 })]),
      expected: true,
    },
    {
      name: '6. malformed session (null)',
      session: null,
      expected: false,
    },
  ]

  let failed = 0
  for (const c of cases) {
    let actual
    try {
      actual = isCompactionActive(c.session)
    } catch (e) {
      actual = 'THREW: ' + e.message
    }
    const ok = actual === c.expected
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expected}, got ${actual})`)
  }

  console.log('\n=== ' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' ===')
  process.exit(failed === 0 ? 0 : 1)
}

function pathToFileURL(p) {
  // Windows path → file:/// URL
  const norm = p.replace(/\\/g, '/')
  return 'file:///' + norm
}

main().catch(e => { console.error('ERR', e.message); process.exit(1) })
