'use strict';
/*
 * Decode a dsh session.jsonl.zstd (concatenated Zstandard frames) and inspect
 * specific events. Zero external deps: uses node:zlib zstdDecompressSync plus
 * an inlined port of scanZstdFrames from session-persistence-jsonl.
 *
 * Usage:
 *   node inspect-corrupt-session.cjs <file.jsonl.zstd> [targetSeq]
 *
 * Prints frame layout, header, total record count, a (seq,type) index around
 * the target, and the full raw + parsed record for the target seq.
 */
const fs = require('node:fs');
const zlib = require('node:zlib');

const FILE = process.argv[2] ||
  'C:\\Users\\zghyu\\.dsh\\sessions\\--D-deepseek-harness-plugins--\\session-db44b595-dafc-4b8a-8d0d-c8c2d63e6a85\\session.jsonl.zstd';
const TARGET_SEQ = parseInt(process.argv[3] || '2264', 10);
const WINDOW = 4; // how many records on each side to list in the index

const buffer = fs.readFileSync(FILE);
process.stderr.write(`file bytes: ${buffer.length}\n`);

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
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved bit at ${offset - 1}`);
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
      if (blockType === 0x03) throw new Error(`reserved block type at ${offset - 3}`);
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
process.stderr.write(`complete frames: ${frames.length}; tornStart: ${tornStart}\n`);

const lines = [];
frames.forEach((f, i) => {
  const plain = zlib.zstdDecompressSync(buffer.subarray(f.start, f.end));
  const text = plain.toString('utf8');
  const ls = text.split('\n').filter(l => l.length > 0);
  for (const l of ls) lines.push({ line: l, frame: i });
  if (i === 0) process.stderr.write(`frame0 (header): ${ls.length} line(s)\n`);
});
if (tornStart !== undefined) {
  try {
    const plain = zlib.zstdDecompressSync(buffer.subarray(tornStart), {
      finishFlush: zlib.constants.ZSTD_e_flush,
    });
    const text = plain.toString('utf8');
    const ls = text.split('\n').filter(l => l.length > 0);
    for (const l of ls) lines.push({ line: l, frame: 'torn' });
    process.stderr.write(`torn frame recovered: ${ls.length} partial line(s)\n`);
  } catch (e) {
    process.stderr.write(`torn frame decode failed: ${e.message}\n`);
  }
}

// First line is the header record; the rest are session events.
const headerLine = lines[0] ? lines[0].line : null;
const events = lines.slice(1);
process.stderr.write(`total event records: ${events.length}\n`);

if (headerLine) {
  process.stdout.write('=== HEADER ===\n');
  process.stdout.write(headerLine + '\n\n');
}

// Build a (seq,type) index for all events.
const index = [];
events.forEach((e, idx) => {
  let seq = null, type = null, parseOk = true;
  try {
    const rec = JSON.parse(e.line);
    seq = rec.seq ?? rec.data?.seq ?? null;
    type = rec.type ?? rec.data?.type ?? null;
  } catch (err) { parseOk = false; }
  index.push({ idx, seq, type, parseOk });
});

// Print seq range and the window around target.
const seqs = index.map(x => x.seq).filter(s => typeof s === 'number');
if (seqs.length) process.stderr.write(`seq range: ${Math.min(...seqs)} .. ${Math.max(...seqs)}\n`);

process.stdout.write('=== EVENT INDEX (around target) ===\n');
const tpos = index.findIndex(x => x.seq === TARGET_SEQ);
if (tpos >= 0) {
  const lo = Math.max(0, tpos - WINDOW), hi = Math.min(index.length, tpos + WINDOW + 1);
  for (let i = lo; i < hi; i++) {
    const x = index[i];
    const mark = x.seq === TARGET_SEQ ? '  <== TARGET' : '';
    const flag = x.parseOk ? '' : '  [PARSE FAIL]';
    process.stdout.write(`idx=${String(x.idx).padStart(5)} seq=${String(x.seq).padStart(5)} type=${x.type}${flag}${mark}\n`);
  }
} else {
  process.stdout.write(`(target seq ${TARGET_SEQ} not found in index; showing tail)\n`);
  index.slice(-10).forEach(x => process.stdout.write(`idx=${x.idx} seq=${x.seq} type=${x.type}\n`));
}
process.stdout.write('\n');

// Full dump of the target record.
if (tpos >= 0) {
  const e = events[tpos];
  process.stdout.write(`=== TARGET seq ${TARGET_SEQ} (event index ${tpos}, frame ${e.frame}) ===\n`);
  process.stdout.write('RAW LINE:\n');
  process.stdout.write(e.line + '\n\n');
  try {
    const rec = JSON.parse(e.line);
    process.stdout.write('PARSED STRUCTURE:\n');
    process.stdout.write(JSON.stringify(rec, (k, v) => (typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + `...<+${v.length - 400}>` : v), 2) + '\n');
  } catch (err) {
    process.stdout.write(`(target line failed to parse: ${err.message})\n`);
  }
}
