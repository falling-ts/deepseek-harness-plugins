'use strict';
/* Compare event counts + seq coverage between a repaired file and its .bak.
 * Decodes all frames -> lines; line 0 = header, rest = events. */
const fs = require('node:fs');
const zlib = require('node:zlib');
const ZSTD_MAGIC = 0xfd2fb528;
function scanZstdFrames(buf) {
  const frames = []; let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`);
    offset += 4;
    if (offset === buf.length) return { frames };
    const descriptor = buf.readUInt8(offset); offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) return { frames };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buf.length - offset < 3) return { frames };
      const blockHeader = buf.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) { if (buf.length - offset < 4) return { frames }; offset += 4; }
    frames.push({ start, end: offset });
  }
  return { frames };
}
function decodeEvents(file) {
  const { frames } = scanZstdFrames(fs.readFileSync(file));
  const lines = [];
  for (const f of frames) for (const l of zlib.zstdDecompressSync(fs.readFileSync(file).subarray(f.start, f.end)).toString('utf8').split('\n')) if (l.length) lines.push(l);
  return lines.slice(1); // drop header line
}
function summarize(file) {
  const ev = decodeEvents(file);
  const seqs = new Set(); const types = {}; const ids = new Set();
  for (const line of ev) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec['seq'] === 'number') seqs.add(rec['seq']);
    types[rec['type']] = (types[rec['type']] || 0) + 1;
    if (typeof rec['id'] === 'string') ids.add(rec['id']);
  }
  return { total: ev.length, seqCount: seqs.size, minSeq: seqs.size ? Math.min(...seqs) : null, maxSeq: seqs.size ? Math.max(...seqs) : null, types, uniqIds: ids.size };
}
for (const dir of process.argv.slice(2)) {
  const rep = dir + '/session.jsonl.zstd';
  const bak = dir + '/session.jsonl.zstd.bak';
  if (!fs.existsSync(rep) || !fs.existsSync(bak)) { console.log(`SKIP (missing pair): ${dir}`); continue; }
  const r = summarize(rep), b = summarize(bak);
  console.log(`\n=== ${dir.split('\\').pop()} ===`);
  console.log(`  repaired: total=${r.total} seqs=${r.seqCount} [${r.minSeq}..${r.maxSeq}] uniqIds=${r.uniqIds}`);
  console.log(`  backup  : total=${b.total} seqs=${b.seqCount} [${b.minSeq}..${b.maxSeq}] uniqIds=${b.uniqIds}`);
  const ok = r.total === b.total && r.seqCount === b.seqCount && r.minSeq === b.minSeq && r.maxSeq === b.maxSeq;
  console.log(`  MATCH: ${ok ? 'YES ✓ (all events preserved)' : 'NO ✗ (DISCREPANCY)'}`);
  if (r.uniqIds !== b.uniqIds) console.log(`  NOTE: id count differs (${r.uniqIds} vs ${b.uniqIds}) — expected if repair minted ids on previously-idless checkpoints`);
}
