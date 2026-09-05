// Offline probe: replay the official surface fold over a session.jsonl.zstd log
// and dump the resulting nodes order (plus the area around seq 60698..60702),
// to verify whether Session.surface.nodes is ascending-by-seq or not.
// Usage: node exploration/fc-surface-dump.cjs [path-to-zstd]
const fs = require('fs')
const { zstdDecompressSync } = require('node:zlib')

const FILE = process.argv[2] || 'C:/Users/zghyu/.dsh/sessions/--D-deepseek-harness-plugins--/session-b8dc3649-8d92-4ded-94fe-4c37111a3393/session.jsonl.zstd'
const buf = fs.readFileSync(FILE)
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

function frames(data) {
  const out = []
  let i = 0
  while (i < data.length - 4) {
    if (data[i] === 0x28 && data[i + 1] === 0xB5 && data[i + 2] === 0x2F && data[i + 3] === 0xFD) out.push(i)
    i += 1
  }
  return out
}

function decompressAll(data) {
  const spots = frames(data)
  let text = ''
  for (let k = 0; k < spots.length; k += 1) {
    const start = spots[k]
    const end = k + 1 < spots.length ? spots[k + 1] : data.length
    try {
      text += zstdDecompressSync(data.subarray(start, end)).toString('utf8')
    } catch (e) {
      text += `<frame-${k}-error:${e.message}>`
    }
  }
  return text
}

const text = decompressAll(buf)
const lines = text.split('\n').filter((l) => l.trim().length > 0)
const events = []
for (const l of lines) {
  try { events.push(JSON.parse(l)) } catch { /* skip */ }
}
events.sort((a, b) => a.seq - b.seq)
console.log('total events:', events.length)
console.log('seq range:', events[0].seq, '..', events[events.length - 1].seq)

// Replay the official surface fold (append on index; replace splices the span).
const nodes = []
let replaceGeneration = 0
const replacements = []
let lastSeq = -1
let contiguous = true
for (const e of events) {
  if (e.seq <= lastSeq) contiguous = false
  lastSeq = e.seq
  const d = e.data || {}
  const op = (e.surfaceOp === undefined ? undefined : e.surfaceOp) || (d.surfaceOp || undefined)
  if (/^(user\/message|assistant\/message|tool\/result)$/.test(e.type)) {
    if (op === 'append' || op === undefined && e.type === 'user/message') {
      nodes.push(e.seq)
    } else if (op && op.op === 'replace') {
      replaceGeneration += 1
      const si = nodes.indexOf(op.start)
      const ei = nodes.indexOf(op.end)
      replacements.push({ seq: e.seq, start: op.start, end: op.end, si, ei, len: nodes.length })
      if (si === -1 || ei === -1) {
        // Try lastIndexOf for ei to match the plugin's own lookup
        const lsi = nodes.lastIndexOf(op.start)
        const lei = nodes.lastIndexOf(op.end)
        console.log(`REPLACE MISS at seq=${e.seq} start=${op.start}(idx ${si}/${lsi}) end=${op.end}(idx ${ei}/${lei}) nodes=${nodes.length}`)
      } else {
        if (si > ei) {
          console.log(`REPLACE INVERTED at seq=${e.seq} start=${op.start}(idx ${si}) end=${op.end}(idx ${ei})`)
        }
        nodes.splice(si, ei - si + 1, e.seq)
      }
    } else {
      console.log(`surface event without known op: seq=${e.seq} type=${e.type} surfaceOp=${JSON.stringify(e.surfaceOp)}`)
    }
  }
}
console.log('replacements seen:', replacements.length)
console.log('final nodes count:', nodes.length)
console.log('first 20 nodes:', nodes.slice(0, 20).join(','))
console.log('last 20 nodes:', nodes.slice(-20).join(','))
console.log('nodes sorted ascending?', nodes.every((v, i) => i === 0 || v > nodes[i - 1]))

// What are seq 60698..60702?
console.log('\n=== events seq 60680..60712 (type/surfaceOp) ===')
for (const e of events) {
  if (e.seq >= 60680 && e.seq <= 60712) {
    console.log(`seq=${e.seq} type=${e.type} surfaceOp=${JSON.stringify(e.surfaceOp || null)} modelVisible=${/^(user\/message|assistant\/message|tool\/result)$/.test(e.type)}`)
  }
}

// What is around the checkpoint? seq 58220..58240
console.log('\n=== events seq 58210..58245 (type/surfaceOp) ===')
for (const e of events) {
  if (e.seq >= 58210 && e.seq <= 58245) {
    console.log(`seq=${e.seq} type=${e.type} surfaceOp=${JSON.stringify(e.surfaceOp || null)} dKeys=${Object.keys(e.data || {}).join(',')}`)
  }
}

// Where do nodes 0..15 sit vs seq 60698/60702?
console.log('\n=== node positions of 60698 / 60702 ===')
console.log('indexOf 60698:', nodes.indexOf(60698), 'lastIndexOf:', nodes.lastIndexOf(60698))
console.log('indexOf 60702:', nodes.indexOf(60702), 'lastIndexOf:', nodes.lastIndexOf(60702))
console.log('nodes[0..15]:', nodes.slice(0, 16).join(','))

// Distribution of events between 58227 and 60702 (what filled the seqs)
const byHour = {}
for (const e of events) {
  if (e.seq >= 58227 && e.seq <= 60702) {
    const bucket = Math.floor(e.seq / 500)
    byHour[bucket] = (byHour[bucket] || 0) + 1
  }
}
console.log('\nevent counts per 500-seq bucket between 58227..60702:')
for (const k of Object.keys(byHour).sort((a, b) => a - b)) {
  console.log(`  seq ${k * 500}..${k * 500 + 499}: ${byHour[k]}`)
}
const types = {}
for (const e of events) {
  if (e.seq >= 58227 && e.seq <= 60702) types[e.type] = (types[e.type] || 0) + 1
}
console.log('types in that range:', JSON.stringify(types))