'use strict';
/* Count event lines (excl header) in a file and its .bak / .bak2, to detect
 * whether the repair's read->rename window lost in-flight appends. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const M = 0xfd2fb528;
function frames(b) {
  const r = []; let o = 0;
  while (o < b.length) {
    const start = o;
    if (b.length - o < 4) break;
    if (b.readUInt32LE(o) !== M) break;
    o += 4;
    if (o === b.length) break;
    const d = b.readUInt8(o); o++;
    const cf = d >>> 6, s = (d & 0x20) !== 0, ck = (d & 0x04) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df, cs = cf === 0 ? (s ? 1 : 0) : 1 << cf;
    const rem = (s ? 0 : 1) + db + cs;
    if (b.length - o < rem) break;
    o += rem;
    for (;;) {
      if (b.length - o < 3) break;
      const bh = b.readUIntLE(o, 3); o += 3;
      const l = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      const p = bt === 1 ? 1 : bs;
      if (b.length - o < p) break;
      o += p;
      if (l) break;
    }
    if (ck) { if (b.length - o < 4) break; o += 4; }
    r.push([start, o]);
  }
  return r;
}
function cnt(file) {
  if (!fs.existsSync(file)) return null;
  const b = fs.readFileSync(file);
  const fr = frames(b);
  let n = 0;
  for (const [s, e] of fr) n += zlib.zstdDecompressSync(b.subarray(s, e)).toString('utf8').split('\n').filter(x => x.length).length;
  return n;
}
const dir = process.argv[2];
const base = path.join(dir, 'session.jsonl.zstd');
const cur = cnt(base);
const bak = cnt(base + '.bak');
const bak2 = cnt(base + '.bak2');
console.log(path.basename(dir));
console.log(`  current   : ${cur} lines (incl header) = ${cur - 1} events`);
console.log(`  .bak (orig): ${bak} lines = ${bak - 1} events`);
console.log(`  .bak2      : ${bak2} lines = ${bak2 - 1} events`);
if (cur !== null && bak2 !== null) {
  console.log(`  current vs .bak2 delta = ${cur - bak2} events (0 = no in-flight loss in last repair window)`);
}
