'use strict';
// Inspect every compaction/start event in session 45ad374f: show the ±3
// neighborhood so we can see what followed each start (did summary/replace/
// end land? how far apart?). Also dump every compaction/end without a matching
// preceding summary, and count how many times the same range got re-compacted.
import http from 'http';
const SID = 'session-45ad374f-dbbb-4799-88f4-0d4771e9d1b4';
function rpc(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'o' + Date.now(), method, payload });
  return new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: 3180, path: '/api/' + method, method: 'POST', headers: { 'Content-Type': 'application/json' } }, rs => {
      let b = ''; rs.on('data', c => b += c);
      rs.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    rq.on('error', rej); rq.write(body); rq.end();
  });
}
const resp = await rpc('session.history', { sessionId: SID });
const evs = (resp.result.value.events || []).map(r => r.event);
const bySeq = new Map(evs.map(e => [e.seq, e]));
const starts = evs.filter(e => e.type === 'compaction/start');
const ends = evs.filter(e => e.type === 'compaction/end');
const summaries = evs.filter(e => e.type === 'compaction/summary');
const replaces = evs.filter(e => e.type === 'user/message' && e.surfaceOp && e.surfaceOp.op === 'replace');
console.log(`starts=${starts.length} ends=${ends.length} summaries=${summaries.length} replaces=${replaces.length}  totalEvents=${evs.length}`);

function show(seq) {
  const e = bySeq.get(seq);
  return `${String(seq).padStart(6)} ${e.type.padEnd(17)} ${e.data ? JSON.stringify({ cid: (e.data.compactionId||'').slice(-4), shadow: e.data.shadowedTokenCount, turn: e.data.turn }).replace(/"cid":"(\w+)"/,'"$1"') : ''}`;
}
console.log('\n=== neighborhoods ===');
for (const s of starts) {
  console.log(`\n--- start@${s.seq} (data: ${JSON.stringify(s.data).slice(0,120)}) ---`);
  for (let d = 0; d < 6; d++) {
    const e = bySeq.get(s.seq + d);
    if (!e) break;
    const tag = e.seq === s.seq ? '> ' : '  ';
    let extra = '';
    if (e.type === 'user/message' && e.surfaceOp && e.surfaceOp.op === 'replace') extra = ` op=replace ${e.surfaceOp.start}-${e.surfaceOp.end}`;
    if (e.type === 'compaction/summary') extra = ` shadow=${e.data.shadowedTokenCount} range=${JSON.stringify(e.data.shadowedRange)}`;
    if (e.type === 'turn/start' || e.type === 'turn/end' || e.type === 'step/start' || e.type === 'step/end') extra = ` turn=${e.data.turn}${e.data.step!==undefined?' step='+e.data.step:''} ${e.data.reason?('reason='+JSON.stringify(e.data.reason)):''}`;
    console.log(tag + show(e.seq) + extra);
  }
}
// Gap analysis: distance from each start to its next summary + next end
console.log('\n=== start -> nextSummary / nextEnd distances ===');
const sumBySeq = new Map(summaries.map(s => [s.seq, s]));
const repBySeq = new Map(replaces.map(s => [s.seq, s]));
for (const s of starts) {
  let nextSum = null, nextRep = null, nextEnd = null;
  outer: for (let x = s.seq + 1; x < evs.length; x++) {
    const e = bySeq.get(x);
    if (!e) continue;
    if (nextSum === null && e.type === 'compaction/summary') nextSum = x;
    if (nextRep === null && e.type === 'user/message' && e.surfaceOp && e.surfaceOp.op === 'replace') nextRep = x;
    if (nextEnd === null && e.type === 'compaction/end') { nextEnd = x; break; }
  }
  const ok = nextSum && nextRep && nextEnd;
  console.log(`start@${s.seq.pad(6)}  summary@${String(nextSum).pad(6)}(${nextSum ? nextSum-s.seq+'d':'MISSING'})  replace@${String(nextRep).pad(6)}(${nextRep?nextRep-s.seq+'d':'MISSING'})  end@${String(nextEnd).pad(6)}(${nextEnd?nextEnd-s.seq+'d':'MISSING'})  ${ok?'COMPLETED':!!nextEnd?'ABORTED/ERROR':'NO END AT ALL'}`);
}
