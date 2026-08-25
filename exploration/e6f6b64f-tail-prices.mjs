'use strict';
// Compute the ESTIMATED per-node prices of the tail segment of the pre-compact
// surface and show the backward cumulative sum toward budget=8000, proving where
// the crossing lands and why retained=11155.
import http from 'http';
const SID = 'session-e6f6b64f-7067-4c98-9706-45d74b28dae5';
function rpc(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'p' + Date.now(), method, payload });
  return new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: 3180, path: '/api/' + method, method: 'POST', headers: { 'Content-Type': 'application/json' } }, rs => {
      let b = ''; rs.on('data', c => b += c);
      rs.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    rq.on('error', rej); rq.write(body); rq.end();
  });
}
const CHARS_PER_TOKEN = 4, BLOCK_OVERHEAD = 4, ROLE_OVERHEAD = 4;
function estimateContent(blocks) {
  let t = 0;
  for (const block of blocks || []) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        t += Math.ceil((block.text || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case 'tool-call':
        t += Math.ceil((block.name || '').length / CHARS_PER_TOKEN)
          + Math.ceil(typeof block.arguments === 'string' ? block.arguments.length : JSON.stringify(block.arguments || '').length, 4)
          + BLOCK_OVERHEAD;
        break;
      case 'tool-result':
        t += estimateContent(block.content) + BLOCK_OVERHEAD;
        break;
      default:
        t += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
    }
  }
  return t;
}
// Mirror deriveEventMessage's message-shape normalization closely enough for
// tail-node price approximation: user/content blocks directly; assistant wraps
// into {role, content}; tool/result wraps result into a tool-result block.
function priceForEvent(ev) {
  const d = ev.data || {};
  let content = d.content;
  if (ev.type === 'assistant/message') {
    const msg = d.message || d;
    content = (msg && msg.content) || d.content || [];
  } else if (ev.type === 'tool/result') {
    const inner = Array.isArray(d.result) ? d.result : [{ type: 'text', text: typeof d.result === 'string' ? d.result : JSON.stringify(d.result || '') }];
    content = [{ type: 'tool-result', content: inner }];
  }
  return estimateContent(content || []) + ROLE_OVERHEAD;
}

const resp = await rpc('session.history', { sessionId: SID });
const evs = (resp.result.value.events || []).map(r => r.event);
const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result']);
const nodes = [];
for (const ev of evs) {
  if (ev.seq >= 2835) break;
  if (!SURFACE.has(ev.type) || ev.surfaceOp === undefined) continue;
  const op = ev.surfaceOp;
  if (op === 'append') { nodes.push(ev.seq); continue; }
  if (op && op.op === 'replace') {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i] >= op.start && nodes[i] <= op.end) nodes.splice(i, 1);
    }
    nodes.push(ev.seq);
  }
}
console.log('pre-compact surface nodes:', nodes.length);
const TAIL_N = 16;
const tail = nodes.slice(-TAIL_N);
const acc = new Map(tail.map(s => [s, priceForEvent(evs[s])]));
let cum = 0;
console.log('\ntail nodes with estimated prices & backward cumulative (budget 8000):');
console.log('idx seq  price cum-so-far-from-tail');
for (let i = tail.length - 1; i >= 0; i--) {
  const s = tail[i], p = acc.get(s);
  cum += p;
  const over = cum >= 8000 ? ' << crosses 8000 here' : '';
  console.log(String(nodes.indexOf(s)).padStart(2), ' ', String(s).padStart(4), '  '.concat(String(p).padStart(5)), ' '.concat(String(cum).padStart(6)), over);
}
const crossingIdx = (() => {
  let c = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    c += acc.get(tail[i]);
    if (c >= 8000) return i;
  }
  return -1;
})();
console.log('\ncrossing idx=', crossingIdx, '-> seq', tail[crossingIdx], 'price', acc.get(tail[crossingIdx]));
console.log('retained = tailSum - accumulatedUpToCrossing (i.e. nodes AFTER crossing kept) =');
const retainedTail = tail.slice(0, crossingIdx); // strictly before crossing idx (exclusive)
let retSum = 0; for (const s of retainedTail) retSum += acc.get(s);
console.log('kept nodes (after crossing):', retainedTail.join(','), 'sum=', retSum);
console.log('NOTE: my simple sum excludes nodes outside the last', TAIL_N, '- if the true tail window includes MORE nodes between the crossing and the tail-start, the actual retained grows accordingly.');
