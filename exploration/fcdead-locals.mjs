#!/usr/bin/env node
// 极简: 对每文件每个 import 名与私有函数名, 打印"整文件去注释后出现次数"。
// ==1 意味着只在声明行出现 → 死码。==0 不可能(至少有声明)。供人工判定。
import fs from 'fs'; import path from 'path';
const ROOT = process.argv[2];
const files=[];
(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()&&!['node_modules','dist','coverage'].includes(e.name))w(p);else if(e.name.endsWith('.js'))files.push(p);}})(ROOT);
const strip=c=>c.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/\/\/[^\n]*/g,' ');
function wc(text,n){ const esc=n.replace(/[.*+?^${}()\\]/g,'\\$&'); const re=new RegExp('(?<![\\w$])'+esc+'(?![\\w$])','g'); return (text.match(re)||[]).length; }

for(const f of files){
  const raw=fs.readFileSync(f,'utf8'); const rel=f.replace(ROOT+path.sep,'');
  const lines=raw.split('\n');
  const privFuncs=[]; const impNames=[];
  for(const ln of lines){
    const t=ln.trimStart();
    const fm=ln.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if(fm && !t.startsWith('export')) privFuncs.push(fm[1]);
    const im=ln.match(/^import\s+\{([^}]*)\}\s*from/);
    if(im) for(let x of im[1].split(',')){x=x.trim().split(/\s+as\s+/).pop().trim(); if(x)impNames.push(x);}
  }
  const body=strip(raw);
  const notes=[];
  for(const n of impNames){ const c=wc(body,n); if(c<=1) notes.push('IMPORT  "'+n+'"  occ='+c); }
  for(const n of privFuncs){ const c=wc(body,n); if(c<=1) notes.push('PRIVFN  "'+n+'"  occ='+c); }
  if(notes.length){ console.log('### '+rel); for(const s of notes) console.log('   '+s); }
}
console.log('(scan done)');
