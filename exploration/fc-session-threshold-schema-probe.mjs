// Probe: can the CLIENT half actually WRITE the per-session override?
//
// The host->client direction (`liveUi`) goes through `settings.update`, which
// writes with an empty path list and therefore skips the volatility gate. The
// client->host direction goes through `settings.mutate`, which calls
// `isVolatilePath(schema, path)` for EVERY op path and rejects the write with
// `settings/rejected` when it is false. So the feature stands or falls on
// `buildConfigSchema()` really producing a VOLATILE node at
// `sessionThresholds`, one level above the session id.
//
// This runs the REAL plugin schema against the REAL harness predicate.
//
// Run: node --import file:///D:/AI/deepseek-harness-plugins/deepseek-harness/node_modules/tsx/dist/esm/index.mjs exploration/fc-session-threshold-schema-probe.mjs
import fs from 'node:fs'
import { buildConfigSchema } from '../dsh-force-compact/src/core/settings.js'
import { isVolatilePath } from '../deepseek-harness/packages/settings/settings/src/schema.ts'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : '  ' + detail}`)
}

const schema = await buildConfigSchema()
check(schema !== undefined && schema !== null, 'buildConfigSchema() resolves a schema')

// The exact path shape the client sends: ['sessionThresholds', <session id>].
check(isVolatilePath(schema, ['sessionThresholds']) === true,
  'sessionThresholds itself is volatile')
check(isVolatilePath(schema, ['sessionThresholds', 'session-abc-123']) === true,
  'a NESTED session id under sessionThresholds is volatile (this is the write the chip makes)')
check(isVolatilePath(schema, ['sessionThresholds', 'a', 'b']) === true,
  'volatility is inherited by the whole subtree below the volatile node')

// The sibling that must keep working, and a field that must still be gated.
check(isVolatilePath(schema, ['autoThresholdTokens']) === true,
  'autoThresholdTokens stays volatile (the settings form depends on it)')
check(isVolatilePath(schema, ['liveUi']) === true, 'liveUi stays volatile')
check(isVolatilePath(schema, ['nope']) === false, 'an undeclared field is still rejected (gate is live)')
check(isVolatilePath(schema, ['nope', 'x']) === false, 'an undeclared nested path is still rejected')

// The schema node must be an "any" node: the value shape is validated at read
// time in readSettings, not by schemastery (see the field's comment).
const node = schema.dict.sessionThresholds
check(node !== undefined, 'the schema dict carries the sessionThresholds key')
check(node !== undefined && node.meta !== undefined && node.meta.volatile === true,
  'the node records meta.volatile = true')
check(node !== undefined && node.type !== 'object',
  `the node is not an object schema (shape is checked at read time) — type=${node && node.type}`)