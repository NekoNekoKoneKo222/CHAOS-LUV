export const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
export function safeNumber(value,fallback=0){const n=Number(value);return Number.isFinite(n)?n:fallback;}
export function cleanName(value){return String(value||'Guest').replace(/[<>&"'\x00-\x1f]/g,'').slice(0,18)||'Guest';}
export function sanitizeColor(value){const c=String(value||'').trim();return /^#[0-9a-fA-F]{6}$/.test(c)?c:'#75d4ff';}
export function roomCode(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<6;i++)s+=alphabet[Math.floor(Math.random()*alphabet.length)];return s;}
export function withinDistance(a,b,max){return !!a&&!!b&&Math.hypot(safeNumber(a.x,1e6)-safeNumber(b.x,-1e6),safeNumber(a.y,1e6)-safeNumber(b.y,-1e6),safeNumber(a.z,1e6)-safeNumber(b.z,-1e6))<=max;}
export function buildPartData(input={}){
  const shape=['box','sphere','cylinder'].includes(input.shape)?input.shape:'box';
  const kind=['block','motor','piston','sensor','switch','seat','line'].includes(input.kind)?input.kind:'block';
  const material=['wood','metal','rubber','ice'].includes(input.material)?input.material:'wood';
  const s=Array.isArray(input.size)?input.size:[1.5,1.5,1.5];
  return {shape,kind,material,color:sanitizeColor(input.color||'#61d6ff'),
    size:[clamp(safeNumber(s[0],1.5),.15,8),clamp(safeNumber(s[1],1.5),.15,8),clamp(safeNumber(s[2],1.5),.15,8)],
    x:clamp(safeNumber(input.x,0),-72,72),y:clamp(safeNumber(input.y,2),.3,45),z:clamp(safeNumber(input.z,0),-72,72),
    locked:!!input.locked};
}
