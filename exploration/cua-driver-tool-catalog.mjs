// Enumerate the Cua Driver tool catalog this machine would expose to the model.
//
// The harness does not define computer-use operations: it loads @trycua/cua-driver,
// asks it for listToolsJson(), and republishes each entry as
// `cua_driver_native__<name>` through the MCP result adapter. So the tool names and
// schemas are a property of the installed native SDK, not of DSH -- this probe reads
// them from the same package the provider imports.
//
// It deliberately performs no screenshot, no input, and no permission prompt, so it is
// safe to run on a live desktop. It answers only "is the native runtime loadable here,
// and what would the model be handed".
//
// Run from the workspace root: node exploration/cua-driver-tool-catalog.mjs
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const harness = 'D:/deepseek-harness-plugins/deepseek-harness'
const store = path.join(harness, 'node_modules/.pnpm')

// Resolve whatever cua-driver version the harness actually installed, and its
// platform native package -- the pair must match, so report both.
const driverDir = fs.readdirSync(store).filter((d) => /^@trycua\+cua-driver@/.test(d)).sort().pop()
if (!driverDir) {
  console.log('@trycua/cua-driver is not installed in this checkout; nothing to enumerate.')
  process.exit(0)
}
const nativeDir = fs.readdirSync(store)
  .filter((d) => /^@trycua\+cua-driver-(darwin|linux|win32)-/.test(d))
  .sort()
  .pop()

console.log(`driver package : ${driverDir}`)
console.log(`native package : ${nativeDir ?? '<none for this platform>'}`)
console.log(`node           : ${process.version}  ${process.platform}/${process.arch}\n`)

const entry = path.join(store, driverDir, 'node_modules/@trycua/cua-driver/dist/index.js')
const { CuaDriver } = await import(pathToFileURL(entry).href)

const driver = CuaDriver.create(undefined)
// listToolsJson dereferences asyncOpts.signal, so the caller must supply one --
// the harness passes its plugin lifetime signal here.
const signal = new AbortController().signal
try {
  const catalog = JSON.parse(await driver.listToolsJson({ signal }))
  const tools = catalog.tools ?? []
  console.log(`tools the model would see (prefixed cua_driver_native__): ${tools.length}\n`)
  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? {}
    const required = new Set(tool.inputSchema?.required ?? [])
    const params = Object.keys(props)
      .map((k) => (required.has(k) ? k : `${k}?`))
      .join(', ')
    // Screenshot/observation tools are the ones that return images, which is what
    // makes the look-at-screen loop possible at all.
    const image = /image|screenshot|screen|snapshot|state/i.test(`${tool.name} ${tool.description ?? ''}`)
    console.log(`${image ? '[image?]' : '        '} cua_driver_native__${tool.name}`)
    console.log(`           args: ${params || '<none>'}`)
    if (tool.description) console.log(`           ${String(tool.description).split('\n')[0].slice(0, 150)}`)
  }
} finally {
  // Orderly shutdown: close admission, await admitted work, then release the binding.
  await driver.shutdown?.().catch(() => {})
  driver.uniffiDestroy?.()
}

// With --permissions, also read the platform permission gate. check_permissions is a
// read-only probe (it takes no arguments and cannot prompt), so this stays safe on a
// live desktop -- it answers whether this host could actually observe and act at all.
if (process.argv.includes('--permissions')) {
  const probe = CuaDriver.create(undefined)
  try {
    const result = await probe.callTool('check_permissions', JSON.stringify({}), { signal })
    console.log('\ncheck_permissions:')
    console.log(JSON.stringify(JSON.parse(result.rawJson), null, 2))
  } catch (error) {
    console.log(`\ncheck_permissions unavailable: ${error.message}`)
  } finally {
    await probe.shutdown?.().catch(() => {})
    probe.uniffiDestroy?.()
  }
}
