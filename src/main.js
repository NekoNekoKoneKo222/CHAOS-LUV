import './style.css';
import { GameWorld } from './world.js';
const $=id=>document.getElementById(id);
let world=null;
try{world=new GameWorld($('gameCanvas'));}
catch(error){
 $('welcomeError').textContent='このブラウザでWebGLが利用できません。ChromeやSafariで3D描画を有効にしてください。';
 $('createRoom').disabled=true;$('joinRoom').disabled=true;
 console.warn('WebGL unavailable:',error.message);
}
if(world){
let socket=null, myId=null, currentCode='',state={parts:[],players:[],npcs:[],joints:[],wires:[]};
let shape='box',mode='select', selected=new Set(),selectedNpc=null,drawPoints=[],pointer=null,chosenColor='#68d8fd',lastDragSend=0,lastUI=0,lastTouch=0;
let pendingExport='download';
const controls={keys:new Set(),joyX:0,joyZ:0,jump:false};
function toast(s){const el=$('toast');el.textContent=s;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2700);}
function displayError(s){$('welcomeError').textContent=s;$('createRoom').disabled=false;$('joinRoom').disabled=false;toast(s);}
function send(data){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));else toast('サーバーに接続していません');}
function message(name,text,system=false){
 const el=document.createElement('div');el.className='message'+(system?' system':'');
 if(!system){const bold=document.createElement('b');bold.textContent=name+': ';el.append(bold);}
 el.append(document.createTextNode(text));$('messages').append(el);
 while($('messages').children.length>35)$('messages').firstChild.remove();
 $('messages').scrollTop=$('messages').scrollHeight;
}
const storedName=localStorage.getItem('chaos:name');if(storedName)$('nameInput').value=storedName;
const queryRoom=new URL(location.href).searchParams.get('room');
if(queryRoom)$('roomInput').value=queryRoom.replace(/[^a-zA-Z0-9]/g,'').slice(0,6);
function connect(type){
 if(socket?.readyState===WebSocket.OPEN)return;
 $('welcomeError').textContent='';$('createRoom').disabled=true;$('joinRoom').disabled=true;
 const protocol=location.protocol==='https:'?'wss:':'ws:';
 socket=new WebSocket(protocol+'//'+location.host+'/socket');
 const name=($('nameInput').value||'Builder').slice(0,18),color=$('playerColor').value;
 localStorage.setItem('chaos:name',name);
 const code=$('roomInput').value.trim().toUpperCase();
 socket.onopen=()=>send({type,name,color,code});
 socket.onerror=()=>displayError('接続に失敗しました。サーバーの状態を確認してください。');
 socket.onclose=()=>{
  $('connectionText').textContent='切断されました';$('createRoom').disabled=false;$('joinRoom').disabled=false;
  if(myId){myId=null;$('gameUI').classList.add('hidden');$('welcomeScreen').classList.remove('hidden');displayError('接続が切れました。再参加してください。');}
 };
 socket.onmessage=e=>{
  let m;try{m=JSON.parse(e.data);}catch{return;}
  if(m.type==='welcome'){
    myId=m.id;currentCode=m.code;world.setLocal(myId);
    $('roomCode').textContent=currentCode;
    $('welcomeScreen').classList.add('hidden');$('gameUI').classList.remove('hidden');$('connectionText').textContent='オンライン';
    $('createRoom').disabled=false;$('joinRoom').disabled=false;
    history.replaceState(null,'',location.pathname+'?room='+currentCode);
    toast('ルーム '+currentCode+' に参加しました');
  }else if(m.type==='state'){
    state=m;world.update(m);$('playerCount').textContent=m.players.length+' / 8 人';$('partsCount').textContent=m.parts.length+' PARTS';
    const keep=new Set(m.parts.map(p=>p.id));for(const id of [...selected])if(!keep.has(id))selected.delete(id);
    world.setSelected(selected);
    if(performance.now()-lastUI>450){renderNpcList();updateSelection();syncSettings();lastUI=performance.now();}
  }else if(m.type==='chat')message(m.name,m.message);
  else if(m.type==='notice')message('',m.message,true);
  else if(m.type==='error')displayError(m.message);
  else if(m.type==='autosave') {
    if(myId===state.host)try{localStorage.setItem('chaos:autosave',JSON.stringify(m.snapshot));}catch{toast('端末の空き容量が不足しています');}
  } else if(m.type==='export'){
    if(pendingExport==='local'){try{localStorage.setItem('chaos:manual',JSON.stringify(m.snapshot));toast('この端末に保存しました');}catch{toast('保存できませんでした');}}
    else downloadJSON('CHAOS-LUV-'+currentCode+'.json',m.snapshot);
    pendingExport='download';
  }
 };
}
$('createRoom').onclick=()=>connect('create');
$('joinRoom').onclick=()=>connect('join');
$('roomInput').addEventListener('keydown',e=>{if(e.key==='Enter')connect('join');});
function setTab(name){
 document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
 document.querySelectorAll('.tabPanel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+name));
}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.tab)));
$('collapseSidebar').onclick=()=>$('sidebar').classList.toggle('collapsed');
document.querySelectorAll('[data-shape]').forEach(b=>b.addEventListener('click',()=>{shape=b.dataset.shape;document.querySelectorAll('[data-shape]').forEach(x=>x.classList.toggle('active',x===b));}));
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{
 mode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('active',x===b));
 toast(mode==='draw'?'画面をドラッグして線を描けます':mode==='move'?'選択した物体をドラッグして移動':'選択モード');
}));
$('partSize').oninput=e=>$('sizeLabel').textContent=e.target.value;
$('motorSpeed').oninput=e=>$('speedLabel').textContent=e.target.value;
$('gravity').oninput=e=>$('gravityLabel').textContent=e.target.value;
function place(){
 const pos=world.forwardPoint(5),s=Number($('partSize').value),kind=$('partKind').value;
 send({type:'spawn',shape,kind,material:$('material').value,size:[s,s,s],color:$('partColor').value,
  locked:$('spawnLocked').checked,speed:Number($('motorSpeed').value),...pos});
 toast('パーツを設置しました');
}
$('placeBtn').onclick=place;
function selectedParts(){return [...selected].map(id=>state.parts.find(p=>p.id===id)).filter(Boolean);}
function updateSelection(){
 const ps=selectedParts();
 $('selectInfo').textContent=ps.length?ps.length+'個選択: '+ps.map(p=>p.kind==='block'?p.shape:p.kind).slice(0,3).join(', ')+(ps.length>3?' ...':''):'オブジェクト未選択';
}
function selectPart(id,multi){
 if(!multi)selected.clear();
 if(selected.has(id)&&multi)selected.delete(id);else if(id)selected.add(id);
 world.setSelected(selected);updateSelection();
}
function needSelected(n){if(selected.size!==n){toast(n+'個のパーツを選択してください');return false;}return true;}
$('deleteBtn').onclick=()=>{
 if(!selected.size)return toast('削除するパーツを選択してください');
 send({type:'delete',ids:[...selected]});selected.clear();world.setSelected([]);updateSelection();
};
$('lockBtn').onclick=()=>{const ps=selectedParts();if(!ps.length)return toast('パーツを選択してください');for(const p of ps)send({type:'edit',id:p.id,locked:!p.locked});};
$('groupBtn').onclick=()=>{if(selected.size<2)return toast('2つ以上のパーツを選択してください');send({type:'group',ids:[...selected]});toast('グループ化しました');};
$('selectGroupBtn').onclick=()=>{
 const p=selectedParts()[0];if(!p?.groupId)return toast('グループがありません');
 selected=new Set(state.parts.filter(q=>q.groupId===p.groupId).map(q=>q.id));world.setSelected(selected);updateSelection();
};
document.querySelectorAll('[data-nudge]').forEach(b=>b.onclick=()=>{
 if(!selected.size)return toast('パーツを選択してください');
 const [dx,dz]=b.dataset.nudge.split(',').map(Number);
 send({type:'nudge',ids:[...selected],dx,dz});
});
$('jointBtn').onclick=()=>{
 if(!needSelected(2))return;
 const [a,b]=[...selected];send({type:'joint',a,b,jointType:$('jointType').value,speed:Number($('motorSpeed').value)});
 toast('接続要求を送信しました');
};
$('wireBtn').onclick=()=>{
 if(!needSelected(2))return;
 const [from,to]=[...selected];send({type:'wire',from,to});toast('信号線を接続しました');
};
$('toggleSwitchBtn').onclick=()=>{
 const p=selectedParts().find(p=>p.kind==='switch');
 if(!p)return toast('スイッチパーツを選択してください');
 send({type:'toggle',id:p.id});
};
$('spawnNpcBtn').onclick=()=>{
 const pos=world.forwardPoint(4);
 send({type:'npc',name:$('npcName').value,mode:$('npcMode').value,color:'#ffd36b',...pos});toast('NPCを配置しました');
};
function renderNpcList(){
 $('npcCount').textContent=state.npcs.length+' / 16';
 const area=$('npcList');area.replaceChildren();
 if(!state.npcs.length){const p=document.createElement('p');p.className='hint';p.textContent='まだNPCはいません。';area.append(p);return;}
 for(const n of state.npcs){
  const item=document.createElement('div');item.className='npcEntry';
  const label=document.createElement('span');label.textContent=n.name+' ('+n.mode+')';item.append(label);
  const sel=document.createElement('select');
  for(const [value,text] of [['wander','歩く'],['follow','追従'],['work','作業'],['ride','乗車'],['idle','待機']]){
   const o=document.createElement('option');o.value=value;o.textContent=text;sel.append(o);
  }
  sel.value=n.mode;sel.onchange=()=>send({type:'npcMode',id:n.id,mode:sel.value});item.append(sel);
  const del=document.createElement('button');del.textContent='✕';del.title='NPCを削除';
  del.onclick=()=>send({type:'removeNpc',id:n.id});item.append(del);area.append(item);
 }
}
function syncSettings(){
 if(document.activeElement!==$('gravity')){$('gravity').value=state.gravity??-9.8;$('gravityLabel').textContent=Number(state.gravity??-9.8).toFixed(1);}
 $('pauseBtn').textContent=state.paused?'▶ 物理を再開':'⏸ 物理を一時停止';
 const host=myId===state.host;
 $('gravity').disabled=!host;$('pauseBtn').disabled=!host;$('clearWorldBtn').disabled=!host;
 $('loadLocalBtn').disabled=!host;$('importFile').disabled=!host;
}
$('gravity').onchange=()=>send({type:'settings',gravity:Number($('gravity').value)});
$('pauseBtn').onclick=()=>send({type:'settings',paused:!state.paused});
function downloadJSON(name,doc){
 const blob=new Blob([JSON.stringify(doc,null,2)],{type:'application/json'});
 const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),3000);
}
$('saveLocalBtn').onclick=()=>{pendingExport='local';send({type:'export'});};
$('exportBtn').onclick=()=>{pendingExport='download';send({type:'export'});};
$('loadLocalBtn').onclick=()=>{
 const saved=localStorage.getItem('chaos:manual')||localStorage.getItem('chaos:autosave');
 if(!saved)return toast('保存データがありません');
 if(confirm('現在のワールドを保存データで置き換えますか？'))try{send({type:'import',snapshot:JSON.parse(saved)});}catch{toast('保存データが壊れています');}
};
$('importFile').onchange=async e=>{
 const file=e.target.files?.[0];if(!file||file.size>95000)return toast('JSONファイルが大きすぎます');
 try{const data=JSON.parse(await file.text());if(confirm('ワールド全体を読み込んで置き換えますか？'))send({type:'import',snapshot:data});}catch{toast('JSONの読み込みに失敗しました');}
 e.target.value='';
};
$('clearWorldBtn').onclick=()=>{if(confirm('全員の建築物とNPCを削除します。本当に初期化しますか？'))send({type:'clear'});};
function readBank(){try{return JSON.parse(localStorage.getItem('chaos:blueprints')||'{}');}catch{return {};}}
function refreshBlueprints(){
 const select=$('blueprintList');select.replaceChildren();const bank=readBank();
 for(const name of Object.keys(bank)){const o=document.createElement('option');o.value=name;o.textContent=name;select.append(o);}
 if(!select.options.length){const o=document.createElement('option');o.value='';o.textContent='保存済み設計図なし';select.append(o);}
}
$('saveBlueprintBtn').onclick=()=>{
 const ids=[...selected];if(!ids.length)return toast('設計図にするパーツを選択してください');
 const name=($('blueprintName').value||'My Machine').trim().slice(0,36);
 const pieces=state.parts.filter(p=>ids.includes(p.id)),anchor=pieces[0];
 const selectedIds=new Set(ids);
 const bank=readBank();
 bank[name]={parts:pieces.map(p=>({...p,x:p.x-anchor.x,y:p.y-anchor.y,z:p.z-anchor.z})),
  joints:state.joints.filter(j=>selectedIds.has(j.a)&&selectedIds.has(j.b)),
  wires:state.wires.filter(w=>selectedIds.has(w.from)&&selectedIds.has(w.to))};
 try{localStorage.setItem('chaos:blueprints',JSON.stringify(bank));refreshBlueprints();$('blueprintList').value=name;toast('設計図を保存しました');}catch{toast('保存容量が不足しています');}
};
$('pasteBlueprintBtn').onclick=()=>{
 const bp=readBank()[$('blueprintList').value];if(!bp)return toast('設計図を選択してください');
 const pos=world.forwardPoint(5);send({type:'paste',blueprint:bp,position:pos});toast('設計図を配置しています');
};
refreshBlueprints();
$('copyInvite').onclick=async()=>{
 const url=location.origin+location.pathname+'?room='+currentCode;
 try{await navigator.clipboard.writeText(url);toast('招待URLをコピーしました');}catch{toast('招待コード: '+currentCode);}
};
$('chatForm').onsubmit=e=>{
 e.preventDefault();const text=$('chatInput').value.trim();if(text)send({type:'chat',message:text});$('chatInput').value='';
};
$('helpBtn').onclick=()=>$('helpModal').classList.remove('hidden');
$('closeHelp').onclick=$('helpOkay').onclick=()=>$('helpModal').classList.add('hidden');
function addStrokePoint(x,y){
 const p=world.worldPoint(x,y,1.4),last=drawPoints.at(-1);
 if(last&&Math.hypot(last.x-p.x,last.z-p.z)<.35)return;
 if(last&&Math.hypot(last.x-p.x,last.z-p.z)>3)return;
 if(drawPoints.length<22)drawPoints.push({x:p.x,y:p.y,z:p.z});
 world.showStroke(drawPoints);
}
const canvas=$('gameCanvas');
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{
 if(!myId||e.button===2)return;
 const hit=world.raySelect(e.clientX,e.clientY);
 pointer={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,hit,drag:false,last:e.timeStamp};
 canvas.setPointerCapture(e.pointerId);
 if(mode==='draw'){drawPoints=[];addStrokePoint(e.clientX,e.clientY);return;}
 if(hit?.type==='part'){
  selectPart(hit.id,e.shiftKey||$('multiSelect').checked);
  pointer.drag=mode==='move';
 }else if(hit?.type==='npc'){selectedNpc=hit.id;setTab('npc');toast('NPCを選択: '+hit.id);}
 else if(!$('multiSelect').checked&&mode==='select'){selected.clear();world.setSelected([]);updateSelection();}
});
canvas.addEventListener('pointermove',e=>{
 if(!pointer||pointer.id!==e.pointerId)return;
 const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;
 pointer.x=e.clientX;pointer.y=e.clientY;
 if(mode==='draw'){addStrokePoint(e.clientX,e.clientY);return;}
 if(pointer.drag&&mode==='move'&&selected.size){
  if(performance.now()-lastDragSend<95)return;
  lastDragSend=performance.now();
  const pt=world.worldPoint(e.clientX,e.clientY,2.2);
  const main=state.parts.find(p=>p.id===[...selected][0]);if(!main)return;
  const delta={x:pt.x-main.x,y:pt.y-main.y,z:pt.z-main.z};
  send({type:'moveGroup',ids:[...selected],delta});return;
 }
 if(Math.abs(dx)+Math.abs(dy))world.rotate(dx,dy);
});
function pointerFinish(e){
 if(!pointer||pointer.id!==e.pointerId)return;
 if(mode==='draw'&&drawPoints.length>1){
  send({type:'stroke',points:drawPoints,soft:$('softStroke').checked,color:$('partColor').value,material:$('material').value});
  drawPoints=[];world.clearStroke();
 }
 pointer=null;
}
canvas.addEventListener('pointerup',pointerFinish);canvas.addEventListener('pointercancel',pointerFinish);
document.addEventListener('keydown',e=>{
 if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement)return;
 controls.keys.add(e.code);
 if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
 if(e.code==='Delete'||e.code==='Backspace')$('deleteBtn').click();
 if(e.code==='KeyB')setTab('build');
 if(e.code==='KeyE')setTab('tools');
 if(e.code==='KeyR')setTab('logic');
 if(e.code==='KeyN')setTab('npc');
 if(e.code==='Escape')$('helpModal').classList.add('hidden');
});
document.addEventListener('keyup',e=>controls.keys.delete(e.code));
window.addEventListener('blur',()=>{controls.keys.clear();controls.joyX=0;controls.joyZ=0;controls.jump=false;});
let joystickPointer=null;
$('joystick').addEventListener('pointerdown',e=>{joystickPointer=e.pointerId;$('joystick').setPointerCapture(e.pointerId);updateJoystick(e);});
$('joystick').addEventListener('pointermove',e=>{if(joystickPointer===e.pointerId)updateJoystick(e);});
function updateJoystick(e){
 const rect=$('joystick').getBoundingClientRect();
 const dx=e.clientX-(rect.left+rect.width/2),dy=e.clientY-(rect.top+rect.height/2);
 const scale=Math.max(1,Math.hypot(dx,dy)/35);
 controls.joyX=dx/scale/35;controls.joyZ=-dy/scale/35;
 $('stick').style.transform='translate('+(dx/scale)+'px,'+(dy/scale)+'px)';
}
function stopJoystick(e){if(joystickPointer!==e.pointerId)return;joystickPointer=null;controls.joyX=0;controls.joyZ=0;$('stick').style.transform='';}
$('joystick').addEventListener('pointerup',stopJoystick);$('joystick').addEventListener('pointercancel',stopJoystick);
$('jumpBtn').addEventListener('pointerdown',e=>{controls.jump=true;e.currentTarget.setPointerCapture(e.pointerId);});
$('jumpBtn').addEventListener('pointerup',()=>controls.jump=false);
$('jumpBtn').addEventListener('pointercancel',()=>controls.jump=false);
setInterval(()=>{
 if(!myId||!socket||socket.readyState!==WebSocket.OPEN)return;
 const k=controls.keys;
 let side=(k.has('KeyD')||k.has('ArrowRight')?1:0)-(k.has('KeyA')||k.has('ArrowLeft')?1:0)+controls.joyX;
 let forward=(k.has('KeyW')||k.has('ArrowUp')?1:0)-(k.has('KeyS')||k.has('ArrowDown')?1:0)+controls.joyZ;
 const len=Math.max(1,Math.hypot(side,forward));side/=len;forward/=len;
 const yaw=world.yaw, x=Math.cos(yaw)*side-Math.sin(yaw)*forward,z=-Math.sin(yaw)*side-Math.cos(yaw)*forward;
 send({type:'input',x,z,jump:k.has('Space')||controls.jump,sprint:k.has('ShiftLeft')||k.has('ShiftRight'),look:yaw});
},50);
message('','ようこそ！ルームを作るか招待コードで参加しましょう。',true);

}
