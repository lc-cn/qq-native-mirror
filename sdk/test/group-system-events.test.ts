import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupSystemEvents } from '../src/group-system-events.ts';
const vi = (n: number) => { const a: number[] = []; do { a.push(n % 128 | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(a); };
const scalar = (n: number, v: number) => Buffer.concat([vi(n * 8), vi(v)]);
const bytes = (n: number, v: Buffer) => Buffer.concat([vi(n * 8 + 2), vi(v.length), v]);
const packet = (type: number, code: number, extra = Buffer.alloc(0)) => Buffer.concat([bytes(2, scalar(1, type)), bytes(3, bytes(2, Buffer.concat([scalar(1, 123), scalar(4, code), bytes(3, Buffer.from('u_member')), extra])))]);
const harness = () => { const events: [string, any][] = []; return { events, listener: createGroupSystemEvents((name, value) => events.push([name, value])) }; };
test('known directions and finite codes retain unknowns without approve/kick inference', () => {
 const {events,listener}=harness();
 for(const [type,code] of [[33,131],[33,0],[34,130],[34,131],[34,3],[34,129],[34,999]]) listener.onRecvSysMsg([...packet(type,code)]);
 assert.deepEqual(events.map(([,e])=>e.kind),['invite','unknown','leave','kick','kick-me','disband','unknown']);
 assert.equal(events[0][1].groupId,'123'); assert.equal(events[0][1].memberUid,'u_member'); assert.equal(events[6][1].code,999);
 listener.onRecvSysMsg([...packet(45,130)]);assert.equal(events.length,7);
});
test('operator requires structured protobuf; legacy text remains absent',()=>{
 const {events,listener}=harness();const info=bytes(1,bytes(1,Buffer.from('u_operator')));
 listener.onRecvSysMsg([...packet(34,3,bytes(5,info))]);
 listener.onRecvSysMsg([...packet(33,131,bytes(5,Buffer.from('u_text')))]);
 listener.onRecvSysMsg([...packet(34,130,bytes(5,Buffer.from('u_text')))]);
 assert.equal(events[0][1].operatorUid,'u_operator');assert.equal(events[1][1].operatorUid,undefined);assert.equal(events[2][1].operatorUid,undefined);
});
test('malformed inputs/duplicate fields/uint overflow/UTF8 reject atomically',()=>{
 const {events,listener}=harness();let reads=0;const accessor=[1];Object.defineProperty(accessor,'0',{get(){reads++;return 1;}});
 for(const input of [Array(1),accessor,[256],[-1],[1.5],Buffer.from([1]),[],Array(1024*1024+1),[...packet(34,130,scalar(4,131))],[...packet(34,130,bytes(3,Buffer.from([255])))],[...packet(34,130,scalar(6,2**32))],[...packet(34,3,bytes(5,Buffer.from([10,255])))],[18,1,128]])listener.onRecvSysMsg(input);
 assert.equal(reads,0); assert.equal(events.length,13);assert.ok(events.every(([n,e])=>n==='diagnostic'&&e.stage==='invalid-native-group-system-message'));
});
test('bounded dedup and close have no replay or late diagnostic',()=>{
 const {events,listener}=harness();const input=[...packet(34,130)];listener.onRecvSysMsg(input);listener.onRecvSysMsg(input);assert.equal(events.length,1);
 for(let code=1000;code<3050;code++)listener.onRecvSysMsg([...packet(34,code)]);
 listener.onRecvSysMsg(input);assert.equal(events.length,2052);
 listener.close();listener.close();listener.onRecvSysMsg(input);listener.onRecvSysMsg([]);assert.equal(events.length,2052);
});

test('admin type44 has exactly one explicit branch and valid optional boolean fields independent of branch',()=>{
 const {events,listener}=harness();
 const admin=(enable:boolean,both=false)=>Buffer.concat([bytes(2,scalar(1,44)),bytes(3,bytes(2,Buffer.concat([scalar(1,123),scalar(3,enable?1:0),bytes(4,Buffer.concat([bytes(enable?2:1,Buffer.concat([bytes(1,Buffer.from('u_admin')),scalar(2,enable?1:0)])),...(both?[bytes(enable?1:2,bytes(1,Buffer.from('u_other')))]:[])]))])))]);
 listener.onRecvSysMsg([...admin(true)]);listener.onRecvSysMsg([...admin(false)]);listener.onRecvSysMsg([...admin(true,true)]);
 assert.deepEqual(events.slice(0,2),[['group-admin',{groupId:'123',memberUid:'u_admin',enabled:true}],['group-admin',{groupId:'123',memberUid:'u_admin',enabled:false}]]);assert.equal(events[2][0],'diagnostic');
});
const mute=(msgId='1',duration='600',member='u_member')=>({msgId,chatType:2,msgType:5,peerUid:'123',elements:[{grayTipElement:{subElementType:4,groupElement:{type:8,shutUp:{duration,admin:{uid:'u_admin'},member:{uid:member}}}}}]});
test('mute graytip exact enums, canonical seconds and all/member scope without identity queries',()=>{
 const {events,listener}=harness();const a=mute();listener.onRecvMsg([a,mute('2','0'),mute('3','999999999999999999999','')]);
 assert.deepEqual(events.map(([,e])=>[e.scope,e.durationSeconds,e.enabled,e.memberUid,e.operatorUid]),[['member','600',true,'u_member','u_admin'],['member','0',false,'u_member','u_admin'],['all','999999999999999999999',true,undefined,'u_admin']]);
 a.elements[0].grayTipElement.groupElement.shutUp.admin.uid='changed';assert.equal(events[0][1].operatorUid,'u_admin');
 listener.onRecvMsg([mute('4')]);listener.onRecvMsg([mute('4')]);assert.equal(events.length,4);
 for(const row of [{...mute('5'),chatType:1},{...mute('6'),msgType:0}, {...mute('7'),elements:[{grayTipElement:{subElementType:8,groupElement:{type:8,shutUp:{}}}}]}])listener.onRecvMsg([row]);assert.equal(events.length,4);
});
test('mute whole batch rejects without partial emit and accessors never execute; close suppresses both channels',()=>{
 const {events,listener}=harness();let reads=0;const bad=mute('2','-1');listener.onRecvMsg([mute(),bad]);assert.deepEqual(events,[['diagnostic',{stage:'invalid-native-group-mute-message'}]]);
 const accessor=mute();Object.defineProperty(accessor,'msgType',{get(){reads++;return 5;}});listener.onRecvMsg([accessor]);listener.onRecvMsg(Array(1));listener.onRecvMsg([mute('8','01')]);assert.equal(reads,0);assert.equal(events.length,4);
 listener.onRecvMsg([mute()]);assert.equal(events.length,5,'rejected batch did not consume dedup');listener.close();listener.onRecvMsg([mute('9')]);listener.onRecvSysMsg([...packet(34,130)]);assert.equal(events.length,5);
});

 test('admin optional flags do not override branch and mute msgId is bounded',()=>{
 const {events,listener}=harness();
 const admin=Buffer.concat([bytes(2,scalar(1,44)),bytes(3,bytes(2,Buffer.concat([scalar(1,123),scalar(3,0),bytes(4,bytes(2,Buffer.concat([bytes(1,Buffer.from('u_admin')),scalar(2,0)])))])))]);
 listener.onRecvSysMsg([...admin]);assert.deepEqual(events,[['group-admin',{groupId:'123',memberUid:'u_admin',enabled:true}]]);
 listener.onRecvMsg([mute('1'.repeat(4097))]);assert.equal(events[1][0],'diagnostic');
 listener.onRecvMsg([mute('1'.repeat(4096))]);assert.equal(events[2][0],'group-mute');
 });

 test('mute candidate classifier ignores normal/unknown/sparse but finds exact mixed candidates',()=>{
 const {events,listener}=harness();
 for(const input of [undefined,{},Array(2),[{}],[{...mute(),msgType:0}],[{...mute(),chatType:1}]])assert.equal(listener.hasMuteCandidate(input),false);
 assert.equal(listener.hasMuteCandidate([undefined,mute()]),true);
 assert.equal(listener.hasMuteCandidate([mute(),null]),true);
 assert.equal(events.length,0);
 listener.onRecvMsg([undefined,mute()]);assert.equal(events[0][0],'diagnostic');
 listener.close();assert.equal(listener.hasMuteCandidate([mute()]),false);
 });
 test('mute candidate classifier never executes getters and contains proxy errors',()=>{
 const {events,listener}=harness();let reads=0;const input=mute();Object.defineProperty(input,'msgType',{get(){reads++;return 5;}});
 assert.equal(listener.hasMuteCandidate([input]),false);
 const proxy=new Proxy({}, {getOwnPropertyDescriptor(){throw new Error('owned fixture');}});assert.equal(listener.hasMuteCandidate([proxy]),false);
 const sparse=Array(2);sparse[1]=mute();assert.equal(listener.hasMuteCandidate(sparse),true);assert.equal(reads,0);assert.equal(events.length,0);
 });
