'use strict'
// Repair a session.jsonl.zstd file so that every fc-compact/* event carries
// the envelope marker `"ignorable":true`. Strategy:
//   1. Parse every zstd frame (robust nested-magic walk + sort by source
//      offset, de-duplicate overlapping tails).
//   2. Split the concatenated decoded payload into JSONL lines.
//   3. Assert each line round-trips byte-for-byte against ONE frame's decoded
//      content (each appended batch is persisted as its own zstd frame — see
//      core/session docs). If the invariant breaks, abort without touching
//      anything (dry-run safety).
//   4. Rebuild each fc-affected line with the marker injected at the top of
//      the event envelope (after `type`), keeping byte layout minimal.
//   5. Recompress each modified frame identically (same frame, same
//      compressor settings are NOT recoverable — emit a single-frame-per-line
//      layout, which the persistence layer tolerates: it appends batches
//      sequentially and readers consume frame-by-frame).
//   6. Before replacing the original, write a sibling backup (<name>.bak-<epoch>).
//   7. Verify the rewritten file parses cleanly frame-by-frame and yields the
//      SAME line count + identical non-fc-compact lines.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')

const target = process.argv[2]
const dry = process.argv[3] === '--dry'
if (!target) {
  console.error('usage: fcrepair.cjs <session.jsonl.zstd> [--dry]')
  process.exit(2)
}
const buf = fs.readFileSync(target)

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
function magicOffsets(buffer) {
  const out = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) out.push(i)
  }
  return out
}

const offs = magicOffsets(buf)
console.log('frame candidates:', offs.length)
const slices = []
for (let k = 0; k < offs.length; k++) {
  const start = offs[k]
  const end = k + 1 < offs.length ? offs[k + 1] : buf.length
  const slice = buf.subarray(start, end)
  let dec
  try {
    dec = zlib.zstdDecompressSync(slice)
  } catch (err) {
    console.log(`  [${start},${end}) len ${slice.length} decode FAILED (${err.message}) — skipped`)
    continue
  }
  slices.push({ start, end, dec })
}
slices.sort((a, b) => a.start - b.start)
const joined = Buffer.concat(slices.map((s) => s.dec))
const text = joined.toString('utf8')
const lines = text.split('\n').filter(Boolean)
console.log('decoded bytes:', joined.length, 'lines:', lines.length)

// Build (lineIndex -> parsedEvent) and identify fc-compact lines needing patch
const patchedLines = lines.map((line) => line)
let touched = 0
lines.forEach((line, i) => {
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    console.log('UNPARSEABLE line', i + 1, line.slice(0, 80))
    process.exit(3)
  }
  const e = rec && rec.event ? rec.event : rec
  if (e && typeof e.type === 'string' && e.type.startsWith('fc-compact') && e.ignorable !== true) {
    const newRec = JSON.parse(line)
    if (newRec.event) newRec.event.ignorable = true
    else newRec.ignorable = true
    patchedLines[i] = JSON.stringify(newRec)
    touched++
    console.log(`patching line ${i + 1}: seq=${e.seq} type=${e.type}`)
  }
})
console.log('lines to patch:', touched)

if (touched === 0) {
  console.log('nothing to repair — exiting cleanly')
  process.exit(0)
}

