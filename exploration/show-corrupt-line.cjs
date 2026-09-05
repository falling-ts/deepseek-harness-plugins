'use strict';
/* Decode a session file, print the raw on-disk line for each user/message that
 * lacks id/role (the corrupt checkpoint pattern), plus its key set. */
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
console.log(`total lines (incl header) = ${lines.length}`);
let corruptCount = 0;
for (let i = 1; i < lines.length; i++) {
  let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
  if (rec.type !== 'user/message') continue;
  const m = rec.data;
  const badId = typeof m?.id !== 'string' || m.id === '';
  const badRole = m?.role !== 'user';
  if (!badId && !badRole) continue;
  corruptCount++;
  console.log(`\n--- corrupt user/message at line ${i} (seq ${rec.seq}) ---`);
  console.log(`keys of data: [${Object.keys(m || {}).join(', ')}]`);
  console.log(`source: ${JSON.stringify(m?.source)}`);
  console.log(`content blocks: ${Array.isArray(m?.content) ? m.content.length + ' [' + m.content.map(c => c.type).join(',') + ']' : typeof m?.content}`);
  console.log(`has sourceEventSeqs: ${'sourceEventSeqs' in (rec || {})}`);
  console.log(`RAW LINE (first 600 chars):\n${lines[i].slice(0, 600)}`);
}
console.log(`\ncorrupt user/message count = ${corruptCount}`);
