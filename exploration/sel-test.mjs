#!/usr/bin/env node
/** Offline repro: feed selectRetainingLatestTokens the REAL per-node meter prices
 *  reconstructed from the persisted history (using the meter's own calibration is
 *  impossible offline, so approximate with the documented char/4 heuristic BUT
 *  also test a "meter sees more than chars" scenario). Show exactly where the
 *  cutoff lands for budget=8000 under several price vectors. */
'use strict';
const { selectRetainingLatestTokens } = await import('file:///D:/deepseek-harness-plugins/dsh-force-compact/src/engine/region.js');

// Tail layout measured from the live session (chronological, oldest→newest within the tail window).
// Positional order matters: measurement.nodes is head-to-tail.
// We reconstruct the 18-node surface as reported: positions 0..17, with the
// tail (positions ~5..17) being the seqs 95,263,265,267,393,396,397,710,712,1116,1119,1121, then 11,12,13,14.
const layout = [
  { label: 'head-anc', seq: 11, chars: 398 },    // actually these two sit INSIDE the tail zone positionally!
  { label: 'head-anc2', seq: 12, chars: 18094 },
  { label: 'head-anc3', seq: 13, chars: 390 },
  { label: 'head-anc4', seq: 14, chars: 4602 },
];

// Simpler: use the EXACT tail masses printed by span-at-compress.cjs (in chronological order),
// prefixed by whatever older nodes existed. We know the walk started at seq=14 (newest) and
// the result was tailStart at seq=11's index. Build a minimal 18-node vector matching what
// the meter likely saw: scale factor k multiplies chars/4 to emulate the meter's richer pricing.
async function trial(k, note) {
  // Chronological array, NEWEST LAST (matching measurement.nodes ordering).
  const rows = [
    { seq: 95, chars: 3838 * 4 },   // 95x4≈raw chars
  ].map(r => ({ ...r }))
  const tailChrono = [
    { seq: 95, c: 15352 },
    { seq: 263, c: 800 },
    { seq: 265, c: 2272 },
    { seq: 267, c: 9344 },
    { seq: 393, c: 580 },
    { seq: 396, c: 22020 },
    { seq: 397, c: 22532 },
    { seq: 710, c: 1352 },
    { seq: 712, c: 1168 },
    { seq: 1116, c: 1700 },
    { seq: 1119, c: 180 },
    { seq: 1121, c: 19760 },
    { seq: 11, c: 398 },
    { seq: 12, c: 18094 },
    { seq: 13, c: 390 },
    { seq: 14, c: 4602 },
  ]
  const nodes = tailChrono.map(r => ({ seq: r.seq, tokens: Math.ceil((r.c / 4) * k) }))
  const sessionLike = { events: [] /* userMessageEventSeqs needs events; synthesize user/message markers */ , surface: { nodes: nodes.map(n => n.seq) } }
  // Synthesize events so userMessageSeqs recognizes the four newest user msgs (11,12,13,14).
  const evts = []
  for (let s = 0; s < 2000; s++) evts.push(null)
  for (const r of [{ seq: 11 }, { seq: 12 }, { seq: 13 }, { seq: 14 }]) evts[r.seq] = { type: 'user/message', data: { content: [] } }
  sessionLike.events = evts

  const res = selectRetainingLatestTokens(sessionLike, 8000, { nodes })
  console.log(`--- k=${k} (${note}) ---`)
  console.log('cumulative from tail:', tailChrono.map((r, i) => Math.ceil((r.c / 4) * k)).reverse()
    .reduce((acc, t, i) => (acc.push(acc[0] + t), acc), []).join(' → '))
  console.log('RESULT:', JSON.stringify(res))
}

await trial(1, 'chars/4 heuristic as-is')
await trial(1.8, 'meter ~1.8× chars (typical zh/mixed overhead)')
await trial(3, 'meter 3× chars (worst-case dense content)')
