#!/usr/bin/env node
// fcsimpledrive.cjs — bounded drive: send a few turns, wait a little, tail log.
// Fast version used to smoke the CLEAN build (cooldown engaged, no temp-diag).
const PORT = parseInt(process.argv[2] || '3180', 10)
const BASE = `http://127.0.0.1:${PORT}/api`
const fs = require('node:fs'), os = require('node:os'), p = require('node:path')
const LOG = p.join(os.homedir(), '.dsh', 'logs', 'dsh-force-compact.log')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function rpc(m, pl) {
  const body = JSON.stringify({ type: 'client-request', rpcId: Math.random().toString(36).slice(2), method: m, payload: pl || {} })
  const r = await fetch(BASE + '/' + m, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  const t = await r.text()
  let j
  try { j = JSON.parse(t) } catch (e) { throw new Error('HTTP ' + r.status + ' non-JSON: ' + t.slice(0, 200)) }
  if (j.result && j.result.ok === false) throw new Error(m + ' rejected: ' + (j.result.error || ''))
  return j.result && j.result.value
}
(async () => {
  const c = await rpc('session.create', {})
  const sid = c && (c.sessionId||c.id)
  console.log(`session ${sid}`)
  const N = 12
  for (let i=1;i<=N;i++){
    const v = await rpc('session.prompt',{sessionId:sid,mode:'queue',content:[{type:'text',text:`Round ${i}: reply READY.`}]})
    if(!v||v.accepted!==true){console.log(`round ${i} not accepted`);break}
    // brief settle
    await sleep(900)
  }
  console.log(`sent ${N} rounds; waiting 12s for idle compactions...`)
  await sleep(12000)
  const lines = fs.existsSync(LOG)?fs.readFileSync(LOG,'utf8').split(/\r?\n/):[]
  const mine = lines.filter(l=>l.includes(sid))
  const sig=(re)=>mine.filter(l=>re.test(l))
  const show=(label,arr,n=3)=>{console.log(`  ${label.padEnd(20)} total=${arr.length}`); arr.slice(-n).forEach(x=>console.log('     '+x.replace(/^\S+\s+/,'').trim()))}
  console.log(`\nsession-scoped tallies (last occurrences shown):`)
  show('SKIPPED(cooldown)', sig(/cooldown/i))
  show('REFUSED(cap)', sig(/replay cap|REFUSED/i))
  show('txn error', sig(/transaction ended in error/i))
  show('read-kind crash', sig(/reading \u0027kind\u0027/i))
  show('STREAM_NOT_ITERABLE', sig(/did NOT return an async iterable|STREAM_NOT_ITERABLE/i))
  show('NO_FINISH', sig(/without a terminal finish chunk|NO_FINISH/i))
  show('temp-diag', sig(/TEMP-DIAG/i))
  show('OK commit', sig(/builtin compaction OK/i))
  show('no compactable', sig(/no compactable region/i))
})();
