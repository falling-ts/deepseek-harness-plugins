'use strict';
/*
 * Deterministic loadability proof: port the EXACT assertMessageEventShape logic
 * from packages/core/session/src/index.ts (lines 301-352) and run it over EVERY
 * surface message event in each session log. If every event passes, the whole
 * log will load (the load path runs this validator per event). Independent of
 * any running instance.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = process.argv[2] || path.join(os.homedir(), '.dsh', 'sessions');
const ZSTD_MAGIC = 0xfd2fb528;
function scanZstdFrames(buf) {
  const frames = []; let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`);
    offset += 4;
    if (offset === buf.length) return { frames, tornStart: start };
    const descriptor = buf.readUInt8(offset); offset += 1;
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
      const blockHeader = buf.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) { if (buf.length - offset < 4) return { frames, tornStart: start }; offset += 4; }
    frames.push({ start, end: offset });
  }
  return { frames };
}
function decodeLines(buffer) {
  const { frames } = scanZstdFrames(buffer);
  const lines = [];
  for (const f of frames) for (const l of zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8').split('\n')) if (l.length) lines.push(l);
  return lines;
}
function findFiles(dir, out = []) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) { const full = path.join(dir, e.name); if (e.isDirectory()) findFiles(full, out); else if (e.name === 'session.jsonl.zstd') out.push(full); }
  return out;
}

// --- EXACT port of assertMessageEventShape (core/session/src/index.ts:301) ---
function hasProviderModel(value) {
  if (typeof value !== 'object' || value === null) return false;
  return typeof value['provider'] === 'string' && value['provider'].length > 0
    && typeof value['model'] === 'string' && value['model'].length > 0;
}
function assertMessageEventShape(event, subject) {
  const type = event['type'];
  if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return;
  const data = event['data'];
  const record = (typeof data === 'object' && data !== null) ? data : undefined;
  const message = type === 'user/message' ? record : (record && record['message']);
  if (typeof message !== 'object' || message === null
    || typeof message['id'] !== 'string' || message['id'] === '') {
    throw new Error(`${subject} lacks an identified message`);
  }
  const expectedRole = type === 'assistant/message' ? 'assistant' : 'user';
  if (message['role'] !== expectedRole) throw new Error(`${subject} message must have role "${expectedRole}"`);
  const source = message['source'];
  if (typeof source !== 'object' || source === null
    || typeof source['kind'] !== 'string' || source['kind'] === '') {
    throw new Error(`${subject} message has invalid source`);
  }
  if (!Array.isArray(message['content'])) throw new Error(`${subject} message has invalid content`);
  if (type === 'assistant/message') {
    if (source['kind'] !== 'model' || !hasProviderModel(source)) throw new Error(`${subject} message must have model source`);
    return;
  }
  if (type !== 'tool/result') return;
  if (source['kind'] !== 'tool' || typeof source['callId'] !== 'string' || source['callId'] === '')
    throw new Error(`${subject} message must have tool source`);
  const content = message['content']; const block = content[0];
  if (content.length !== 1 || typeof block !== 'object' || block === null
    || block['type'] !== 'tool-result' || !Array.isArray(block['content']))
    throw new Error(`${subject} message must contain one tool-result block`);
  if (block['toolCallId'] !== source['callId']) throw new Error(`${subject} message has mismatched tool call ids`);
}
// --- end port ---

let grandPass = 0, grandFail = 0;
for (const file of findFiles(ROOT)) {
  const lines = decodeLines(fs.readFileSync(file));
  const events = lines.slice(1);
  let pass = 0, fail = 0;
  const failures = [];
  for (const line of events) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const type = rec['type'];
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') continue;
    try { assertMessageEventShape(rec, `seq ${rec.seq}`); pass++; }
    catch (e) { fail++; failures.push(`${type} seq=${rec.seq}: ${e.message}`); }
  }
  grandPass += pass; grandFail += fail;
  const id = path.basename(path.dirname(file));
  console.log(`${fail === 0 ? 'PASS' : 'FAIL'} ${id}: ${pass} surface message events ok, ${fail} failed`);
  for (const f of failures.slice(0, 20)) console.log(`     ! ${f}`);
}
console.log(`\nTOTAL: ${grandPass} pass, ${grandFail} fail across all logs`);
process.exit(grandFail === 0 ? 0 : 1);
