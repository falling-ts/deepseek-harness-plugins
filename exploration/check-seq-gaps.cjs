'use strict';
/* Check the on-disk seq sequence for gaps (which would indicate dropped
 * events). Decodes all frames -> lines, collects event seqs, reports gaps. */
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
    const csFlag = descriptor >>> 6;
    const single = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictFlag = descriptor & 0x03;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const csBytes = csFlag === 0 ? (single ? 1 : 0) : 1 << csFlag;
    const rem = (single ? 0 : 1) + dictBytes + csBytes;
    if (buf.length - offset < rem) return { frames };
    offset += rem;
    for (;;) {
      if (buf.length - offset < 3) return { frames };
      const bh = buf.readUIntLE(offset, 3); offset += 3;
      const last = (bh & 1) !== 0;
      const bt = (bh >>> 1) & 0x03;
      const bs = bh >>> 3;
      const payload = bt === 1 ? 1 : bs;
      if (buf.length - offset < payload) return { frames };
      offset += payload;
      if (last) break;
    }
    if (checksum) { if (buf.length - offset < 4) return { frames }; offset += 4; }
    frames.push({ start, end: offset });
  }
  return { frames };
}
const file = process.argv[2];
const buf = fs.readFileSync(file);
const { frames } = scanZstdFrames(buf);
const lines = [];
for (const f of frames) for (const l of zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8').split('\n')) if (l.length) lines.push(l);
const seqs = new Set();
let dup = 0;
for (let i = 1; i < lines.length; i++) {
  let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
  if (typeof rec.seq !== 'number') continue;
  if (seqs.has(rec.seq)) dup++;
  seqs.add(rec.seq);
}
const sorted = [...seqs].sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) gaps.push([sorted[i - 1] + 1, sorted[i], sorted[i] - sorted[i - 1] - 1]);
console.log(`events=${lines.length - 1} uniqSeqs=${seqs.size} dupSeqs=${dup}`);
console.log(`minSeq=${sorted[0]} maxSeq=${sorted[sorted.length - 1]}`);
console.log(`expectedSpan=${sorted[sorted.length - 1] - sorted[0] + 1} (maxSeq-minSeq+1)`);
console.log(`gaps=${gaps.length}`);
if (gaps.length) {
  console.log('  first 15 gaps [fromMissing..toNext, size]:');
  for (const g of gaps.slice(0, 15)) console.log(`    ${g[0]}..${g[1]} (missing ${g[2]})`);
  const totalMissing = gaps.reduce((s, g) => s + g[2], 0);
  console.log(`  TOTAL missing seqs across gaps = ${totalMissing}`);
}