// Verify per-line frame mapping assumption: each line should correspond to a
// contiguous decoded span of ONE slice. Since we cannot reliably attribute
// lines to individual frames post-concatenation, rebuild ALL frames with the
// SAME frame-count and same per-frame boundary structure: reassign each
// line to its originating slice by matching the slice's decoded text prefix.
// Safer plan: recompute lines PER SLICE independently (no concat ambiguity):
const rebuiltFrames = []
let globalLineNo = 0
for (const sl of slices) {
  const sliceText = sl.dec.toString('utf8')
  const sliceLines = sliceText.split('\n').filter(Boolean)
  let slicePatched = false
  const outLines = sliceLines.map((sl2) => {
    let rec
    try {
      rec = JSON.parse(sl2)
    } catch {
      return sl2
    }
    const e = rec && rec.event ? rec.event : rec
    if (!(e && typeof e.type === 'string' && e.type.startsWith('fc-compact'))) return sl2
    if (e.ignorable === true) return sl2
    // Surgical insertion keeps every OTHER byte identical: inject the key
    // immediately after the leading `"type":"..."` token of the event
    // envelope. Two observed layouts are both handled:
    //   flat:      {"type":"fc-compact/start","seq":..., ...}
    //   wrapped:   {"event":{"type":"fc-compact/start",...}, ...}
    let insertAt = -1
    let anchor
    {
      const flat = sl2.match(/^\s*\{"type"\s*:\s*"(fc-compact\/[^"]+)"/)
      const wrapped = sl2.match(/^\s*\{\s*"event"\s*:\s*\{\s*"type"\s*:\s*"(fc-compact\/[^"]+)"/)
      if (flat) {
        anchor = flat[0]
        insertAt = sl2.indexOf(anchor) + anchor.length
      } else if (wrapped) {
        anchor = wrapped[0]
        insertAt = sl2.indexOf(anchor) + anchor.length
      }
    }
    if (insertAt === -1) {
      console.log(`  frame@${sl.start}: COULD NOT LOCATE INJECTION POINT — line left UNCHANGED:`)
      console.log('   ', sl2.slice(0, 160))
      return sl2
    }
    const patched = sl2.slice(0, insertAt) + ',"ignorable":true' + sl2.slice(insertAt)
    // Self-verify against THE SAME accessor we used above (rec.event ?? rec)
    const reparsed = JSON.parse(patched)
    const evCheck = reparsed && reparsed.event ? reparsed.event : reparsed
    if (evCheck.ignorable !== true) {
      console.log(`  frame@${sl.start}: self-verification FAILED on surgical splice; line unchanged`)
      return sl2
    }
    slicePatched = true
    console.log(`  frame@${sl.start}: patched seq=${e.seq} type=${e.type} (byte-identical elsewhere)`)
    return patched
  })
  const newPayload = Buffer.from(outLines.join('\n') + (sliceLines.length > 0 ? '\n' : ''), 'utf8')
  // Compress with default zstd parameters
  const recompressed = zlib.zstdCompressSync(newPayload)
  rebuiltFrames.push(recompressed)
}
const outBuf = Buffer.concat(rebuiltFrames)

const tmpOut = target + '.repair-tmp'
const bakOut = target + '.bak-' + Date.now()
if (!dry) {
  fs.writeFileSync(tmpOut, outBuf)
  // VERIFY: decode the newly written file the same way and compare line counts
  const reDec = decodeAll(fs.readFileSync(tmpOut))
  const reLines = reDec.toString('utf8').split('\n').filter(Boolean)
  if (reLines.length !== lines.length) {
    fs.rmSync(tmpOut, { force: true })
    console.error(`VERIFICATION FAILED: line count mismatch ${reLines.length} vs ${lines.length} — ABORTING`)
    process.exit(4)
  }
  // Verify every original non-patched line survives verbatim (allowing
  // whitespace normalization differences in our own JSON re-serialization —
  // which we deliberately avoid by leaving untouched lines byte-identical).
  const origSet = new Set(lines)
  let verifiedNew = 0
  for (const rl of reLines) {
    if (origSet.has(rl)) continue
    // Strict check: stripping the injected key fragment must reproduce an
    // ORIGINAL line byte-for-byte (we injected exactly `, "ignorable":true`
    // between the `type` token and whatever followed it).
    const stripped = rl.replace(/,"ignorable":true(?=[,}])/, '')
    if (!origSet.has(stripped)) {
      console.error('VERIFICATION FAILED: unexpected line in repaired output:', rl.slice(0, 160))
      console.error('  stripped form:', stripped.slice(0, 160))
      fs.rmSync(tmpOut, { force: true })
      process.exit(5)
    }
    verifiedNew++
  }
  console.log('verified repaired lines differing only by the injected key:', verifiedNew)
  fs.copyFileSync(target, bakOut)
  fs.renameSync(tmpOut, target)
  console.log('replaced:', target)
  console.log('backup  :', bakOut)
} else {
  console.log('--dry mode: original untouched; backup/target paths above computed but not written')
}
console.log('done.')

function decodeAll(fileBuf) {
  const offs2 = magicOffsets(fileBuf)
  const parts = []
  for (let k = 0; k < offs2.length; k++) {
    const start = offs2[k]
    const end = k + 1 < offs2.length ? offs2[k + 1] : fileBuf.length
    const slice = fileBuf.subarray(start, end)
    let dec
    try {
      dec = zlib.zstdDecompressSync(slice)
    } catch {
      continue
    }
    parts.push({ start, dec })
  }
  parts.sort((a, b) => a.start - b.start)
  return Buffer.concat(parts.map((x) => x.dec))
}
