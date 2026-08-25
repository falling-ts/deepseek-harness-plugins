#!/usr/bin/env node
// 静态死代码审计: 列出每个导出符号的"定义文件"与"非定义引用(代码/文档)",
// 并找出"定义了但从未被任何文件以代码形式引用"的候选。
import fs from 'fs'; import path from 'path'; import os from 'os';
const ROOT = process.argv[2];
const files = [];
(function walk(dir){ for (const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name); if(e.isDirectory()){ if(!['node_modules','dist','coverage'].includes(e.name)) walk(p); } else if(e.name.endsWith('.js')) files.push(p); }})(ROOT);
const codes = new Map(); // rel -> content
for (const f of files) { const rel=f.replace(ROOT+path.sep,''); codes.set(rel, fs.readFileSync(f,'utf8')); }

// 收集所有 export 的名字(const/function/class/async function)
const exportNames = new Set();
for (const [rel,c] of codes) {
  for (const m of c.matchAll(/export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g)) exportNames.add(m[1]);
  // export { a, b } 形式
  for (const m of c.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (let item of m[1].split(',')) { item=item.trim().split(/\s+as\s+/)[0].trim(); if(item) exportNames.add(item); }
  }
}
console.log('== EXPORTED SYMBOLS ==', [...exportNames].sort().join(', '), '\n');

const results = [];
for (const sym of exportNames) {
  const defSites=[]; const codeRefs=[]; const docRefs=[];
  const esc=sym.replace(/[.*+?^${}()\\]/g,'\\$&');
  for (const [rel,c] of codes) {
    const lines=c.split('\n');
    for (let i=0;i<lines.length;i++){
      const line=lines[i];
      const isExportDecl = new RegExp('^\\s*export\\s+(?:async\\s+)?(?:const|function|class)\\s+'+esc+'\\b').test(line);
      const mentioned = new RegExp('\\b'+esc+'\\b').test(line);
      if(isExportDecl) defSites.push(`${rel}:${i+1}`);
      else if(mentioned){
        const trimmed=line.trim();
        const isDoc = trimmed.startsWith('*')||trimmed.startsWith('//')||trimmed.startsWith('/**');
        (isDoc?docRefs:codeRefs).push(`${rel}:${i+1}`);
      }
    }
  }
  results.push({sym, defSites, codeRefs, docRefs});
}
console.table(results.map(r=>({sym:r.sym, defs:r.defSites.join(';'), codeRefs:[...new Set(r.codeRefs)].slice(0,6).join('; '), docOnly:r.docRefs.slice(0,4).join(';')})));

// 高亮: 定义为某符号但代码引用为 0 的
console.log('\n== DEFINED BUT NO NON-DEF CODE REFERENCE (dead-code candidates) ==');
for (const r of results.filter(x=>x.codeRefs.length===0)) console.log('  CANDIDATE:', r.sym, 'defs=['+r.defSites.join(',')+'] docRefs='+r.docRefs.length);
