import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, statSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { cleanName, roomCode, clamp, safeNumber, sanitizeColor, buildPartData, withinDistance } from './shared/rules.mjs';

await RAPIER.init();
const PORT = Number(process.env.PORT || 3000);
const MAX_PARTS = 220;
const MAX_NPCS = 16;
const MAX_JOINTS = 260;
const rooms = new Map();
const ID = () => Math.random().toString(36).slice(2, 11);
const V = (x=0,y=0,z=0) => ({x,y,z});
const quat = () => ({x:0,y:0,z:0,w:1});
const DT = 1 / 30;
const WORLD_SIZE = 72;
const DIST = 22;
function makeRoom(code) {
  const world = new RAPIER.World(V(0,-9.81,0));
  world.integrationParameters.dt = DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0,-.5,0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(WORLD_SIZE, .5, WORLD_SIZE).setFriction(.9), ground);
  const room = {code,world,players:new Map(),parts:new Map(),joints:new Map(),npcs:new Map(),wires:new Map(),host:null,gravity:-9.81,time:0,lastSeen:Date.now(),log:[],paused:false};
  rooms.set(code, room);
  // The starter playground contains no user-owned constructions.
  return room;
}
function send(ws, data) { if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function cast(room, data) { const s=JSON.stringify(data); for(const p of room.players.values()) if(p.ws.readyState===WebSocket.OPEN) p.ws.send(s); }
function err(ws,message) { send(ws,{type:'error',message}); }
function playerView(p) { const q=p.body.translation(); return {id:p.id,name:p.name,color:p.color,x:q.x,y:q.y,z:q.z,look:p.look}; }
function partView(o) {
  const p=o.body.translation(), q=o.body.rotation();
  return {id:o.id,owner:o.owner,shape:o.shape,kind:o.kind,size:o.size,color:o.color,material:o.material,locked:o.locked,
    x:p.x,y:p.y,z:p.z,qx:q.x,qy:q.y,qz:q.z,qw:q.w,signal:o.signal||0,speed:o.speed||0,label:o.label||'',groupId:o.groupId||null};
}
function npcView(n) { const p=n.body.translation();return {id:n.id,name:n.name,mode:n.mode,x:p.x,y:p.y,z:p.z,color:n.color,riding:n.riding||null}; }
function jointView(j) { return {id:j.id,a:j.a,b:j.b,type:j.type,speed:j.speed||0,enabled:j.enabled!==false,length:j.length||0}; }
function wireView(w) { return {id:w.id,from:w.from,to:w.to}; }
function fullState(r) {
  return {type:'state',code:r.code,host:r.host,gravity:r.gravity,paused:r.paused,players:[...r.players.values()].map(playerView),
    parts:[...r.parts.values()].map(partView),joints:[...r.joints.values()].map(jointView),
    npcs:[...r.npcs.values()].map(npcView),wires:[...r.wires.values()].map(wireView),serverTime:Date.now()};
}
function createBody(room, d) {
  const desc=d.locked ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
  const rb=room.world.createRigidBody(desc.setTranslation(d.x,d.y,d.z).setLinearDamping(.25).setAngularDamping(.3));
  const sx=d.size[0],sy=d.size[1],sz=d.size[2];
  let c;
  if (d.shape==='sphere') c=RAPIER.ColliderDesc.ball(Math.max(.12,sx/2));
  else if (d.shape==='cylinder') c=RAPIER.ColliderDesc.cylinder(Math.max(.12,sy/2),Math.max(.12,sx/2));
  else c=RAPIER.ColliderDesc.cuboid(sx/2,sy/2,sz/2);
  const props = d.material==='rubber' ? [1.2,.9,.35] : d.material==='metal' ? [5,.5,.05] : d.material==='ice' ? [.9,.02,.02] : [1,.75,.12];
  room.world.createCollider(c.setDensity(props[0]).setFriction(props[1]).setRestitution(props[2]),rb);
  return rb;
}
function addPart(room, playerId, input, forcedId) {
  if(room.parts.size>=MAX_PARTS) return null;
  const d=buildPartData(input);
  const id=forcedId||ID();
  const o={...d,id,owner:playerId,body:createBody(room,d),signal:0,manual:false,enabled:true,groupId:typeof d.groupId==='string'?d.groupId.slice(0,40):null};
  room.parts.set(id,o);return o;
}
function hasEdit(r,p,o) { return p.id===r.host || o.owner===p.id; }
function removeJoint(r,id) {
  const j=r.joints.get(id);if(!j)return;
  if(j.rapier) {try{r.world.removeImpulseJoint(j.rapier,true);}catch{}}
  r.joints.delete(id);
}
function removePart(r,id) {
  const o=r.parts.get(id);if(!o)return;
  for(const j of [...r.joints.values()]) if(j.a===id||j.b===id)removeJoint(r,j.id);
  for(const w of [...r.wires.values()]) if(w.from===id||w.to===id)r.wires.delete(w.id);
  for(const n of r.npcs.values()) if(n.riding===id)n.riding=null;
  r.world.removeRigidBody(o.body);r.parts.delete(id);
}
function createJoint(r,aId,bId,type,speed,length,forcedId) {
  if(aId===bId || r.joints.size>=MAX_JOINTS || !r.parts.has(aId)||!r.parts.has(bId))return null;
  const a=r.parts.get(aId),b=r.parts.get(bId);
  const offset=V(b.body.translation().x-a.body.translation().x,b.body.translation().y-a.body.translation().y,b.body.translation().z-a.body.translation().z);
  const anchorA=V(offset.x/2,offset.y/2,offset.z/2),anchorB=V(-offset.x/2,-offset.y/2,-offset.z/2);
  let data=null,rapier=null;
  const axis=V(0,1,0);
  if(type==='fixed') data=RAPIER.JointData.fixed(anchorA,quat(),anchorB,quat());
  if(type==='hinge'||type==='motor') data=RAPIER.JointData.revolute(anchorA,anchorB,axis);
  if(type==='piston') {
    data=RAPIER.JointData.prismatic(anchorA,anchorB,axis);
    data.limitsEnabled=true;data.limits=[-2.5,2.5];
  }
  if(data) {
    try {rapier=r.world.createImpulseJoint(data,a.body,b.body,true);}
    catch(e){console.warn('joint:',e.message);return null;}
  }
  const j={id:forcedId||ID(),a:aId,b:bId,type,speed:clamp(safeNumber(speed,2),-20,20),length:clamp(safeNumber(length,Math.hypot(offset.x,offset.y,offset.z)),.3,18),rapier,enabled:true};
  r.joints.set(j.id,j);return j;
}
function spawnNpc(r,name,mode,color,x,y,z,forcedId) {
  if(r.npcs.size>=MAX_NPCS)return null;
  const rb=r.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x,y,z).setLinearDamping(2).lockRotations());
  r.world.createCollider(RAPIER.ColliderDesc.capsule(.36,.27).setDensity(.5).setFriction(.8),rb);
  const n={id:forcedId||ID(),name:cleanName(name||'NPC'),mode: ['wander','follow','work','ride','idle'].includes(mode)?mode:'wander',
    color:sanitizeColor(color||'#ffd15b'),body:rb,target:null,nextThink:0,riding:null};
  r.npcs.set(n.id,n);return n;
}
function spawnPlayer(r,ws,name,color) {
  const rb=r.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(Math.random()*3-1.5,2,Math.random()*3-1.5).setLinearDamping(3).lockRotations());
  r.world.createCollider(RAPIER.ColliderDesc.capsule(.43,.3).setDensity(.8).setFriction(.65),rb);
  const p={id:ID(),name:cleanName(name),color:sanitizeColor(color),ws,body:rb,input:{x:0,z:0,jump:false,sprint:false},
    look:0,jumpLock:false,lastAction:0,joinedAt:Date.now()};r.players.set(p.id,p);return p;
}
function mayAct(p,perSec=18) { const now=Date.now();if(now-p.lastAction<1000/perSec)return false;p.lastAction=now;return true; }
function closePlayer(ws) {
  if(!ws.room||!ws.player)return;
  const r=ws.room,p=ws.player;
  if(r.players.has(p.id)){ r.world.removeRigidBody(p.body);r.players.delete(p.id); }
  if(r.host===p.id)r.host=r.players.keys().next().value||null;
  cast(r,{type:'notice',message:p.name+' が退出しました'});
  ws.room=null;ws.player=null;r.lastSeen=Date.now();
}
function objNear(p,o,dist=DIST) {const a=p.body.translation(),b=o.body.translation();return withinDistance(a,b,dist);}
function takeSnapshot(r) {
  return {format:'CHAOS-LUV',version:1,gravity:r.gravity,
    parts:[...r.parts.values()].map(partView),joints:[...r.joints.values()].map(jointView),
    npcs:[...r.npcs.values()].map(npcView),wires:[...r.wires.values()].map(wireView)};
}
function resetContents(r){
  for(const n of r.npcs.values())r.world.removeRigidBody(n.body);r.npcs.clear();
  for(const id of [...r.parts.keys()])removePart(r,id);
  r.wires.clear();
}
function loadSnapshot(r,doc,owner){
  if(!doc||doc.format!=='CHAOS-LUV'||doc.version!==1||!Array.isArray(doc.parts)||
    doc.parts.length>MAX_PARTS || (doc.joints||[]).length>MAX_JOINTS||(doc.npcs||[]).length>MAX_NPCS)throw Error('非対応の設計図または部品数オーバーです');
  resetContents(r);r.gravity=clamp(safeNumber(doc.gravity,-9.81),-25,5);r.world.gravity=V(0,r.gravity,0);
  for(const d of doc.parts) {
    const input={...d,x:clamp(safeNumber(d.x,0),-WORLD_SIZE,WORLD_SIZE),y:clamp(safeNumber(d.y,2),.3,45),z:clamp(safeNumber(d.z,0),-WORLD_SIZE,WORLD_SIZE)};
    const o=addPart(r,owner,input,typeof d.id==='string'?d.id.slice(0,40):ID());
    if(o){o.speed=clamp(safeNumber(d.speed,0),-20,20);o.label=String(d.label||'').slice(0,40);o.groupId=typeof d.groupId==='string'?d.groupId.slice(0,40):null;const q=V(safeNumber(d.qx,0),safeNumber(d.qy,0),safeNumber(d.qz,0));const w=safeNumber(d.qw,1);if(Math.abs(Math.hypot(q.x,q.y,q.z,w)-1)<.01)o.body.setRotation({...q,w},true);}
  }
  for(const d of doc.joints||[])createJoint(r,d.a,d.b,d.type,d.speed,d.length);
  for(const d of doc.wires||[])if(r.parts.has(d.from)&&r.parts.has(d.to)){const id=ID();r.wires.set(id,{id,from:d.from,to:d.to});}
  for(const n of doc.npcs||[])spawnNpc(r,n.name,n.mode,n.color,clamp(safeNumber(n.x,0),-WORLD_SIZE,WORLD_SIZE),clamp(safeNumber(n.y,2),1,40),clamp(safeNumber(n.z,0),-WORLD_SIZE,WORLD_SIZE));
}
function onMessage(ws,raw) {
  if(raw.length>100000) return err(ws,'大きすぎるデータです');
  let m;try{m=JSON.parse(String(raw));}catch{return;}
  if(!m||typeof m.type!=='string')return;
  if(m.type==='create'||m.type==='join'){
    if(ws.room)return;
    let code=m.type==='create'?roomCode():String(m.code||'').trim().toUpperCase();
    if(m.type==='create')while(rooms.has(code))code=roomCode();
    const r=m.type==='create'?makeRoom(code):rooms.get(code);
    if(!r)return err(ws,'ルームが見つかりません');
    if(r.players.size>=8)return err(ws,'ルームが満員です');
    const p=spawnPlayer(r,ws,m.name||'Guest',m.color||'#71e1ff');
    ws.room=r;ws.player=p;if(!r.host)r.host=p.id;
    send(ws,{type:'welcome',id:p.id,code:r.code,host:r.host});
    send(ws,fullState(r));cast(r,{type:'notice',message:p.name+' が参加しました'});return;
  }
  const r=ws.room,p=ws.player;
  if(!r||!p)return err(ws,'先にルームに参加してください');
  r.lastSeen=Date.now();
  if(m.type==='input'){
    p.input={x:clamp(safeNumber(m.x,0),-1,1),z:clamp(safeNumber(m.z,0),-1,1),jump:!!m.jump,sprint:!!m.sprint};
    p.look=safeNumber(m.look,p.look);return;
  }
  if(m.type==='chat') {if(!mayAct(p,2))return;const s=String(m.message||'').replace(/[<>\x00-\x1f]/g,'').slice(0,130);if(s)cast(r,{type:'chat',id:p.id,name:p.name,message:s});return;}
  if(m.type==='export')return send(ws,{type:'export',snapshot:takeSnapshot(r)});
  if(!mayAct(p,15))return;
  if(m.type==='spawn'){
    const at=V(clamp(safeNumber(m.x,0),-WORLD_SIZE,WORLD_SIZE),clamp(safeNumber(m.y,3),.5,40),clamp(safeNumber(m.z,0),-WORLD_SIZE,WORLD_SIZE));
    if(!withinDistance(p.body.translation(),at,DIST))return err(ws,'遠すぎます');
    const o=addPart(r,p.id,{...m,...at});if(!o)return err(ws,'部品数の上限です');
    if(m.kind==='motor'||m.kind==='switch'||m.kind==='sensor'||m.kind==='seat'||m.kind==='piston')o.kind=m.kind;
    o.speed=clamp(safeNumber(m.speed,2),-20,20);
    return;
  }
  if(m.type==='stroke'){
    const points=Array.isArray(m.points)?m.points.slice(0,22):[];
    if(points.length<2||r.parts.size+points.length-1>MAX_PARTS)return;
    let last=null;
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i];if(!a||!b)break;
      const pa=V(safeNumber(a.x,0),safeNumber(a.y,1),safeNumber(a.z,0)),pb=V(safeNumber(b.x,0),safeNumber(b.y,1),safeNumber(b.z,0));
      if(!withinDistance(p.body.translation(),pa,DIST)||!withinDistance(pa,pb,3))break;
      const length=Math.hypot(pb.x-pa.x,pb.y-pa.y,pb.z-pa.z);
      if(length<.15)continue;
      const o=addPart(r,p.id,{x:(pa.x+pb.x)/2,y:(pa.y+pb.y)/2,z:(pa.z+pb.z)/2,shape:'box',
        size:[.16,.16,Math.max(.2,length)],color:m.color,material:m.material,locked:false,kind:'line'});
      if(!o)break;
      // A rigid segment is oriented along the stroke tangent.
      const direction=V(pb.x-pa.x,pb.y-pa.y,pb.z-pa.z);
      const k=V(0,0,1),target=V(direction.x/length,direction.y/length,direction.z/length);
      const cross=V(k.y*target.z-k.z*target.y,k.z*target.x-k.x*target.z,k.x*target.y-k.y*target.x);
      const w=1+k.x*target.x+k.y*target.y+k.z*target.z;
      const norm=Math.hypot(cross.x,cross.y,cross.z,w);
      if(norm>.01)o.body.setRotation({x:cross.x/norm,y:cross.y/norm,z:cross.z/norm,w:w/norm},true);
      if(last)createJoint(r,last.id,o.id,m.soft?'rope':'fixed',0,1);
      last=o;
    }return;
  }

  if(m.type==='group'){
    const ids=[...new Set(Array.isArray(m.ids)?m.ids:[])].slice(0,30);
    if(ids.length<2)return;
    const groupId=ID();
    for(const id of ids){const o=r.parts.get(id);if(o&&hasEdit(r,p,o)&&objNear(p,o,35))o.groupId=groupId;}
    return;
  }
  if(m.type==='nudge'||m.type==='moveGroup'){
    const ids=[...new Set(Array.isArray(m.ids)?m.ids:[])].slice(0,30);
    const delta=m.type==='nudge'?V(clamp(safeNumber(m.dx,0),-1,1),0,clamp(safeNumber(m.dz,0),-1,1)):V(
      clamp(safeNumber(m.delta?.x,0),-3,3),
      clamp(safeNumber(m.delta?.y,0),-3,3),
      clamp(safeNumber(m.delta?.z,0),-3,3));
    for(const id of ids){
      const o=r.parts.get(id);if(!o||!hasEdit(r,p,o)||!objNear(p,o,35))continue;
      const at=o.body.translation(),pos=V(clamp(at.x+delta.x,-WORLD_SIZE,WORLD_SIZE),
        clamp(at.y+delta.y,.3,45),clamp(at.z+delta.z,-WORLD_SIZE,WORLD_SIZE));
      o.body.setTranslation(pos,true);o.body.setLinvel(V(),true);
    }
    return;
  }
  if(m.type==='paste'){
    const bp=m.blueprint,at=m.position;
    if(!bp||!Array.isArray(bp.parts)||bp.parts.length<1||bp.parts.length>30||
      !Array.isArray(bp.joints)||bp.joints.length>50||
      !Array.isArray(bp.wires)||bp.wires.length>50||r.parts.size+bp.parts.length>MAX_PARTS||
      !withinDistance(p.body.translation(),at,18))return err(ws,'設計図を配置できません');
    const map=new Map();
    for(const src of bp.parts){
      const input={...src,locked:!!src.locked,groupId:null,x:safeNumber(at.x,0)+safeNumber(src.x,0),
        y:safeNumber(at.y,2)+safeNumber(src.y,0),z:safeNumber(at.z,0)+safeNumber(src.z,0)};
      const created=addPart(r,p.id,input);
      if(created){created.speed=clamp(safeNumber(src.speed,0),-20,20);map.set(src.id,created.id);}
    }
    for(const j of bp.joints)if(map.has(j.a)&&map.has(j.b))createJoint(r,map.get(j.a),map.get(j.b),j.type,j.speed,j.length);
    for(const w of bp.wires)if(map.has(w.from)&&map.has(w.to)){const id=ID();r.wires.set(id,{id,from:map.get(w.from),to:map.get(w.to)});}
    return;
  }
  if(m.type==='delete'){
    const ids=(Array.isArray(m.ids)?m.ids:[m.id]).slice(0,30);
    for(const id of ids){const o=r.parts.get(id);if(o&&hasEdit(r,p,o)&&objNear(p,o,35))removePart(r,id);}
    return;
  }
  if(m.type==='edit'){
    const o=r.parts.get(m.id);if(!o||!hasEdit(r,p,o)||!objNear(p,o,40))return;
    if(m.position){
      const pos=V(clamp(safeNumber(m.position.x,0),-WORLD_SIZE,WORLD_SIZE),clamp(safeNumber(m.position.y,0),.3,45),clamp(safeNumber(m.position.z,0),-WORLD_SIZE,WORLD_SIZE));
      if(withinDistance(o.body.translation(),pos,8)) {o.body.setTranslation(pos,true);o.body.setLinvel(V(),true);}
    }
    if(m.locked!==undefined){o.locked=!!m.locked;o.body.setBodyType(o.locked?RAPIER.RigidBodyType.Fixed:RAPIER.RigidBodyType.Dynamic,true);}
    if(m.color)o.color=sanitizeColor(m.color);
    if(m.speed!==undefined)o.speed=clamp(safeNumber(m.speed,2),-20,20);
    if(m.kind&&['block','motor','piston','sensor','switch','seat'].includes(m.kind))o.kind=m.kind;
    return;
  }
  if(m.type==='joint'){
    const a=r.parts.get(m.a),b=r.parts.get(m.b);
    if(!a||!b||!hasEdit(r,p,a)||!hasEdit(r,p,b)||!objNear(p,a,35)||!objNear(p,b,35))return;
    const type=['fixed','hinge','motor','piston','rope','spring'].includes(m.jointType)?m.jointType:'fixed';
    const j=createJoint(r,a.id,b.id,type,m.speed,undefined);
    if(!j)err(ws,'接続できませんでした');return;
  }
  if(m.type==='removeJoint'){const j=r.joints.get(m.id);if(j&&hasEdit(r,p,r.parts.get(j.a)))removeJoint(r,j.id);return;}
  if(m.type==='wire'){
    const a=r.parts.get(m.from),b=r.parts.get(m.to);
    if(!a||!b||!hasEdit(r,p,a)||!hasEdit(r,p,b)||r.wires.size>150)return;
    if([...r.wires.values()].some(w=>w.from===a.id&&w.to===b.id))return;
    const id=ID();r.wires.set(id,{id,from:a.id,to:b.id});return;
  }
  if(m.type==='toggle'){const o=r.parts.get(m.id);if(o&&hasEdit(r,p,o)){o.manual=!o.manual;o.signal=o.manual?1:0;}return;}
  if(m.type==='npc'){
    if(!withinDistance(p.body.translation(),m,18))return;
    const n=spawnNpc(r,m.name||'Bot',m.mode||'wander',m.color||'#ffd15b',clamp(safeNumber(m.x,0),-WORLD_SIZE,WORLD_SIZE),clamp(safeNumber(m.y,2),1,40),clamp(safeNumber(m.z,0),-WORLD_SIZE,WORLD_SIZE));
    if(!n)err(ws,'NPCの上限です');return;
  }
  if(m.type==='npcMode'){const n=r.npcs.get(m.id);if(n&&p.id===r.host)n.mode=['wander','follow','work','ride','idle'].includes(m.mode)?m.mode:'wander';return;}
  if(m.type==='removeNpc'){const n=r.npcs.get(m.id);if(n&&p.id===r.host){r.world.removeRigidBody(n.body);r.npcs.delete(n.id);}return;}
  if(m.type==='settings'){
    if(p.id!==r.host)return;
    if(m.gravity!==undefined){r.gravity=clamp(safeNumber(m.gravity,-9.81),-25,5);r.world.gravity=V(0,r.gravity,0);}
    if(m.paused!==undefined)r.paused=!!m.paused;
    return;
  }
  if(m.type==='import'){
    if(p.id!==r.host)return err(ws,'ホストのみワールドを読み込めます');
    try{loadSnapshot(r,m.snapshot,p.id);cast(r,{type:'notice',message:'ワールドを読み込みました'});}
    catch(e){err(ws,e.message);}
    return;
  }
  if(m.type==='clear'){
    if(p.id!==r.host)return;
    resetContents(r);cast(r,{type:'notice',message:'ワールドを初期化しました'});return;
  }
}
function runCircuits(r) {
  for(const o of r.parts.values()){
    if(o.kind==='sensor'){
      const at=o.body.translation();
      o.signal=[...r.players.values()].some(p=>withinDistance(at,p.body.translation(),4))?1:0;
    }else if(o.kind==='switch')o.signal=o.manual?1:0;
  }
  const incoming=new Map();
  for(const w of r.wires.values()){
    const from=r.parts.get(w.from);
    if(from)incoming.set(w.to,Math.max(incoming.get(w.to)||0,from.signal||0));
  }
  for(const o of r.parts.values())if(o.kind==='motor'||o.kind==='piston')o.signal=incoming.get(o.id)||0;
  for(const j of r.joints.values()){
    if(j.type!=='motor'&&j.type!=='piston')continue;
    const connected=(r.parts.get(j.a)?.signal||0)||(r.parts.get(j.b)?.signal||0);
    if(j.rapier && typeof j.rapier.configureMotorVelocity==='function'){
      j.rapier.configureMotorVelocity(connected?j.speed:0,3);
    }
  }
}
function runSoftJoints(r){
  for(const j of r.joints.values()) {
    if(j.type!=='rope'&&j.type!=='spring')continue;
    const a=r.parts.get(j.a)?.body,b=r.parts.get(j.b)?.body;if(!a||!b)continue;
    const pa=a.translation(),pb=b.translation(),dx=pb.x-pa.x,dy=pb.y-pa.y,dz=pb.z-pa.z;
    const dist=Math.hypot(dx,dy,dz)||1,error=dist-j.length;
    if(j.type==='rope'&&error<=0)continue;
    const f=clamp(error*(j.type==='spring'?15:30),-90,90),imp=V(dx/dist*f*DT,dy/dist*f*DT,dz/dist*f*DT);
    if(a.isDynamic())a.applyImpulse(imp,true);
    if(b.isDynamic())b.applyImpulse(V(-imp.x,-imp.y,-imp.z),true);
  }
}
function runNpc(r,n){
  const pos=n.body.translation();
  if(n.mode==='idle'){n.body.setLinvel(V(0,n.body.linvel().y,0),true);return;}
  if(n.mode==='ride'){
    const seat=[...r.parts.values()].find(o=>o.kind==='seat'&&withinDistance(o.body.translation(),pos,7));
    if(seat){const s=seat.body.translation();n.body.setTranslation(V(s.x,s.y+1.1,s.z),true);n.body.setLinvel(V(),true);n.riding=seat.id;return;}
  }
  n.riding=null;
  if(n.mode==='follow'&&r.players.size){
    const p=r.players.values().next().value;n.target=p.body.translation();
  }else if(n.mode==='work'){
    const targets=[...r.parts.values()].filter(o=>o.kind==='block'&&!o.locked);
    if(targets.length) n.target=targets.sort((a,b)=>Math.hypot(a.body.translation().x-pos.x,a.body.translation().z-pos.z)-Math.hypot(b.body.translation().x-pos.x,b.body.translation().z-pos.z))[0].body.translation();
  }
  if(!n.target||r.time>n.nextThink){
    if(n.mode==='wander'||!n.target)n.target=V(clamp(pos.x+Math.random()*12-6,-WORLD_SIZE+2,WORLD_SIZE-2),pos.y,clamp(pos.z+Math.random()*12-6,-WORLD_SIZE+2,WORLD_SIZE-2));
    n.nextThink=r.time+2+Math.random()*3;
  }
  const dx=n.target.x-pos.x,dz=n.target.z-pos.z,d=Math.hypot(dx,dz);
  const speed=d>1.4?1.9:0;const old=n.body.linvel();
  n.body.setLinvel(V(speed*dx/(d||1),old.y,speed*dz/(d||1)),true);
  if(d<1.4)n.target=null;
}
function tick(){
  const now=Date.now();
  for(const r of rooms.values()){
    r.time+=DT;
    for(const p of r.players.values()){
      const {x,z,jump,sprint}=p.input;
      const len=Math.max(1,Math.hypot(x,z)),s=sprint?8.5:5.6;
      const old=p.body.linvel(),pos=p.body.translation();
      p.body.setLinvel(V(x/len*s,old.y,z/len*s),true);
      if(jump&&!p.jumpLock&&Math.abs(old.y)<.18&&pos.y<10){p.body.applyImpulse(V(0,4.8,0),true);p.jumpLock=true;}
      if(!jump)p.jumpLock=false;
      if(Math.abs(pos.x)>WORLD_SIZE||Math.abs(pos.z)>WORLD_SIZE||pos.y< -15){
        p.body.setTranslation(V(0,3,0),true);p.body.setLinvel(V(),true);
      }
    }
    if(!r.paused){
      if(Math.floor(r.time*10)!==Math.floor((r.time-DT)*10))runCircuits(r);
      runSoftJoints(r);
      for(const n of r.npcs.values())runNpc(r,n);
      r.world.step();
    }
    if(Math.floor(r.time*12)!==Math.floor((r.time-DT)*12))cast(r,fullState(r));
    if(r.players.size===0&&now-r.lastSeen>15*60_000){r.world.free();rooms.delete(r.code);}
  }
}
setInterval(tick,1000*DT);
setInterval(()=>{for(const r of rooms.values())if(r.players.size)send(r.players.get(r.host)?.ws||r.players.values().next().value.ws,{type:'autosave',snapshot:takeSnapshot(r)});},60000).unref();
const root=path.dirname(fileURLToPath(import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:rooms.size}));}
  let wanted='index.html';try{wanted=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));}catch{res.writeHead(400);return res.end();}
  const publicRoot=path.join(root,'dist');
  let file=path.resolve(publicRoot,wanted);
  if(!file.startsWith(publicRoot+path.sep)&&file!==path.join(publicRoot,'index.html')){res.writeHead(403);return res.end();}
  if(!existsSync(file)||statSync(file).isDirectory())file=path.join(publicRoot,'index.html');
  if(!existsSync(file)){res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Build the frontend with npm run build');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});
  createReadStream(file).pipe(res);
});
const wss=new WebSocketServer({server,path:'/socket',maxPayload:100000});
wss.on('connection',ws=>{
  ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{try{onMessage(ws,raw);}catch(e){console.error('message error',e);err(ws,'操作に失敗しました');}});
  ws.on('close',()=>closePlayer(ws));ws.on('error',()=>closePlayer(ws));
});
setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log('CHAOS-LUV listening on',PORT));
