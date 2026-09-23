#!/usr/bin/env node
// node-modules-link-integrity.mjs — a half-finished/degraded pnpm install leaves
// dangling symlinks (or missing workspace links) behind. Walk the real tree,
// follow nothing, and report every symlink whose target does not exist.
//
// Usage: node D:\deepseek-harness-plugins\exploration\node-modules-link-integrity.mjs [root]

import { readdirSync, lstatSync, existsSync, realpathSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || 'D:\\deepseek-harness-plugins\\deepseek-harness');
const SKIP = new Set(['.git']);
let symlinks = 0;
let dangling = [];
let dirsVisited = 0;

function walk(dir) {
  dirsVisited++;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      symlinks++;
      let ok = false;
      let target = null;
      try {
        target = readlinkSync(p);
      } catch {
        target = null;
      }
      try {
        ok = existsSync(realpathSync(p));
      } catch {
        ok = false;
      }
      if (!ok) dangling.push({ link: path.relative(ROOT, p), target });
      // never descend through a symlink: the target is walked where it lives
      continue;
    }
    if (st.isDirectory() && (e.name === 'node_modules' || dir === ROOT || dir.includes('node_modules'))) {
      walk(p);
    } else if (st.isDirectory() && e.name !== 'node_modules') {
      // descend only into directories that can contain node_modules trees
      walk(p);
    }
  }
}

walk(ROOT);

console.log(`root            : ${ROOT}`);
console.log(`dirs visited    : ${dirsVisited}`);
console.log(`symlinks found  : ${symlinks}`);
console.log(`dangling links  : ${dangling.length}`);
for (const d of dangling.slice(0, 50)) console.log('  DANGLING ' + d.link + (d.target ? ' -> ' + d.target : ''));
process.exit(dangling.length === 0 ? 0 : 1);
