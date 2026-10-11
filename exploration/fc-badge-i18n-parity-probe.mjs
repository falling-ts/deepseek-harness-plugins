// Probe: do the HOST phase texts and the CLIENT dictionaries agree, key for key
// and language for language?
//
// The host publishes `liveUi` with a locale-independent `textId` (the phase
// name) plus a canonical zh `text`; the client maps `textId` → a `badge*`
// dictionary key and takes the active language's word. Two drifts are possible
// and both are silent at runtime:
//   1. the client's phase map and the host's phase union disagree → an unknown
//      textId falls back to the host's canonical zh text (wrong tongue for a
//      non-zh UI);
//   2. a `badge*` key is missing from one of the four dictionaries → the lookup
//      falls back to `en` (or to the key name itself), again silently.
// Run: node exploration/fc-badge-i18n-parity-probe.mjs
import fs from 'node:fs'

const root = new URL('../dsh-force-compact/', import.meta.url)

const host = fs.readFileSync(new URL('src/core/ui-signal.js', root), 'utf8')
const client = fs.readFileSync(new URL('web/client.js', root), 'utf8')

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ── 1. the host's phase union ────────────────────────────────────────────────
const phaseTexts = host.match(/PHASE_TEXTS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/)[1]
const hostPhases = [...phaseTexts.matchAll(/\[PHASE_[A-Z]+\]:\s*'([^']*)'/g)].map((m) => m[1])
const hostPhaseNames = [...phaseTexts.matchAll(/\[PHASE_([A-Z]+)\]/g)].map((m) => m[1].toLowerCase())
console.log(`host phases = ${hostPhaseNames.length} [${hostPhaseNames.join(', ')}]`)

// Every phase constant must be exported and used exactly once in PHASE_TEXTS.
const declared = [...host.matchAll(/export const PHASE_[A-Z]+ = '([^']+)'/g)].map((m) => m[1])
check('every exported PHASE_* constant appears in PHASE_TEXTS',
  declared.length === hostPhaseNames.length
  && declared.every((name) => hostPhaseNames.includes(name)),
  `declared=${declared.length} mapped=${hostPhaseNames.length}`)
check('the host phase union has no duplicate discriminant',
  new Set(declared).size === declared.length)

// ── 2. the client's textId -> dictionary-key map ─────────────────────────────
const clientMap = client.match(/const PHASE_KEYS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/)[1]
const mapEntries = [...clientMap.matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]])
console.log(`client PHASE_KEYS = ${mapEntries.length}`)

check('client PHASE_KEYS covers exactly the host phase union',
  mapEntries.length === hostPhaseNames.length
  && hostPhaseNames.every((name) => mapEntries.some(([k]) => k === name)),
  `host=[${hostPhaseNames.join(',')}] client=[${mapEntries.map(([k]) => k).join(',')}]`)

// ── 3. every mapped key exists in all four dictionaries ─────────────────────
const dicts = {}
for (const lang of ['zh', 'en', 'ja', 'ko']) {
  const block = client.match(new RegExp(`const ${lang} = \\{([\\s\\S]*?)\\n {4}\\};`))
  if (block === null) {
    check(`${lang} dictionary block is present`, false)
    continue
  }
  dicts[lang] = block[1]
}

for (const [phase, key] of mapEntries) {
  for (const [lang, block] of Object.entries(dicts)) {
    const found = new RegExp(`\\b${key}:\\s*"([^"]*)"`).exec(block)
    check(`${key} (${phase}) present in ${lang}`, found !== null)
  }
}

// ── 4. non-empty badges stay non-empty; only `end` may be the clear ─────────
for (const [phase, key] of mapEntries) {
  const zh = new RegExp(`\\b${key}:\\s*"([^"]*)"`).exec(dicts.zh)?.[1]
  if (phase === 'end') {
    check('badgeEnd is the EMPTY clear', zh === '', JSON.stringify(zh))
  } else {
    check(`${key} is a non-empty badge`, typeof zh === 'string' && zh.length > 0, JSON.stringify(zh))
  }
}

// ── 5. the retired random working texts are gone ─────────────────────────────
check('host no longer defines WORKING_TEXTS', !/WORKING_TEXTS/.test(host))
check('client no longer defines badgeWorking<N>', !/badgeWorking\d/.test(client))

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
