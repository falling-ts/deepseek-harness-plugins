#!/usr/bin/env node
// dump 一个 session 对象, 弄清 "忙/空闲" 到底怎么表示, 以及 create 的返回形状
const crypto=require('crypto'),http=require('http')
const B=`http://127.0.0.1:${process.argv[2]||'3180'}`
function post(m,p,t){return new Promise((res,rej)=>{const b=JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:m,payload:p});const r=http.request(B+'/api/'+m,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}});r.setTimeout(t||10000,()=>r.destroy(new Error('TIMEOUT')));r.on('error',rej);r.on('response',rs=>{let d='';rs.on('data',c=>d+=c);rs.on('end',()=>res({s:rs.statusCode,d}))});r.write(b);r.end()})}
(async()=>{
  const r=await post('session.list',{})
  console.log('--- session.list (trimmed) ---')
  console.log(r.d.slice(0,2500))
})().catch(e=>console.error('ERR',e.message))
