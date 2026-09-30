/**
 * Query a running DSH host's plugin inventory and report the display metadata each entry carries.
 *
 * `POST /api/pluginInventory/list` is a typert gateway method whose `list()` takes no arguments, so
 * the envelope carries an empty `args` object. The desktop host answers 401 without its session
 * token; pass one as the second argument (it is never printed).
 *
 * Usage: node exploration/plugin-inventory-query.mjs [port] [token] [nameFilter]
 */
const port = process.argv[2] ?? '3080'
const token = process.argv[3]
const filter = process.argv[4]

const response = await fetch(`http://127.0.0.1:${port}/api/pluginInventory/list`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...token === undefined ? {} : { authorization: `Bearer ${token}` },
  },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method: 'pluginInventory/list',
    payload: { args: {} },
  }),
})

console.log(`POST http://127.0.0.1:${port}/api/pluginInventory/list -> ${response.status}`)
const text = await response.text()
if (response.status !== 200) {
  console.log(`body: ${text.slice(0, 300)}`)
  process.exitCode = 1
} else {
  const envelope = JSON.parse(text)
  const value = envelope.result?.value ?? {}
  const entries = value.entries ?? []
  console.log(`entries: ${entries.length}  (agentPresets: ${(value.agentPresets ?? []).length})`)
  const rows = filter === undefined ? entries : entries.filter(entry => entry.moduleName.includes(filter))
  for (const entry of rows) {
    const meta = entry.meta
    console.log([
      `  ${entry.moduleName}`,
      `enabled=${entry.enabled}`,
      `fiber=${entry.fiberPhase}`,
      `meta=${meta === undefined ? 'ABSENT (GUI falls back to package name/description)' : JSON.stringify({ title: meta.title, icon: meta.icon === undefined ? undefined : `<data-url ${meta.icon.length} chars>`, error: meta.error })}`,
    ].join('  '))
  }
  if (rows.length === 0) console.log('  (no entry matched the filter)')
}
