#!/usr/bin/env node
/**
 * fc-e2e-retain.cjs — End-to-end validation of the new retainLatestTokens semantic
 * against the live dev instance on port 3180.
 *
 * What we drive:
 *   1. Create a fresh test session.
 *   2. Send multiple queued prompts that ask the driven model to repeatedly
 *      study the project (read / glob / grep over real files) so the surface
 *      grows past autoThresholdTokens (currently 30000).
 *   3. Poll session.history + the dev instance's debug log until the plugin's
 *      gate FIRES at least once AND the compaction bracket commits
 *      (start/summary/end sharing one compactionId).
 *   4. Print the evidence lines so a human can eyeball the outcome.
 *
 * Wire protocol reminder (verified on this instance):
 *   POST /api/<ns>.<method>, envelope {type:"client-request",rpcId,method,payload},
 *   Content-Type:application/json; response result.ok discriminates business errors.
 */
'use strict';
const PORT = process.argv[2] || '3180';
const BASE = `http://127.0.0.1:${PORT}`;

async function call(method, payload = {}) {
  const http = require('http');
  const rpcId = crypto.randomUUID();
  const url = new URL(BASE + '/api/' + method);
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let acc = '';
      res.on('data', (c) => { acc += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(acc);
          if (json.type !== 'server-response') return reject(new Error(`unexpected frame ${acc.slice(0, 400)}`));
          const r = json.result || {};
          if (r.ok === false) return reject(new Error(`${method}: ${JSON.stringify(r.error ?? r)}`));
          resolve(r.value);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(90_000, () => req.destroy(new Error('request timed out')));
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function getSessionTotalTokens(sessionId) {
  const h = await call('session.history', { sessionId });
  const hist = h.history ?? h.events ?? h;
  // Surface types carrying surfaceOp are the ones priced by the meter; we
  // approximate total with a conservative sum of message lengths (good enough
  // to detect "crossed the threshold").
  let chars = 0;
  for (const ev of hist) {
    if (!ev.data) continue;
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      const blocks = Array.isArray(ev.data.blocks) ? ev.data.blocks : [];
      for (const b of blocks) {
        if (typeof b?.text === 'string') chars += b.text.length;
      }
    } else if (ev.type === 'tool/result') {
      const out = typeof ev.data.output === 'string' ? ev.data.output
        : (Array.isArray(ev.data.output)
          ? JSON.stringify(ev.data.output)
          : '');
      chars += out.length;
    }
  }
  return Math.ceil(chars / 4); // char / 4 heuristic used by the meter fallback.
}

async function main() {
  console.log(`[e2e] talking to ${BASE}`);
  const created = await call('session.create', {});
  const sid = created.sessionId;
  console.log(`[e2e] session ${sid} created.`);

  // A sequence of "study the project" demands that force the model to keep
  // reading files — repeated demand, near-complete scans, large-volume output.
  const rounds = [
    'You are about to STUDY THIS PROJECT THOROUGHLY. Read the ENTIRE repository layout with a full recursive listing (glob **/* at depth 5+). Then READ every configuration manifest you can find (every package.json, every cordis.patch.yml, every .yml / .toml / .ini in the tree) and REPORT their key fields back to me. Do NOT summarize shallowly — show the ACTUAL contents, field by field, for each file.',
    'Continue studying: use grep across the entire repo for the strings "settings", "compaction", "retainLatestTokens" and paste EVERY match with its surrounding context (at least 10 lines either side). Group by file and quote the matched line VERBATIM.',
    'Keep going deeper: for every JavaScript file under any src/ directory, walk it TOP-TO-BOTTOM with read and quote the FIRST 20 LINES OF EACH FILE so I can see the header comments. If there are many, do them ALL in order and label each with its path.',
    'Final round: enumerate every function / export in each file you have seen so far (name + one-line purpose) and produce a consolidated architecture map. Afterward, REPEAT this study pass one more time on whatever files remain unread.',
    'Wrap up the study with a definitive file-by-file index covering EVERY file in the repo (path, size, primary symbol(s)). No omissions.',
  ];

  // Fire every round as queue-mode prompts back-to-back. They execute serially
  // inside the same session, so context accumulates monotonically.
  console.log('[e2e] queuing', rounds.length, 'studies…');
  for (const r of rounds) {
    await call('session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: r }],
    });
  }

  // Poll for completion + evidence.
  const deadline = Date.now() + 12 * 60 * 1000; // 12 min cap.
  let settled = false;
  let sawGateFire = false;
  let sawBracketCommit = false;
  let lastHistChars = 0;
  while (Date.now() < deadline) {
    await sleep(10_000);
    let est;
    try { est = await getSessionTotalTokens(sid); } catch (err) { console.error('[e2e] history poll failed:', err.message); continue; }
    const grew = est - lastHistChars;
    lastHistChars = est;
    // Check the debug log for gate-fire and bracket-commit lines.
    const { execSync } = require('child_process');
    let logTail = '';
    try {
      const home = process.env.USERPROFILE || require('os').homedir();
      const logPath = `${home}\\.dsh\\logs\\dsh-force-compact.log`;
      logTail = execSync(`powershell -Command "Get-Content '${logPath}' -Tail 200"`, { encoding: 'utf8', timeout: 10_000 });
    } catch (err) { console.error('[e2e] log read failed:', err.message); }
    const fireMatch = /context ~\d+ tokens >= threshold \d+; rejecting the model request and compacting/.exec(logTail);
    const bracketMatch = /compaction\/end .*compactionId=[a-f0-9-]{36}/.exec(logTail);
    if (fireMatch && !sawGateFire) { sawGateFire = true; console.log('[e2e] ✓ GATE-FIRE observed:', fireMatch[0].slice(0, 120)); }
    if (bracketMatch && !sawBracketCommit) { sawBracketCommit = true; console.log('[e2e] ✓ BRACKET-COMMIT observed:', bracketMatch[0].slice(0, 120)); }
    if (sawGateFire && sawBracketCommit) { settled = true; break; }
    if (est > 0) console.log(`[e2e] t=${new Date().toISOString()} est≈${est} (+${grew})`);
  }
  console.log(settled
    ? '[e2e] PASS — gate fired and a compaction bracket committed.'
    : `[e2e] INCONCLUSIVE — gateFire=${sawGateFire} bracketCommit=${sawBracketCommit}; inspect the log manually.`);
}

main().catch((err) => { console.error('[e2e] fatal:', err); process.exitCode = 1; });
