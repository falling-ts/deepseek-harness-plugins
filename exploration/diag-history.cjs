'use strict';
/* Raw diagnostic: print HTTP status + raw body for session.history and
 * session.list against a port, and check whether the repaired session ids
 * appear in the list. */
const PORT = Number(process.argv[2] || 3080);
const SIDS = new Set(['cb6122ea-b511-4e80-9c6d-b5f49b0e4868', 'db44b595-dafc-4b8a-8d0d-c8c2d63e6a85']);

async function raw(method, payload, label) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `diag-${Date.now()}`, method, payload }),
  });
  const text = await res.text();
  console.log(`\n[${label}] POST /api/${method} -> HTTP ${res.status}, ${text.length} bytes`);
  console.log(`  body head: ${text.slice(0, 400)}`);
  return { status: res.status, text };
}

(async () => {
  await raw('session.list', {}, 'list');
  const { text } = await raw('session.history', { sessionId: 'cb6122ea-b511-4e80-9c6d-b5f49b0e4868' }, 'history');
  // Does the list mention the repaired ids?
  const hit = [...SIDS].filter((id) => text.includes(id.slice(0, 8)));
  console.log(`\nrepaired ids present in list body: ${hit.length ? hit.join(', ') : '(none)'}`);
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1); });
