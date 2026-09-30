// 对比两个 home 里 @falling-ts/* 的实际发布面（icon / locale / exports / files）
// 只读，不改任何东西。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Derive the checkout from this script's own location instead of a hardcoded drive path:
// the repo has moved once already (D:/deepseek-harness-plugins -> D:/AI/deepseek-harness-plugins).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const roots = [
  ['desktop ~/.dsh', path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@falling-ts')],
  ['web    ~/.dsh-web', path.join(os.homedir(), '.dsh-web', 'profiles', 'web', 'node_modules', '@falling-ts')],
  ['worktree (repo)', repoRoot],
];

function describe(label, dir, isWorktree) {
  console.log('\n=== ' + label + ' :: ' + dir);
  if (!fs.existsSync(dir)) { console.log('  (missing)'); return; }
  let names;
  if (isWorktree) {
    names = fs.readdirSync(dir).filter((n) => n.startsWith('dsh-') && fs.existsSync(path.join(dir, n, 'package.json')));
  } else {
    names = fs.readdirSync(dir);
  }
  for (const name of names) {
    const pkgDir = isWorktree ? path.join(dir, name) : path.join(dir, name);
    let real = pkgDir;
    try { real = fs.realpathSync(pkgDir); } catch { /* keep */ }
    const pj = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pj)) { console.log(`  - ${name}: no package.json`); continue; }
    let m;
    try { m = JSON.parse(fs.readFileSync(pj, 'utf8')); }
    catch (e) { console.log(`  - ${name}: BAD JSON (${e.message})`); continue; }
    const localeDir = path.join(pkgDir, 'locale');
    const localeFiles = fs.existsSync(localeDir) ? fs.readdirSync(localeDir) : [];
    const icons = fs.readdirSync(pkgDir).filter((f) => /\.(svg|png|jpe?g|webp)$/i.test(f));
    console.log(`  - ${m.name}@${m.version}`);
    console.log(`      dir        : ${pkgDir === real ? '' : '-> ' + real}`);
    console.log(`      icon field : ${m.icon === undefined ? '(absent -> falls back to package.json name)' : JSON.stringify(m.icon)}`);
    console.log(`      icon file  : ${icons.length ? icons.join(', ') : '(none in package root)'}`);
    console.log(`      locale/    : ${localeFiles.length ? localeFiles.join(', ') : '(absent -> no title/description meta)'}`);
    console.log(`      exports    : ${m.exports === undefined ? '(absent)' : JSON.stringify(m.exports)}`);
    console.log(`      files      : ${m.files === undefined ? '(absent)' : JSON.stringify(m.files)}`);
    for (const lf of localeFiles) {
      const p = path.join(localeDir, lf);
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log(`      ${lf} meta : ${JSON.stringify(j.meta ?? '(no meta key)')}`);
      } catch (e) { console.log(`      ${lf} : parse error ${e.message}`); }
    }
  }
}

for (const [label, dir, wt] of roots) describe(label, dir, !!wt);
