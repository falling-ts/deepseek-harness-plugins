// Static type-drift probe: compares the pi-ai declarations the harness derives
// its drift gates from, between the installed version and another dist tree.
// Usage: node exploration/piai-type-drift.mjs <verA-package-dir> <verB-package-dir>
import fs from 'node:fs'
import path from 'node:path'

const NAMES = [
  'ThinkingLevel',
  'ModelThinkingLevel',
  'CacheRetention',
  'ThinkingLevelMap',
  'ModelCost',
  'Model',
  'Provider',
  'OpenAICompletionsCompat',
  'OpenAIResponsesCompat',
  'AnthropicMessagesCompat',
  'BedrockCompat',
]

/** Finds the first file under `dir` that declares `name` and returns its balanced declaration text. */
function extract(dir, name) {
  const files = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.d.ts')) files.push(p)
    }
  }
  walk(dir)
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const head of [`export interface ${name} {`, `export type ${name} =`]) {
      const start = text.indexOf(head)
      if (start === -1) continue
      if (head.startsWith('export type')) {
        const end = text.indexOf('\n', start)
        return { file: path.relative(dir, file), body: text.slice(start, end) }
      }
      let depth = 0
      let i = text.indexOf('{', start)
      const from = i
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') { depth--; if (depth === 0) break }
      }
      return { file: path.relative(dir, file), body: text.slice(start, i + 1) }
    }
  }
  return null
}

const [dirA, dirB] = process.argv.slice(2)
if (!dirA || !dirB) {
  console.error('usage: node exploration/piai-type-drift.mjs <dirA> <dirB>')
  process.exit(2)
}

let drifted = 0
for (const name of NAMES) {
  const a = extract(dirA, name)
  const b = extract(dirB, name)
  const same = a !== null && b !== null && a.body === b.body
  if (same) { console.log(`SAME  ${name}`); continue }
  drifted++
  console.log(`DIFF  ${name}  (${a ? a.file : 'MISSING in A'} vs ${b ? b.file : 'MISSING in B'})`)
  const la = a ? a.body.split('\n') : ['<missing>']
  const lb = b ? b.body.split('\n') : ['<missing>']
  const setA = new Set(la.map((l) => l.trim()))
  const setB = new Set(lb.map((l) => l.trim()))
  for (const l of la) if (!setB.has(l.trim())) console.log(`   -  ${l.trim()}`)
  for (const l of lb) if (!setA.has(l.trim())) console.log(`   +  ${l.trim()}`)
}
console.log(`\n${drifted} of ${NAMES.length} declarations differ`)
