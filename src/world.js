import * as THREE from 'three';
const $=(id)=>document.getElementById(id);
export class GameWorld {
  constructor(canvas){
    this.canvas=canvas;
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,innerWidth<900?1.4:2));
    this.renderer.setSize(innerWidth,innerHeight);
    this.renderer.shadowMap.enabled=innerWidth>850;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#a6d8f3');
    this.scene.fog=new THREE.Fog('#a6d8f3',55,155);
    this.camera=new THREE.PerspectiveCamera(65,innerWidth/innerHeight,.12,250);
    this.yaw=Math.PI*.25;this.pitch=.35;this.target=new THREE.Vector3(0,1,0);
    this.raycaster=new THREE.Raycaster();this.pointer=new THREE.Vector2();
    this.scene.add(new THREE.HemisphereLight('#ffffff','#7ca17c',2.4));
    const sun=new THREE.DirectionalLight('#fff0c5',2.2);sun.position.set(-18,28,10);sun.castShadow=innerWidth>850;
    sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-55;sun.shadow.camera.right=55;sun.shadow.camera.top=55;sun.shadow.camera.bottom=-55;
    this.scene.add(sun);
    const ground=new THREE.Mesh(new THREE.BoxGeometry(144,1,144),new THREE.MeshStandardMaterial({color:'#83be95',roughness:1}));
    ground.position.y=-.5;ground.receiveShadow=true;this.scene.add(ground);
    const grid=new THREE.GridHelper(144,72,'#6fa987','#92c9a0');grid.position.y=.012;grid.material.transparent=true;grid.material.opacity=.48;this.scene.add(grid);
    this.partMeshes=new Map();this.playerMeshes=new Map();this.npcMeshes=new Map();this.links=new Map();
    this.selected=new Set();this.localId=null;this.state={parts:[],players:[],npcs:[],joints:[],wires:[]};
    this.preview=null;this.fps=0;this.lastTime=performance.now();this.frames=0;this.lastFps=performance.now();
    this.addDecor();
    window.addEventListener('resize',()=>this.resize());
    this.animate();
  }
  addDecor(){
    const rng=(n)=>{let x=Math.sin(n*45.19)*43758.5453;return x-Math.floor(x);};
    for(let i=0;i<40;i++){
      let x=(rng(i+1)-.5)*128,z=(rng(i+92)-.5)*128;
      if(Math.hypot(x,z)<20)continue;
      const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.35,.45,2,7),new THREE.MeshStandardMaterial({color:'#8b796a'}));
      trunk.position.set(x,1,z);this.scene.add(trunk);
      const leaves=new THREE.Mesh(new THREE.ConeGeometry(2,4,7),new THREE.MeshStandardMaterial({color:i%2?'#4b9a76':'#57b887'}));
      leaves.position.set(x,4,z);this.scene.add(leaves);
    }
    const pad=new THREE.Mesh(new THREE.CylinderGeometry(4.5,4.8,.18,48),new THREE.MeshStandardMaterial({color:'#e8edee',metalness:.2,roughness:.5}));
    pad.position.set(0,.1,0);this.scene.add(pad);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(4.4,.09,6,72),new THREE.MeshStandardMaterial({color:'#ffce74',emissive:'#b88332'}));
    ring.rotation.x=Math.PI/2;ring.position.set(0,.24,0);this.scene.add(ring);
  }
  resize(){
    this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,innerWidth<900?1.4:2));
    this.renderer.setSize(innerWidth,innerHeight);
  }
  makePart(p){
    const s=p.size;let geo;
    if(p.shape==='sphere')geo=new THREE.SphereGeometry(Math.max(.12,s[0]/2),18,12);
    else if(p.shape==='cylinder')geo=new THREE.CylinderGeometry(s[0]/2,s[0]/2,s[1],20);
    else geo=new THREE.BoxGeometry(...s);
    const mat=new THREE.MeshStandardMaterial({color:p.color,roughness:p.material==='metal'?.24:.75,metalness:p.material==='metal'?.7:0,transparent:false});
    const mesh=new THREE.Mesh(geo,mat);mesh.userData.partId=p.id;mesh.castShadow=true;mesh.receiveShadow=true;
    this.scene.add(mesh);this.partMeshes.set(p.id,mesh);return mesh;
  }
  makeCharacter(color,name,npc=false){
    const root=new THREE.Group();
    const body=new THREE.Mesh(new THREE.BoxGeometry(.76,1,.43),new THREE.MeshStandardMaterial({color}));
    body.position.y=.05;root.add(body);
    const head=new THREE.Mesh(new THREE.BoxGeometry(.6,.58,.6),new THREE.MeshStandardMaterial({color:npc?'#ffe2a3':'#f7d6b7'}));
    head.position.y=.86;root.add(head);
    const hair=new THREE.Mesh(new THREE.BoxGeometry(.64,.16,.64),new THREE.MeshStandardMaterial({color:npc?'#8c604c':'#353e60'}));
    hair.position.y=1.18;root.add(hair);
    for(const x of [-.21,.21]){
      const leg=new THREE.Mesh(new THREE.BoxGeometry(.25,.62,.32),new THREE.MeshStandardMaterial({color:'#30354b'}));
      leg.position.set(x,-.76,0);root.add(leg);
      const eye=new THREE.Mesh(new THREE.BoxGeometry(.08,.09,.04),new THREE.MeshBasicMaterial({color:'#333b4a'}));
      eye.position.set(x*.55,.88,-.32);root.add(eye);
    }
    const c=document.createElement('canvas');c.width=256;c.height=64;
    const ctx=c.getContext('2d');ctx.fillStyle='rgba(17,28,43,.75)';ctx.fillRect(2,6,252,50);
    ctx.fillStyle='#fff';ctx.font='bold 26px system-ui';ctx.textAlign='center';ctx.fillText(String(name).slice(0,18),128,40);
    const label=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),transparent:true,depthWrite:false}));
    label.scale.set(2.6,.65,1);label.position.y=1.78;root.add(label);
    this.scene.add(root);return root;
  }
  setLocal(id){this.localId=id;}
  setSelected(ids){
    this.selected=new Set(ids);
    for(const [id,mesh] of this.partMeshes){mesh.material.emissive.setHex(this.selected.has(id)?0x555c2b:0);mesh.material.emissiveIntensity=this.selected.has(id)?.55:0;}
  }
  update(data){
    this.state=data;
    const parts=new Set(data.parts.map(x=>x.id));
    for(const [id,m] of this.partMeshes)if(!parts.has(id)){this.scene.remove(m);m.geometry.dispose();m.material.dispose();this.partMeshes.delete(id);}
    for(const p of data.parts){
      const m=this.partMeshes.get(p.id)||this.makePart(p);
      m.userData.goal={p:new THREE.Vector3(p.x,p.y,p.z),q:new THREE.Quaternion(p.qx,p.qy,p.qz,p.qw)};
      if(!m.userData.initialized){m.position.copy(m.userData.goal.p);m.quaternion.copy(m.userData.goal.q);m.userData.initialized=true;}
      m.material.color.set(p.color);
      m.material.emissive.setHex(this.selected.has(p.id)?0x555c2b:0);
      m.material.emissiveIntensity=this.selected.has(p.id)?.55:0;
    }
    const players=new Set(data.players.map(x=>x.id));
    for(const [id,m] of this.playerMeshes)if(!players.has(id)){this.scene.remove(m);this.playerMeshes.delete(id);}
    for(const p of data.players){
      const m=this.playerMeshes.get(p.id)||this.makeCharacter(p.color,p.name);
      this.playerMeshes.set(p.id,m);
      m.userData.goal=new THREE.Vector3(p.x,p.y-.05,p.z);
      if(!m.userData.initialized){m.position.copy(m.userData.goal);m.userData.initialized=true;}
      m.rotation.y=p.look||0;
    }
    const npcs=new Set(data.npcs.map(x=>x.id));
    for(const [id,m] of this.npcMeshes)if(!npcs.has(id)){this.scene.remove(m);this.npcMeshes.delete(id);}
    for(const n of data.npcs){
      const m=this.npcMeshes.get(n.id)||this.makeCharacter(n.color,n.name,true);
      this.npcMeshes.set(n.id,m);m.userData.npcId=n.id;m.userData.goal=new THREE.Vector3(n.x,n.y-.05,n.z);
      if(!m.userData.initialized){m.position.copy(m.userData.goal);m.userData.initialized=true;}
    }
    const ids=new Set();
    for(const e of [...data.joints.map(j=>({...j,wire:false})),...data.wires.map(w=>({...w,a:w.from,b:w.to,wire:true}))]){
      const a=this.partMeshes.get(e.a),b=this.partMeshes.get(e.b);if(!a||!b)continue;ids.add(e.id);
      let line=this.links.get(e.id);
      if(!line){
        const geo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]);
        line=new THREE.Line(geo,new THREE.LineBasicMaterial({color:e.wire?'#f3b64e':e.type==='rope'?'#d19e62':'#8de7ff',transparent:true,opacity:.88,depthTest:true}));
        this.scene.add(line);this.links.set(e.id,line);
      }
      line.userData.a=e.a;line.userData.b=e.b;
    }
    for(const [id,l] of this.links)if(!ids.has(id)){this.scene.remove(l);l.geometry.dispose();l.material.dispose();this.links.delete(id);}
  }
  animate(){
    requestAnimationFrame(()=>this.animate());
    const now=performance.now(),dt=Math.min((now-this.lastTime)/1000,.08);this.lastTime=now;
    const t=Math.min(1,dt*16);
    for(const m of this.partMeshes.values())if(m.userData.goal){
      m.position.lerp(m.userData.goal.p,t);m.quaternion.slerp(m.userData.goal.q,t);
    }
    for(const m of [...this.playerMeshes.values(),...this.npcMeshes.values()])if(m.userData.goal)m.position.lerp(m.userData.goal,t);
    for(const l of this.links.values()){
      const a=this.partMeshes.get(l.userData.a),b=this.partMeshes.get(l.userData.b);
      if(a&&b){l.geometry.setFromPoints([a.position,b.position]);}
    }
    const me=this.playerMeshes.get(this.localId);
    const aim=me?me.position.clone().add(new THREE.Vector3(0,1.1,0)):this.target;
    this.target.lerp(aim,Math.min(1,dt*8));
    const distance=10;
    const offset=new THREE.Vector3(Math.sin(this.yaw)*Math.cos(this.pitch)*distance,Math.sin(this.pitch)*distance+2,Math.cos(this.yaw)*Math.cos(this.pitch)*distance);
    this.camera.position.lerp(this.target.clone().add(offset),Math.min(1,dt*8));
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene,this.camera);
    this.frames++;if(now-this.lastFps>=1000){this.fps=Math.round(this.frames*1000/(now-this.lastFps));this.frames=0;this.lastFps=now;const node=$('fps');if(node)node.textContent=this.fps+' FPS';}
  }
  raySelect(clientX,clientY){
    const rect=this.canvas.getBoundingClientRect();this.pointer.set((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1);
    this.raycaster.setFromCamera(this.pointer,this.camera);
    const hit=this.raycaster.intersectObjects([...this.partMeshes.values()],false)[0];
    if(hit)return {id:hit.object.userData.partId,type:'part'};
    const n=this.raycaster.intersectObjects([...this.npcMeshes.values()],true)[0];
    if(n){let parent=n.object;while(parent&&!parent.userData.npcId)parent=parent.parent;if(parent)return{id:parent.userData.npcId,type:'npc'};}
    return null;
  }
  worldPoint(clientX,clientY,y=1.2){
    const rect=this.canvas.getBoundingClientRect();this.pointer.set((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1);
    this.raycaster.setFromCamera(this.pointer,this.camera);
    const out=new THREE.Vector3(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),-y);
    if(!this.raycaster.ray.intersectPlane(plane,out)){
      const f=this.camera.getWorldDirection(new THREE.Vector3());out.copy(this.target).addScaledVector(f,6);out.y=y;
    }
    out.x=THREE.MathUtils.clamp(out.x,-70,70);out.z=THREE.MathUtils.clamp(out.z,-70,70);
    return out;
  }
  forwardPoint(distance=5){const at=this.target;return {x:at.x-Math.sin(this.yaw)*distance,y:Math.max(1.3,at.y+.4),z:at.z-Math.cos(this.yaw)*distance};}
  rotate(dx,dy){this.yaw-=dx*.005;this.pitch=THREE.MathUtils.clamp(this.pitch+dy*.005,-.25,1.1);}
  showStroke(points){
    if(this.preview){this.scene.remove(this.preview);this.preview.geometry.dispose();this.preview.material.dispose();this.preview=null;}
    if(points.length<2)return;
    this.preview=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(p.x,p.y,p.z))),
      new THREE.LineBasicMaterial({color:'#ffef83',linewidth:3}));this.scene.add(this.preview);
  }
  clearStroke(){this.showStroke([]);}
}
