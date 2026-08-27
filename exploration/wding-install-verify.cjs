// wding-install-verify.cjs — verify dsh-web-ding end-to-end on a live dev instance.
// Creates a session, prompts once, polls settings.describe until the host half
// publishes falling-ts-web-ding.signal = {phase:'done', ...} (idle transition),
// then prints the observed signal. Exit 0 on success.
// Usage: node exploration/wding-install-verify.cjs [http://127.0.0.1:3180] [timeoutSec=120]
const http = require('http');

const [,, base = 'http://127.0.0.1:3180', tsec = '120'] = process.argv;
const timeoutMs = Number(tsec) * 1000;
const NS = 'falling-ts-web-ding';

function post(path, method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'wv-' + Math.random().toString(36).slice(2), method, payload });
    const u = new URL(path, base);
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('bad json: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function describe() {
  const r = await post('/api/settings.describe', 'settings.describe', {});
  if (!r || !r.result || r.result.ok !== true) throw new Error('describe failed: ' + JSON.stringify(r).slice(0, 300));
  return r.result.value;
}

(async () => {
  const start = Date.now();
  // 1) create session
  const created = await post('/api/session.create', 'session.create', {});
  const sid = created && created.result && created.result.value && created.result.value.sessionId;
  if (!sid) { console.error('session.create failed:', JSON.stringify(created).slice(0, 300)); process.exit(1); }
  console.log('created session', sid);
  // 2) prompt
  const p = await post('/api/session.prompt', 'session.prompt', {
    sessionId: sid, mode: 'queue', content: [{ type: 'text', text: '只回复一个字:"好" 即可,不要用任何工具。' }],
  });
  console.log('prompt accepted:', !!(p && p.result && p.result.ok && p.result.value && p.result.value.accepted));
  // 3) poll for signal
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const d = await describe();
    const ns = d.namespaces.find((n) => n.ns === NS);
    if (!ns) { console.log('... namespace not present yet'); continue; }
    const sig = ns.value && ns.value.signal;
    if (sig && sig.phase === 'done') {
      console.log('SIGNAL FOUND:', JSON.stringify(sig));
      console.log('elapsed ms:', Date.now() - start);
      process.exit(0);
    }
    if (ns.revision > 0) console.log('... waiting (rev', ns.revision, ') last value:', JSON.stringify(ns.value && ns.value.signal));
  }
  console.error('timeout: no done signal within', timeoutMs, 'ms');
  process.exit(1);
})().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
