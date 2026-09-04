// fc-live-settings-3180.cjs — prove force-compact reads settings LIVE (no cache):
//  1) flip autoThresholdTokens to 40000 -> the periodic flush checkpoint log
//     must show "(threshold 40000)" within seconds;
//  2) flip debug to false -> the plugin log file must stop growing;
//  3) restore both (128000 / true) -> log grows again.
const BASE = 'http://127.0.0.1:3180/api'
const LOG = process.env.USERPROFILE + '/.dsh/logs/dsh-force-compact.log'
const fs = require('fs')

async function call(method, args) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'live-' + Date.now(), method, payload: { args } }),
  })
  const json = await res.json().catch(() => null)
  return json && json.result && json.result.ok
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logLines = () => {
  try { return fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim().length > 0).length } catch { return -1 }
}
const tailCheckpoint = () => {
  try {
    const t = fs.readFileSync(LOG, 'utf8')
    const lines = t.split('\n').filter((l) => l.includes('checkpoint fired'))
    return lines[lines.length - 1] || '(none yet)'
  } catch { return '(unreadable)' }
}

async function main() {
  console.log('1) update autoThresholdTokens -> 40000 ...')
  console.log('   ok:', await call('settings/update', { ns: 'falling-ts-force-compact', patch: { autoThresholdTokens: 40000 }, expectedRevision: undefined }))
  await sleep(8000)
  console.log('   latest checkpoint line:', tailCheckpoint())

  console.log('2) update debug -> false ...')
  const before = logLines()
  console.log('   ok:', await call('settings/update', { ns: 'falling-ts-force-compact', patch: { debug: false }, expectedRevision: undefined }))
  await sleep(8000)
  const after = logLines()
  console.log('   log line count before=', before, 'after=', after, '->', after === before ? 'STOPPED (live gate works)' : `STILL GROWING (+${after - before})`)

  console.log('3) restore autoThresholdTokens=128000, debug=true ...')
  console.log('   ok:', await call('settings/update', { ns: 'falling-ts-force-compact', patch: { autoThresholdTokens: 128000, debug: true }, expectedRevision: undefined }))
  await sleep(8000)
  const restored = logLines()
  console.log('   log line count after restore:', restored, '->', restored > after ? 'GROWING AGAIN (live gate works)' : 'still silent?')
  console.log('   latest checkpoint line:', tailCheckpoint())
}

main().catch((e) => { console.error('FAILED', e); process.exitCode = 1 })