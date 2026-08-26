const fs=require('fs');
const raw=fs.readFileSync(process.argv[2],'utf8');
const lines=raw.split(/\r?\n/);
console.log('TOTAL LINES:',lines.length);
lines.forEach((ln,i)=>{
  console.log(`${i+1}| len=${ln.length} :: ${JSON.stringify(ln.slice(0,80))}${ln.length>80?'...':'-'}`);
});
const enLn=lines.find(l=>l.includes('en:')&&l.includes(''));
const zhLn=lines.find(l=>l.includes('zh:')&&l.includes(''));
function analyze(label,line){
  const idx=line.indexOf(':"')+3;
  const scalar=line.slice(idx);
  const q=(scalar.match(/"/g)||[]).length;
  console.log(`${label}: scalarLen=${scalar.length} embeddedQuotes=${q} even=${q%2===0} endswithCloseQuote=${scalar.endsWith('"')}`);
  // Find the first unpaired close-quote (last char of scalar) — there must be exactly ONE pair
  let depth=0,lastBalanced=null;
  for(let i=0;i<scalar.length;i++){
    if(scalar[i]==='"'){
      depth++;
      if(depth===1){ /* start */ }
      if(depth>=2){
        // We've seen at least 2 quotes; track when we see the closing of the outermost
      }
    }
  }
}
if(enLn&&zhLn){
  analyze('EN',enLn);analyze('ZH',zhLn);
}else{
  console.log('MISSING en:/zh: scalars');
}
