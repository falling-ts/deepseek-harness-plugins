'use strict';
/*
 * Scan a dsh session.jsonl.zstd for the force-compact corruption pattern:
 * surface `user/message` (and any assistant/message / tool/result) events whose
 * message payload lacks the required `id` (and `role`), which makes the whole
 * log fail `assertMessageEventShape` on load. Also counts compact checkpoints.
 *
 * Usage: node scan-checkpoints.cjs <file.jsonl.zstd>
 */
const fs = require('node:fs');
const zlib = require('node:zlib');

const FILE = process.argv[2];
if (!FILE) { console.error('usage: node scan-checkpoints.cjs <file.jsonl.zstd>'); process.exit(2); }
const buffer = fs.readFileSync(FILE);

const ZSTD_MAGIC = 0xfd2fb528;
function scanZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`);
    offset += 4;
    if (offset === buf.length) return { frames, tornStart: start };
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

const { frames, tornStart } = scanZstdFrames(buffer);
const lines = [];
for (const f of frames) {
  const text = zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8');
  for (const l of text.split('\n')) if (l.length) lines.push(l);
}
if (tornStart !== undefined) {
  try {
    const text = zlib.zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: zlib.constants.ZSTD_e_flush }).toString('utf8');
    for (const l of text.split('\n')) if (l.length) lines.push(l);
  } catch { /* ignore torn */ }
}

// lines[0] is the header; the rest are events.
const events = lines.slice(1);
let totalMsg = 0, missingId = 0, compactCheckpoints = 0, withId = 0;
const bad = [];
for (const line of events) {
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const t = rec.type;
  if (t !== 'user/message' && t !== 'assistant/message' && t !== 'tool/result') continue;
  totalMsg++;
  const data = rec.data || {};
  const message = t === 'user/message' ? data : data.message;
  if (!message || typeof message !== 'object') continue;
  const id = message.id;
  const role = message.role;
  const src = message.source || {};
  const isCheckpoint = src.kind === 'plugin' && src.plugin === 'compact';
  if (isCheckpoint) compactCheckpoints++;
  if (typeof id === 'string' && id.length > 0) withId++;
  else {
    missingId++;
    bad.push({
      seq: rec.seq,
      type: t,
      id: id === undefined ? '(absent)' : JSON.stringify(id),
      role: role === undefined ? '(absent)' : role,
      sourceKind: src.kind,
      compactionId: src.compactionId || null,
      sourceOp: rec.surfaceOp ? rec.surfaceOp.op : null,
    });
  }
}

console.log(`surface message events: ${totalMsg}`);
console.log(`  with non-empty id:    ${withId}`);
console.log(`  MISSING id (corrupt): ${missingId}`);
console.log(`  compact checkpoints:  ${compactCheckpoints}`);
console.log(`\n--- events lacking an identified message ---`);
if (bad.length === 0) console.log('  (none)');
for (const b of bad) {
  console.log(`  seq=${String(b.seq).padStart(5)} type=${b.type} id=${b.id} role=${b.role} source.kind=${b.sourceKind} compactionId=${b.compactionId} op=${b.sourceOp}`);
}
