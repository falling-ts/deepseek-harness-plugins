#!/usr/bin/env node
// Probe: drive ONE clean flush on the 3180 dev instance and report the
// session id it produced. Usage:
//   node fcdrive3180.cjs <port>
// Creates a session, queues a trivial prompt, waits briefly, prints the new
// session id so the operator can grep the plugin debug log for its gate lines.
const fs = require('fs')
const os = require('os')
const path = require('path')

const port = process.argv[2] || '3180'
const base = `http://127.0.0.1:${port}`

async function rpc(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `probe-${Date.now()}`, method, payload })
  const res = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const json = await res.json()
  if (!json.result || !json.result.ok) {
    throw new Error(`wire error for ${method}: ${JSON.stringify(json.result && json.result.error)}`)
  }
  return json.result.value
}

(async () => {
  const created = await rpc('session.create', {})
  const sid = created.sessionId
  console.log('CREATED_SESSION_ID=' + sid)
  await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly the word pong.' }] })
  console.log('PROMPT_QUEUED')
  const home = process.env.USERPROFILE || os.homedir()
  const logFile = path.join(home, '.dsh', 'logs', 'dsh-force-compact.log')
  console.log('LOG_FILE=' + logFile)
  console.log('Grep hint: findstr "' + sid + '" "%USERPROFILE%\\.dsh\\logs\\dsh-force-compact.log"')
})().catch(err => { console.error('PROBE_FAILED: ' + err.message); process.exit(1) })
