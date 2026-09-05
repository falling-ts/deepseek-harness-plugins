'use strict';
/*
 * Repair corrupt force-compact checkpoint lines (user/message lacking id/role)
 * in a session log WITHOUT re-serializing any line.
 *
 * Why byte surgery: on-disk lines carry range-encoded sourceEventSeqs and
 * packed chunk rows; parse->modify->stringify would corrupt those. Instead we
 * decode all frames -> raw lines (byte-identical), and for ONLY the corrupt
 * user/message lines we insert "id":"<uuid>","role":"user", immediately after
 * "data":{"content" (content is always the first key in a checkpoint's data).
 *
 * Re-encodes as header frame + single event frame (the backend's own
 * fresh-session format; the reader is layout-blind). Atomic temp+rename write.
 * Backs up the original first (does not clobber an existing backup).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const ZSTD_MAGIC = 0xfd2fb528;
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

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
function uuid() {
  try { return crypto.randomUUID(); } catch { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
}
function isCorruptUserMessage(line) {
  let rec; try { rec = JSON.parse(line); } catch { return false; }
  if (rec.type !== 'user/message') return false;
  const m = rec.data;
  if (typeof m !== 'object' || m === null) return false;
  const badId = typeof m.id !== 'string' || m.id === '';
  const badRole = m.role !== 'user';
  return badId || badRole;
}

function repair(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  const lines = [];
  for (const f of frames) for (const l of zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8').split('\n')) if (l.length) lines.push(l);
  if (lines.length < 2) throw new Error('no events found');

  const headerLine = lines[0];
  const eventLines = lines.slice(1);
  let fixed = 0;
  const fixedSeqs = [];
  for (let i = 0; i < eventLines.length; i++) {
    if (!isCorruptUserMessage(eventLines[i])) continue;
    const anchor = '"data":{"content"';
    const idx = eventLines[i].indexOf(anchor);
    if (idx === -1) throw new Error(`corrupt line ${i + 1} does not contain "data":{"content" anchor; refusing to guess`);
    const id = uuid();
    const replacement = `"data":{"id":"${id}","role":"user","content"`;
    eventLines[i] = eventLines[i].slice(0, idx) + replacement + eventLines[i].slice(idx + anchor.length);
    let seq; try { seq = JSON.parse(eventLines[i]).seq; } catch { seq = '?'; }
    fixedSeqs.push({ line: i + 2, seq, id });
    fixed++;
  }
  if (fixed === 0) { console.log(`no corrupt user/message lines in ${file}; nothing to do`); return; }

  // Backup (never clobber an existing backup).
  const bakBase = file + '.bak';
  let backup = bakBase;
  let n = 2;
  while (fs.existsSync(backup)) backup = bakBase + n++;
  fs.copyFileSync(file, backup);
  console.log(`backup: ${path.basename(backup)} (${fs.statSync(backup).size} bytes)`);

  // Re-encode: header frame + single event frame.
  const header = headerLine + '\n';
  const body = eventLines.join('\n') + '\n';
  const headerFrame = zlib.zstdCompressSync(Buffer.from(header, 'utf8'), CHECKSUM_OPTIONS);
  const eventFrame = zlib.zstdCompressSync(Buffer.from(body, 'utf8'), CHECKSUM_OPTIONS);
  const out = Buffer.concat([headerFrame, eventFrame]);

  // Atomic temp + rename.
  const tmp = path.join(path.dirname(file), `.repair-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
  console.log(`repaired ${fixed} corrupt checkpoint(s) in ${path.basename(file)} -> ${out.length} bytes`);
  for (const f of fixedSeqs) console.log(`   seq ${f.seq} (line ${f.line}) minted id ${f.id}`);
}

for (const file of process.argv.slice(2)) repair(file);
