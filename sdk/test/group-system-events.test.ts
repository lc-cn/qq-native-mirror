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
 listener.onRecvSysMsg([...packet(44,130)]);assert.equal(events.length,7);
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
