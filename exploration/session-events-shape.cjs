'use strict';
// Confirm: is the LIVE session's `events` array dense-by-seq (events[i].seq === i)?
// and does `session.surface.nodes[i] === i` hold for the pre-compaction head?
// We drive this through the wire: fetch full history, then compare node-order vs seq-order.
// Run: node session-events-shape.cjs <port> <sessionId>
const http = require('http');
const PORT = parseInt(process.argv[2] || '3180', 10);
const SID = process.argv[3];
if (!SID) { console.error('usage: node session-events-shape.cjs <port> <sessionId>'); process.exit(2); }
function rpc(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'probe-' + Date.now(), method, payload });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
(async () => {
  const resp = await rpc('session.history', { sessionId: SID });
  const wrapper = (resp.result && resp.result.value) || {};
  // The wire double-wraps: value.events is [{event:{...}}]
  const rawEvents = wrapper.events || wrapper.session || [];
  const evs = rawEvents.map(r => r.event || r);
  console.log('wire events:', evs.length);
  // density check: is evs[i].seq === i for ALL?
  let dense = true, firstBad = -1;
  for (let i = 0; i < evs.length; i++) { if (evs[i].seq !== i) { dense = false; firstBad = i; break; } }
  console.log('events[i].seq === i for ALL?', dense, firstBad >= 0 ? `(first mismatch at i=${firstBad}, got seq=${evs[firstBad].seq})` : '');
  // Now simulate surface: collect seqs of surface-eligible types in LOG ORDER.
  const SURFACE = new Set(['user/message','assistant/message','tool/result']);
  const surfSeqsInLogOrder = evs.filter(e => SURFACE.has(e.type)).map(e => e.seq);
  console.log('surface-eligible events in log order:', surfSeqsInLogOrder.length);
  // Are they contiguous-from-0 in the head? Print first 12 and last 8.
  console.log('  head 12:', surfSeqsInLogOrder.slice(0,12).join(','));
  console.log('  tail 8:', surfSeqsInLogOrder.slice(-8).join(','));
  // Crucial: is surface ORDER === ascending seq in the head portion? Find longest
  // prefix of surfSeqsInLogOrder that equals its own rank (i.e. strictly increasing by 1 from 0).
  let prefixAligned = 0;
  for (let i = 0; i < surfSeqsInLogOrder.length; i++) {
    if (surfSeqsInLogOrder[i] !== i) { prefixAligned = i; break; }
    if (i === surfSeqsInLogOrder.length - 1) prefixAligned = surfSeqsInLogOrder.length;
  }
  console.log('longest prefix where surfacePos(i)===seq(i):', prefixAligned, 'of', surfSeqsInLogOrder.length);
  if (prefixAligned < surfSeqsInLogOrder.length) {
    console.log('  around divergence (pos,seq) pairs:', JSON.stringify(Array.from({length:Math.min(10,surfSeqsInLogOrder.length-prefixAligned)}, (_,k)=>{const p=prefixAligned+k;return [p, surfSeqsInLogOrder[p]];}).slice(0,10)));
  }
})();
