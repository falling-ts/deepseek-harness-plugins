const fs=require('fs');
function swapLines(path, newLine){
  const lines=fs.readFileSync(path,'utf8').split(/\r?\n/);
  let hits=0;
  lines.forEach((ln,i)=>{
    if(ln.startsWith('- [falling-ts/dsh-force-compact]')){
      lines[i]=newLine; hits++;
    }
  });
  fs.writeFileSync(path, lines.join('\n'));
  return hits;
}
const h1=swapLines('D:\\deepseek-harness-plugins\\awesome-dsh-plugin\\README.md',
  '- [falling-ts/dsh-force-compact](https://github.com/falling-ts/dsh-force-compact) - Threshold-gated context compaction on pre-step and turn-end, driven by a retain-latest-token budget, plus wire-level reasoning_off for llama.cpp endpoints.');
const h2=swapLines('D:\\deepseek-harness-plugins\\awesome-dsh-plugin\\README.zh.md',
  '- [falling-ts/dsh-force-compact](https://github.com/falling-ts/dsh-force-compact) — pre-step 与 turn-end 阈值门控的上下文压缩，按“保留最新 N tokens”预算截断，并为 llama.cpp 端点做 wire 层的 reasoning_off。');
console.log(`README.md: ${h1} hit(s), README.zh.md: ${h2} hit(s)`);

// Verify
['D:\\deepseek-harness-plugins\\awesome-dsh-plugin\\README.md','D:\\deepseek-harness-plugins\\awesome-dsh-plugin\\README.zh.md'].forEach(p=>{
  const l=fs.readFileSync(p,'utf8').split(/\r?\n/).find(x=>x.startsWith('- [falling-ts/dsh-force-compact]'));
  console.log(`\n--- ${require('path').basename(p)} ---`);
  console.log(`total-len=${l.length}`);
  // Extract trailing description part after "] - " or "] — "
  const sepIdx=l.lastIndexOf('] ');
  const descPart = l.slice(sepIdx+3);
  console.log(`desc-part-len=${descPart.length}`);
  console.log(descPart.slice(0,100)+(descPart.length>100?'…':''));
});
