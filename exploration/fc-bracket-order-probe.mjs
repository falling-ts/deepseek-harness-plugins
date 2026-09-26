// Structural regression lock for the compaction-bracket ordering.
//
// The 2026-09-25 corruption (session-ed8e0108: `turn/start crosses an open
// compaction`) came from opening the durable bracket BEFORE the awaited
// summarization call, so a user message arriving during the (37 s) summary
// appended `turn/start` INSIDE the bracket and made the whole session log
// unloadable. These assertions pin the fix in the shipped source: the bracket
// is opened only once the summary exists, and everything that follows is
// synchronous.
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../dsh-force-compact/src/engine/builtin.js', import.meta.url), 'utf8')

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}

const txStart = SRC.indexOf('async function runTransaction(')
const txEnd = SRC.indexOf('\n/** Append `compaction/end` carrying the error', txStart)
check('runTransaction located', txStart > 0 && txEnd > txStart)
const body = SRC.slice(txStart, txEnd)

const summarizeAt = body.indexOf('await summarize(')
const openAt = body.indexOf("session.append('compaction/start'")
const summaryAt = body.indexOf("session.append('compaction/summary'")
const replaceAt = body.indexOf("session.append('user/message'")
const endAt = body.indexOf("session.append('compaction/end'", summaryAt)
check('summarization call is found', summarizeAt > 0)
check('bracket opening is found', openAt > 0)
check('bracket opens AFTER the awaited summarization', openAt > summarizeAt,
  `summarize@${summarizeAt} open@${openAt}`)
check('start → summary → replace → end are ordered', openAt < summaryAt && summaryAt < replaceAt && replaceAt < endAt,
  `open@${openAt} summary@${summaryAt} replace@${replaceAt} end@${endAt}`)

// No `await` may sit between the bracket opening and the final append: that is
// the property that keeps a concurrent `turn/start` out of the bracket.
const between = body.slice(openAt, endAt)
const awaits = [...between.matchAll(/\bawait\s/g)].length
check('no await between start and end (bracket stays synchronous)', awaits === 0, `found ${awaits}`)

// Pre-bracket failures must not attempt a durable close.
const closeStart = SRC.indexOf('function closeWithError(')
const closeBody = SRC.slice(closeStart, SRC.indexOf('\n}', closeStart))
check('closeWithError tolerates an unopened bracket', /startEvent === undefined/.test(closeBody))
check('no direct compaction/end append in the no-target branch',
  !/no summarization call made[\s\S]{0,900}session\.append\('compaction\/end'/.test(SRC))

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failures.length} failed`)
if (failures.length !== 0) process.exit(1)
