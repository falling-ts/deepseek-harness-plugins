// Module hooks for exploration/i18n-locale-runtime-probe.mjs.
//
// The official locale client module imports its settings-row React component
// (LanguageRow.tsx) and its CSS Module purely to register the Language row in
// `apply`. The probe never calls `apply` — it drives LocaleRuntime's catalog and
// dictionary API directly — so both are stubbed to empty modules, keeping the
// REAL class and the REAL lookup chain under test without dragging jsdom and a
// CSS pipeline into the probe.
//
// Only files matching these two shapes are intercepted; everything else falls
// through to tsx (TypeScript) and Node.
const TSX_STUB = 'const stub = () => null; export default stub; export const LanguageRow = stub;'
const CSS_STUB = 'export default new Proxy({}, { get: (_target, key) => String(key) })'

/** @param {string} url - resolved module url. */
function stubSourceFor(url) {
  const path = url.split('?')[0]
  if (path.endsWith('.module.css') || path.endsWith('.css')) return CSS_STUB
  if (path.endsWith('.tsx')) return TSX_STUB
  return null
}

/**
 * Load hook: replace the two UI-only module kinds with empty stubs.
 * @param {string} url - module url.
 * @param {object} context - loader context.
 * @param {Function} nextLoad - the next hook in the chain.
 */
export async function load(url, context, nextLoad) {
  const source = stubSourceFor(url)
  if (source !== null) return { format: 'module', shortCircuit: true, source }
  return nextLoad(url, context)
}
