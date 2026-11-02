import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPartData,cleanName,roomCode,withinDistance,sanitizeColor} from '../shared/rules.mjs';
test('invalid values are bounded and sanitized',()=>{
 const p=buildPartData({shape:'BAD',size:[1e6,-10,NaN],x:Infinity,color:'red',material:'atomic'});
 assert.equal(p.shape,'box');assert.deepEqual(p.size,[8,.15,1.5]);assert.equal(p.x,0);
 assert.equal(p.color,'#75d4ff');assert.equal(p.material,'wood');
});
test('names, codes and positions',()=>{
 assert.equal(cleanName('<A>&'),'A');assert.match(roomCode(),/^[A-Z2-9]{6}$/);
 assert.equal(withinDistance({x:0,y:0,z:0},{x:3,y:4,z:0},5),true);
 assert.equal(withinDistance({x:0,y:0,z:0},{x:3,y:4,z:0},4),false);
 assert.equal(sanitizeColor('#aBc123'),'#aBc123');
});
