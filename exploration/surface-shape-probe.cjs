'use strict';
// Probe: dump the SHAPES of `session.surface.nodes` and `measurement.nodes`
// as seen from the wire (session.history), to settle why the equality cross-check
// trips even when lengths agree. Run: node surface-shape-probe.cjs <port> <sessionId>
const http = require('http');
const PORT = parseInt(process.argv[2] || '3180', 10);
const SID = process.argv[3];
if (!SID) { console.error('usage: node surface-shape-probe.cjs <port> <sessionId>'); process.exit(2); }

function rpc(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'probe-' + Date.now() + '-' + method, method, payload });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function dump(label, sid) {
  const resp = await rpc('session.history', { sessionId: sid });
  const events = (resp.result && resp.result.value && resp.result.value.events) || [];
  console.log(`== ${label} (${sid}) events:`, events.length);
  for (let i = Math.max(0, events.length - 8); i < events.length; i++) {
    const ev = (events[i] && events[i].event) || events[i] || {};
    const extra = ev.surfaceOp ? ' surfaceOp=' + JSON.stringify(ev.surfaceOp) : '';
    const src = ev.data && ev.data.source ? ' source=' + JSON.stringify(ev.data.source) : '';
    const keys = ev.data ? ' dataKeys=[' + Object.keys(ev.data).join(',') + ']' : '';
    console.log(`#${i}`, ev.type, 'seq=' + ev.seq + extra + src + keys);
  }
}

(async () => {
  await dump('requested', SID);
  // Also dump the busiest other session for contrast:
  const listResp = await rpc('session.list', {});
  const rows = (listResp.result && listResp.result.value) || [];
  const others = rows.map(x => ({ id: x.sessionId || x.id, n: x.eventCount }))
    .filter(o => o.id !== SID)
    .sort((a, b) => (b.n || 0) - (a.n || 0));
  if (others.length > 0) await dump('contrast', others[0].id);
})();
