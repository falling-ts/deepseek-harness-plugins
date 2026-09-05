'use strict';
/*
 * Locate every corrupt dsh session log under ~/.dsh/sessions (the force-compact
 * pattern: a surface `user/message` whose message payload lacks a non-empty `id`),
 * and print the EXACT raw on-disk line of each bad event so the surgical repair
 * can verify its insertion point. Read-only.
 *
 * Usage: node locate-corrupt.cjs [sessionsRoot]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = process.argv[2] || path.join(os.homedir(), '.dsh', 'sessions');

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

function decodeLines(buffer) {
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
  return lines;
}

function findFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(full, out);
    else if (e.name === 'session.jsonl.zstd') out.push(full);
  }
  return out;
}

const files = findFiles(ROOT);
let corruptCount = 0;
for (const file of files) {
  let buffer;
  try { buffer = fs.readFileSync(file); } catch (e) { console.log(`SKIP (unreadable) ${file}: ${e.message}`); continue; }
  let lines;
  try { lines = decodeLines(buffer); } catch (e) { console.log(`SKIP (decode) ${file}: ${e.message}`); continue; }
  const events = lines.slice(1);
  const bad = [];
  for (const line of events) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'user/message') continue;
    const data = rec.data || {};
    if (typeof data.id !== 'string' || data.id.length === 0) bad.push({ line, rec });
  }
  if (bad.length === 0) continue;
  corruptCount++;
  console.log(`\n=== CORRUPT: ${file}  (${bad.length} bad user/message) ===`);
  for (const { line } of bad) {
    // Show the raw line, clipped, plus the exact `"data":{` anchor.
    const anchor = line.indexOf('"data":{');
    console.log(`  [raw, ${line.length} chars, "data":{ at ${anchor}]`);
    console.log(`  head: ${line.slice(0, 160)}`);
    if (anchor >= 0) console.log(`  around data: ${line.slice(anchor, anchor + 120)}`);
  }
}
console.log(`\nTotal session logs scanned: ${files.length}; corrupt: ${corruptCount}`);
