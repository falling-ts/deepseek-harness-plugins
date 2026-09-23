#!/usr/bin/env node
// node-modules-fit-audit.mjs — Is every workspace manifest's dependency declaration
// actually satisfied by the node_modules tree that is on disk right now?
//
// This deliberately does NOT trust `pnpm install`'s own report. It walks the real
// filesystem the way Node resolves modules:
//   * every workspace package (globs read from pnpm-workspace.yaml)
//   * every entry of dependencies / optionalDependencies / devDependencies
//   * every entry of peerDependencies (optional peers reported separately)
// and for each one ascends `<pkg>/node_modules/<spec>/package.json` up to the
// filesystem root, then compares the installed version against the declared range.
//
// Usage (from the harness checkout root):
//   node D:\deepseek-harness-plugins\exploration\node-modules-fit-audit.mjs [harnessRoot]
//
// Exit code 0 = no problems, 1 = at least one MISSING/MISMATCH, 2 = script error.

import { createRequire } from 'node:module';
import { readFileSync, existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HARNESS = path.resolve(process.argv[2] || 'D:\\deepseek-harness-plugins\\deepseek-harness');

// ---- semver: not a root devDependency, so load the copy pnpm keeps in .pnpm ----
function loadSemver() {
  const pnpmDir = path.join(HARNESS, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;
  const cands = readdirSync(pnpmDir)
    .filter((n) => /^semver@7\./.test(n))
    .sort()
    .reverse();
  for (const c of cands) {
    const dir = path.join(pnpmDir, c, 'node_modules', 'semver');
    if (existsSync(path.join(dir, 'package.json'))) {
      const req = createRequire(pathToFileURL(path.join(dir, 'package.json')).href);
      return { semver: req('semver'), from: dir };
    }
  }
  return null;
}

// ---- workspace glob expansion (pnpm-workspace.yaml lists one pattern per "- ") ----
function workspacePatterns() {
  const yml = readFileSync(path.join(HARNESS, 'pnpm-workspace.yaml'), 'utf8');
  const out = [];
  let inPackages = false;
  for (const raw of yml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break; // next top-level key
    if (!inPackages) continue;
    const m = /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function expandSegment(base, segs) {
  if (segs.length === 0) return [base];
  const [head, ...rest] = segs;
  if (head === '*' || head === '**') {
    if (!existsSync(base)) return [];
    const entries = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name));
    return entries.flatMap((e) => expandSegment(e, rest));
  }
  return expandSegment(path.join(base, head), rest);
}

function workspaceDirs() {
  const dirs = new Set();
  // pnpm counts the workspace root itself as a project ("Scope: all N workspace
  // projects" = glob members + root), so the root manifest must be audited too.
  if (existsSync(path.join(HARNESS, 'package.json'))) dirs.add(realpathSync(HARNESS));
  for (const pat of workspacePatterns()) {
    for (const d of expandSegment(HARNESS, pat.split('/'))) {
      if (existsSync(path.join(d, 'package.json'))) dirs.add(realpathSync(d));
    }
  }
  return [...dirs].sort();
}

// ---- node-style resolution: ascend node_modules dirs, following symlinks ----
function resolveInstalled(fromDir, spec) {
  let cur = fromDir;
  for (;;) {
    const cand = path.join(cur, 'node_modules', spec, 'package.json');
    if (existsSync(cand)) {
      try {
        const pj = JSON.parse(readFileSync(cand, 'utf8'));
        return { version: pj.version, dir: realpathSync(path.dirname(cand)) };
      } catch {
        return { version: null, dir: path.dirname(cand) };
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function specKind(spec) {
  if (spec.startsWith('workspace:')) return 'workspace';
  if (/^(link|file|portal):/.test(spec)) return 'local-link';
  if (spec.startsWith('catalog:')) return 'catalog';
  if (/^(npm|git|git\+|github|https?|jsr):/.test(spec)) return 'remote-alias';
  return 'range';
}

const issues = [];
const info = [];
let checkedEdges = 0;
let checkedWorkspace = 0;

const sem = loadSemver();

// 0) installed tree must correspond to the committed lockfile (pnpm stores it)
function sha256ish(buf) {
  // cheap equality + size is enough for the report; we report byte identity
  return buf.length;
}
try {
  const lock = readFileSync(path.join(HARNESS, 'pnpm-lock.yaml'));
  const installedLock = path.join(HARNESS, 'node_modules', '.pnpm', 'lock.yaml');
  if (!existsSync(installedLock)) {
    issues.push({ kind: 'NODE_MODULES_LOCK_MISSING', what: 'node_modules/.pnpm/lock.yaml' });
  } else {
    const a = readFileSync(installedLock);
    const same = a.length === lock.length && a.equals(lock);
    info.push(`lockfile-identity: node_modules/.pnpm/lock.yaml ${same ? '=== ' : '!= '} pnpm-lock.yaml (${lock.length} bytes)`);
    if (!same) issues.push({ kind: 'NODE_MODULES_LOCK_DIFFERS', what: 'node_modules/.pnpm/lock.yaml' });
  }
} catch (e) {
  issues.push({ kind: 'LOCK_READ_ERROR', what: String(e) });
}

const dirs = workspaceDirs();
const byName = new Map();
for (const d of dirs) {
  const pj = JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8'));
  byName.set(pj.name, { dir: d, version: pj.version });
}

for (const dir of dirs) {
  const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  checkedWorkspace++;
  const sections = ['dependencies', 'optionalDependencies', 'devDependencies'];
  for (const section of sections) {
    for (const [name, spec] of Object.entries(pj[section] || {})) {
      checkedEdges++;
      const kind = specKind(spec);
      if (kind === 'workspace') {
        const target = byName.get(name);
        if (!target) issues.push({ kind: 'WORKSPACE_TARGET_MISSING', pkg: pj.name, dep: name, spec, section });
        continue;
      }
      if (kind === 'local-link') {
        const p = path.resolve(dir, spec.replace(/^(link|file|portal):/, ''));
        if (!existsSync(path.join(p, 'package.json'))) {
          issues.push({ kind: 'LOCAL_LINK_TARGET_MISSING', pkg: pj.name, dep: name, spec, section, at: p });
        }
        continue;
      }
      if (kind === 'catalog') {
        issues.push({ kind: 'CATALOG_SPEC_NOT_AUDITED', pkg: pj.name, dep: name, spec, section });
        continue;
      }
      if (kind === 'remote-alias') continue;
      const found = resolveInstalled(dir, name);
      if (!found) {
        issues.push({ kind: 'MISSING', pkg: pj.name, dep: name, spec, section });
        continue;
      }
      if (sem && found.version && !sem.semver.satisfies(found.version, spec, { includePrerelease: true })) {
        issues.push({ kind: 'MISMATCH', pkg: pj.name, dep: name, spec, installed: found.version, section });
      }
    }
  }
  // peers (resolved from the package's own location; hoisting is not expected here)
  for (const [name, spec] of Object.entries(pj.peerDependencies || {})) {
    checkedEdges++;
    const optional = !!(pj.peerDependenciesMeta && pj.peerDependenciesMeta[name] && pj.peerDependenciesMeta[name].optional);
    const bucket = optional ? info : issues;
    const tag = (k) => (optional ? 'PEER_OPTIONAL_' + k : 'PEER_' + k);
    const kind = specKind(spec);
    if (kind === 'remote-alias') continue;
    if (kind === 'workspace') {
      if (!byName.get(name)) bucket.push({ kind: tag('TARGET_MISSING'), pkg: pj.name, dep: name, spec });
      continue;
    }
    if (kind === 'local-link') {
      const p = path.resolve(dir, spec.replace(/^(link|file|portal):/, ''));
      if (!existsSync(path.join(p, 'package.json'))) bucket.push({ kind: tag('LINK_TARGET_MISSING'), pkg: pj.name, dep: name, spec, at: p });
      continue;
    }
    if (kind === 'catalog') { bucket.push({ kind: tag('CATALOG_NOT_AUDITED'), pkg: pj.name, dep: name, spec }); continue; }
    const found = resolveInstalled(dir, name);
    if (!found) {
      bucket.push({ kind: tag('UNRESOLVED'), pkg: pj.name, dep: name, spec });
      continue;
    }
    if (sem && found.version && !sem.semver.satisfies(found.version, spec, { includePrerelease: true })) {
      bucket.push({ kind: tag('MISMATCH'), pkg: pj.name, dep: name, spec, installed: found.version });
    }
  }
}

const group = (arr, key) => {
  const m = new Map();
  for (const it of arr) {
    const k = it[key] || it.kind;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`harness root      : ${HARNESS}`);
console.log(`workspace packages: ${checkedWorkspace}`);
console.log(`dependency edges  : ${checkedEdges}`);
console.log(`semver engine     : ${sem ? `yes (${sem.from})` : 'NO — range checks skipped'}`);
console.log('');
for (const line of info) console.log('INFO  ' + (typeof line === 'string' ? line : JSON.stringify(line)));
if (info.length) {
  console.log('INFO grouped      : ' + group(info.filter((i) => typeof i !== 'string'), 'kind').map(([k, n]) => `${k}=${n}`).join(' '));
  console.log('');
}
if (issues.length === 0) {
  console.log('OK: every declared dependency/peer resolves from its own package and satisfies its range.');
  process.exit(0);
}
console.log(`PROBLEMS: ${issues.length}`);
for (const [k, n] of group(issues, 'kind')) console.log(`  ${k}: ${n}`);
console.log('');
for (const it of issues.slice(0, 200)) console.log('  ' + JSON.stringify(it));
if (issues.length > 200) console.log(`  ... ${issues.length - 200} more`);
process.exit(1);
