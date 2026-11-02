import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function nextMessage(ws,predicate,timeout=5000){
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',onMsg);reject(new Error('Timed out waiting for game state'));},timeout);
  function onMsg(data){
   try{const obj=JSON.parse(data.toString());if(predicate(obj)){clearTimeout(timer);ws.off('message',onMsg);resolve(obj);}}
   catch{}
  }
  ws.on('message',onMsg);
 });
}
async function connect(url){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(url);
  ws.once('open',()=>resolve(ws));ws.once('error',reject);
 });
}
test('server starts, creates room, syncs physics parts and permits joins', {timeout:25000},async t=>{
 const port=26000+Math.floor(Math.random()*3000);
 const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const clients=[];
 t.after(()=>{for(const ws of clients)ws.terminate();child.kill();});
 let ready=false;
 for(let i=0;i<65;i++){
  if(child.exitCode!==null)break;
  try{const response=await fetch('http://127.0.0.1:'+port+'/healthz');if(response.ok){const data=await response.json();assert.equal(data.ok,true);ready=true;break;}}catch{}
  await delay(100);
 }
 assert.ok(ready,'server did not start: '+output.slice(-1000));
 const ws=await connect('ws://127.0.0.1:'+port+'/socket');clients.push(ws);
 const welcomed=nextMessage(ws,m=>m.type==='welcome');
 ws.send(JSON.stringify({type:'create',name:'TestBuilder',color:'#55ddff'}));
 const me=await welcomed;assert.match(me.code,/^[A-Z2-9]{6}$/);
 const other=await connect('ws://127.0.0.1:'+port+'/socket');clients.push(other);
 const joined=nextMessage(other,m=>m.type==='welcome');
 other.send(JSON.stringify({type:'join',code:me.code,name:'Friend'}));
 const friend=await joined;assert.equal(friend.code,me.code);
 const snapshot=nextMessage(ws,m=>m.type==='state'&&m.players.length===2);
 await snapshot;
 const spawned=nextMessage(ws,m=>m.type==='state'&&m.parts.some(p=>p.shape==='box'),6000);
 ws.send(JSON.stringify({type:'spawn',shape:'box',size:[2,1,2],x:0,y:4,z:-3,color:'#aaff77'}));
 const seen=await spawned;assert.equal(seen.players.length,2);assert.ok(seen.parts.length>=1);
 await delay(100);
 const nextPart=nextMessage(ws,m=>m.type==='state'&&m.parts.length>=2);
 ws.send(JSON.stringify({type:'spawn',shape:'cylinder',kind:'motor',size:[1,1,1],x:2,y:4,z:-3,color:'#55ffaa'}));
 const paired=await nextPart;
 const a=paired.parts[0].id,b=paired.parts[1].id;
 await delay(100);
 const motorJoint=nextMessage(ws,m=>m.type==='state'&&m.joints.some(j=>j.type==='motor'),6000);
 ws.send(JSON.stringify({type:'joint',a,b,jointType:'motor',speed:2}));
 await motorJoint;
 await delay(100);
 const wired=nextMessage(ws,m=>m.type==='state'&&m.wires.length>=1,6000);
 ws.send(JSON.stringify({type:'wire',from:a,to:b}));
 await wired;
 await delay(100);
 const spawnedNpc=nextMessage(ws,m=>m.type==='state'&&m.npcs.length>=1,6000);
 ws.send(JSON.stringify({type:'npc',name:'Robot',mode:'follow',x:0,y:2,z:-2}));
 const npcState=await spawnedNpc;
 assert.equal(npcState.npcs[0].mode,'follow');
 const exported=nextMessage(ws,m=>m.type==='export',5000);
 ws.send(JSON.stringify({type:'export'}));
 const save=await exported;assert.equal(save.snapshot.format,'CHAOS-LUV');
 assert.ok(save.snapshot.joints.length>=1);
});
