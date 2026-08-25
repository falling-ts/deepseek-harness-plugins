#!/usr/bin/env node
// FC-compact threshold test driver (threshold 30000 / ratio 0.7).
// Usage:
//   node fctestdrive.cjs <port> create                       -> create session, print sessionId
//   node fctestdrive.cjs <port> tokens <sessionId>           -> read current totalTokens + models usage
//   node fctestdrive.cjs <port> prompt <sessionId> <msg...>  -> queue a prompt (returns accepted)
//   node fctestdrive.cjs <port> history <sessionId> [tail]   -> last N history event types (+seq), default 40
const BASE = process.argv[2];
const CMD = process.argv[3];
const arg1 = process.argv[4];

function uuid(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);return v.toString(16)}) }

async function call(method,payload){
  const res=await fetch(`http://127.0.0.1:${BASE}/api/${method}`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:uuid(),method,payload})
  });
  const ct=res.headers.get('content-type')||'';
  if(!ct.includes('json')) throw new Error(`${method} -> HTTP ${res.status} (${ct}); body=${(await res.text()).slice(0,300)}`);
  const body=await res.json();
  const r=body.result;
  if(r&&typeof r.ok==='boolean'){
    if(!r.ok){
      const e=r.error||{};
      const err=new Error(`business error ${e.code}: ${e.message}${e.details?' :: '+JSON.stringify(e.details).slice(0,300):''}`);
      err.code=e.code; throw err;
    }
    return r.value;
  }
  return r;
}

(async()=>{
  switch(CMD){
    case 'create': {
      const v=await call('session.create',arg1&&arg1!=='-'?JSON.parse(arg1):{});
      console.log(JSON.stringify(v));
      break;
    }
    case 'tokens': {
      const sid=arg1;
      const m=await call('session.models',{sessionId:sid});
      console.log('current=',m.current);
      console.log(JSON.stringify(m,null,0).slice(0,1200));
      break;
    }
    case 'prompt': {
      const sid=arg1;
      const msg=process.argv.slice(5).join(' ');
      const v=await call('session.prompt',{sessionId:sid,mode:'queue',content:[{type:'text',text:msg}]});
      console.log(JSON.stringify(v));
      break;
    }
    case 'history': {
      const sid=arg1;
      const tail=parseInt(process.argv[5]||'40',10);
      const h=await call('session.history',{sessionId:sid,maxMessages:4000});
      const ev=h.events.map(x=>x.event);
      const types=ev.map(e=>`${e.seq}:${e.type}${e.data&&e.data.kind?'/'+e.data.kind:''}`).join(' ');
      console.log('events total:',ev.length,'projections keys:',h.projections?Object.keys(h.projections).join(','):'-');
      console.log('last '+Math.min(tail,ev.length)+':',ev.slice(-Math.min(tail,ev.length)).map(e=>`${e.seq}:${e.type}`).join(' '));
      break;
    }
    default:
      console.error('unknown cmd',CMD); process.exit(1);
  }
})().catch(err=>{console.error('ERR',err.code?err.code+' ':'',err.message);process.exit(2)});
