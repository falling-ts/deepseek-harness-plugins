const fs=require('fs');
const p='data/plugins/falling-ts__dsh-force-compact.yml';
let s=fs.readFileSync(p,'utf8');
// Fix unescaped embedded double quotes inside double-quoted YAML scalars.
s=s.split('"none"').join('\u201cnone\u201d').split('"保留').join('\u201c保留').split('tokens"的').join('tokens\u201d的');
fs.writeFileSync(p,s);
console.log('==== FIXED FILE ====');
console.log(s);
// Validate
const yaml=require('./node_modules/yaml/dist/index.js');
const doc=yaml.parse(s);
console.log('==== VALIDATED ====');
console.log('KEYS:',Object.keys(doc));
console.log('EN:',doc.description.en.slice(0,80)+'...');
console.log('ZH:',doc.description.zh.slice(0,40)+'...');
