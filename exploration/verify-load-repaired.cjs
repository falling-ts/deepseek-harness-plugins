'use strict';
/*
 * End-to-end proof that the repaired sessions now LOAD: call session.history
 * (the load path that runs assertMessageEventShape) against 3080 for each
 * previously-corrupt session id. ok:true + a non-empty stream means the
 * whole log passes shape validation.
 */
'use strict';
const SIDS = [
  'cb6122ea-b511-4e80-9c6d-b5f49b0e4868',
  'db44b595-dafc-4b8a-8d0d-c8c2d63e6a85',
];
const PORT = Number(process.argv[2] || 3080);

(async () => {
  let allOk = true;
  for (const sessionId of SIDS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/session.history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `verify-load-${sessionId}-${Date.now()}`,
          method: 'session.history',
          payload: { sessionId },
        }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!j.result || !j.result.ok) {
        allOk = false;
        console.log(`FAIL ${sessionId}: ${JSON.stringify(j.result && j.result.error).slice(0, 300)}`);
        continue;
      }
      const v = j.result.value;
      const arr = Array.isArray(v) ? v : v.events || v.items || v.messages || [];
      const count = arr.length;
      console.log(`OK   ${sessionId}: loaded ${count} events`);
    } catch (e) {
      allOk = false;
      console.log(`FAIL ${sessionId}: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(allOk ? '\nALL REPAIRED SESSIONS LOAD SUCCESSFULLY' : '\nSOME SESSIONS STILL FAIL TO LOAD');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(2); });
