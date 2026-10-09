import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHistoryQuery,queryNativeHistory} from '../src/message-query.ts';
const peer={type:'group',groupId:'123'};
const raw=(peerUid='123')=>({msgId:'42',chatType:2,peerUid,elements:[]});

test('history defaults, absent undefined options, compatible aliases and null-prototype own values',()=>{
 const expected={peer:{type:'group',groupId:'123'},before:'0',count:20,reverse:false};
 assert.deepEqual(normalizeHistoryQuery(peer),expected);
 assert.deepEqual(normalizeHistoryQuery(peer,{before:undefined,messageId:undefined,limit:undefined,count:undefined,reverse:undefined}),expected);
 assert.deepEqual(normalizeHistoryQuery(peer,{before:'0009',messageId:'0009',limit:2,count:2,reverse:true}),{...expected,before:'0009',count:2,reverse:true});
 assert.deepEqual(normalizeHistoryQuery(peer,Object.assign(Object.create(null),{messageId:'9',count:100})),{...expected,before:'9',count:100});
});

test('invalid history input rejects synchronously before any intended UID/native preparation',()=>{
 let effects=0;
 const prepare=(options:unknown)=>{const captured=normalizeHistoryQuery(peer,options);effects++;return captured;};
 for(const options of [null,[],Object.create({limit:1}),{unknown:true},{before:9},{before:null},{before:''},{before:'1.5'},{limit:'2'},{limit:null},{count:0},{limit:101},{limit:1.5},{reverse:1},{reverse:null},{before:'1',messageId:'2'},{limit:1,count:2},{[Symbol('unknown')]:1}])assert.throws(()=>prepare(options));
 assert.equal(effects,0);
 for(const invalidPeer of [null,[],{type:'other',groupId:'123'},{type:'group',groupId:123},{type:'private',userId:''}])assert.throws(()=>normalizeHistoryQuery(invalidPeer));
});

test('history options and peer accessors are rejected without running getters or coercion',()=>{
 let accessed=0;const getter=()=>{accessed++;throw Error('private getter');};
 for(const key of ['before','messageId','limit','count','reverse'])assert.throws(()=>normalizeHistoryQuery(peer,Object.defineProperty({},key,{get:getter})));
 assert.throws(()=>normalizeHistoryQuery(Object.defineProperty({groupId:'123'},'type',{get:getter})));
 assert.throws(()=>normalizeHistoryQuery(peer,{before:{toString:getter}}));assert.equal(accessed,0);
});

test('history captures peer/options values before asynchronous caller mutation',async()=>{
 const inputPeer={type:'private',userId:'456'},options={before:'0009',limit:2,reverse:true};
 const captured=normalizeHistoryQuery(inputPeer,options);
 inputPeer.userId='999';options.before='999';options.limit=100;options.reverse=false;
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(captured,{peer:{type:'private',userId:'456'},before:'0009',count:2,reverse:true});
});

test('native history rejects invalid peer/cursor/count/reverse before calling the service',async()=>{
 let calls=0,getters=0;const service={getMsgsIncludeSelf(){calls++;return{result:0,msgList:[]};}};
 for(const [p,before,count,reverse]of [[null,'0',20,false],[{chatType:3,peerUid:'123'},'0',20,false],[{chatType:2,peerUid:''},'0',20,false],[{chatType:2,peerUid:'123'},4,20,false],[{chatType:2,peerUid:'123'},'0','20',false],[{chatType:2,peerUid:'123'},'0',0,false],[{chatType:2,peerUid:'123'},'0',101,false],[{chatType:2,peerUid:'123'},'0',20,'false']])await assert.rejects(queryNativeHistory(service,p as any,before as any,count as any,reverse as any));
 const accessor=Object.defineProperty({peerUid:'123'},'chatType',{get(){getters++;return 2;}});await assert.rejects(queryNativeHistory(service,accessor as any,'0',20,false));
 assert.equal(calls,0);assert.equal(getters,0);
});

test('native and caller peer mutation cannot change expected conversation after dispatch',async()=>{
 let finish!:(v:any)=>void;const result=new Promise(resolve=>{finish=resolve;});const input={chatType:2 as const,peerUid:'123'};let passed:any;
 const pending=queryNativeHistory({getMsgsIncludeSelf(p:any){passed=p;p.peerUid='native-mutated';return result;}},input,'0',20,false);
 assert.notEqual(passed,input);input.peerUid='caller-mutated';
 finish({result:0,msgList:[raw('native-mutated')]});await assert.rejects(pending,/mismatched/);
 const accepted=await queryNativeHistory({getMsgsIncludeSelf(p:any){p.peerUid='mutated';return{result:0,msgList:[raw(),raw()]};}}, {chatType:2,peerUid:'123'},'0',1,false);
 assert.equal(accepted.length,2,'no unsupported native size or duplicate rejection policy');
});
