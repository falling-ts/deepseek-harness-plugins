'use strict';
// Replay selectRetainingLatestTokens for session e6f6b64f AT THE MOMENT OF
// COMPACTION (before seq 2835), using the SAME measurement the live run had:
// we approximate node prices via the vendor estimator if reachable; otherwise
// we reproduce just the SNAP decision using the pairing ledger on the real
// sparse surface, asking: for endIdx candidates near the raw crossing, which
// positions are balanced?
import http from 'http';
import { toolPairingBalancedAfterSafe } from '../dsh-force-compact/src/core/pairing.js';
const PORT = 3180, SID = 'session-e6f6b64f-7067-4c98-9706-45d74b28dae5';
function rpc(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'probe-' + Date.now(), method, payload });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

const resp = await rpc('session.history', { sessionId: SID });
const evs = (resp.result.value.events || []).map(r => r.event);
console.log('events:', evs.length);

// Reconstruct the PRE-COMPACTION surface: walk the log applying appends and
// replaces up to (excluding) seq 2835.
const SURFACE = new Set(['user/message','assistant/message','tool/result']);
const nodes = []; // seq values in surface order
for (const ev of evs) {
  if (ev.seq >= 2835) break;
  const eligible = SURFACE.has(ev.type) && ev.surfaceOp !== undefined;
  if (!eligible) continue;
  const op = ev.surfaceOp;
  if (op === 'append') { nodes.push(ev.seq); continue; }
  // replace op {op:'replace',start,end}: remove existing nodes whose seq falls
  // within [start,end]? NO — semantics: op.start/op.end are SEQ bounds naming
  // the range being shadowed. Remove those, then append THIS node's seq.
  if (op && op.op === 'replace') {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i] >= op.start && nodes[i] <= op.end) nodes.splice(i, 1);
    }
    nodes.push(ev.seq);
  }
}
console.log('pre-compaction surface nodes:', nodes.length);
console.log('node[0]=', nodes[0], 'node[last]=', nodes[nodes.length-1]);
console.log('nodes around the commit range [7..798]:', nodes.filter(n => n <= 800).slice(-10).join(','));

const session = { events: evs, surface: { nodes, replaceGeneration: 1 } };

// Which of the trailing surface nodes (positions near where a budget=8000
// crossing lands) are BALANCED-AFTER? Print the last 25 nodes' balance flags.
const tail = nodes.slice(-25);
console.log('\npos  seq   balAfterAfter?  type-of-that-event');
tail.forEach((seq, k) => {
  const pos = nodes.length - 25 + k;
  let flag;
  try { flag = toolPairingBalancedAfterSafe(session, seq); } catch (e) { flag = 'THREW: ' + e.message; }
  console.log(String(pos).padStart(3), ' ' + String(seq).padStart(5), ' ', String(flag).padEnd(13), evs[seq] ? evs[seq].type : '(log-only gap?)');
});
