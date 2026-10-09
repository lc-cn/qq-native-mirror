import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {parseLongMessageResponse,createLongMessageResponseTransport,LONG_MESSAGE_COMMAND,LongMessageResponseError} from '../src/long-message-response.ts';
// Independent wire fixture: field2(message), field3(UTF-8 "res-fixture").
const response=Buffer.from('120d1a0b7265732d66697874757265','hex');
const request=Buffer.from('0801','hex');
function deferred(){let resolve!:(v:unknown)=>void,reject!:(e:unknown)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function failure(stage:string,dispatched:boolean,completion:string){return(e:unknown)=>{assert.ok(e instanceof LongMessageResponseError);assert.equal(e.stage,stage);assert.equal(e.dispatched,dispatched);assert.equal(e.completion,completion);return true;};}
test('pinned nested field decodes independent hex and skips valid unknown wire fields/groups',()=>{
 assert.deepEqual(parseLongMessageResponse(response),{resId:'res-fixture'});
 // unknown varint, fixed64, bytes, group containing varint, fixed32.
 const unknown=Buffer.from('0801390000000000000000220200012b08012c3500000000','hex');
 assert.deepEqual(parseLongMessageResponse(Buffer.concat([unknown,response])),{resId:'res-fixture'});
 assert.deepEqual(parseLongMessageResponse(Buffer.from('12041a02c3a9','hex')),{resId:'é'});
});
test('malformed corpus rejects absent/duplicate/type/UTF8/varint/group/truncation and length bounds',()=>{
 const corpus=['','0801','1200','12021a00','12041a02c328','12021a80','1280808080808080808002','0080','0e','08008000','0b','0b14','09','0d','12031a02ff','1000','12040a000a00',response.toString('hex')+response.toString('hex'),'121a1a0b7265732d666978747572651a0b7265732d66697874757265'];
 for(const hex of corpus)assert.throws(()=>parseLongMessageResponse(Buffer.from(hex,'hex')),LongMessageResponseError,hex);
 assert.throws(()=>parseLongMessageResponse(Buffer.alloc(1024*1024+1)),LongMessageResponseError);
 const long=Buffer.alloc(4097,0x61);assert.throws(()=>parseLongMessageResponse(Buffer.concat([Buffer.from('1284201a8120','hex'),long])),LongMessageResponseError);
 assert.throws(()=>parseLongMessageResponse(Buffer.concat([Buffer.alloc(17,0x0b),Buffer.alloc(17,0x0c),response])),LongMessageResponseError);
 assert.throws(()=>parseLongMessageResponse(new Uint8Array(response) as Buffer),LongMessageResponseError);
});
test('dispatches fixed command once with copied request and only returns resource identity',async()=>{
 let calls=0;const pending=deferred();let sent:Buffer|undefined;
 const transport=createLongMessageResponseTransport({sendSsoCmdReqByContend(cmd,data){calls++;assert.equal(cmd,LONG_MESSAGE_COMMAND);sent=data;return pending.promise;}});
 const source=Buffer.from(request),result=transport.send(LONG_MESSAGE_COMMAND,source);source.fill(0);assert.deepEqual(sent,request);assert.notEqual(sent,source);
 pending.resolve({rspbuffer:response,result:99,seq:999});assert.deepEqual(await result,{resId:'res-fixture'});assert.equal(calls,1);transport.close();
});
test('invalid inputs/preabort/closed never dispatch and do not register abort listener',async()=>{
 let calls=0;const t=createLongMessageResponseTransport({sendSsoCmdReqByContend(){calls++;return{rspbuffer:response};}});const controller=new AbortController();controller.abort();
 for(const [cmd,data,options]of [['wrong',request,{}],[LONG_MESSAGE_COMMAND,Buffer.alloc(0),{}],[LONG_MESSAGE_COMMAND,new Uint8Array(request),{}],[LONG_MESSAGE_COMMAND,request,{timeoutMs:0}]] as const)
  await assert.rejects(t.send(cmd,data as Buffer,options),failure('input',false,'not-dispatched'));
 await assert.rejects(t.send(LONG_MESSAGE_COMMAND,request,{signal:controller.signal}),failure('lifecycle',false,'not-dispatched'));
 t.close();await assert.rejects(t.send(LONG_MESSAGE_COMMAND,request),failure('lifecycle',false,'not-dispatched'));assert.equal(calls,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('abort after dispatch has unknown completion, removes listener and consumes late rejection',async()=>{
 const pending=deferred(),controller=new AbortController();let calls=0;
 const t=createLongMessageResponseTransport({sendSsoCmdReqByContend(){calls++;return pending.promise;}});
 const result=t.send(LONG_MESSAGE_COMMAND,request,{signal:controller.signal});assert.equal(getEventListeners(controller.signal,'abort').length,1);
 controller.abort();await assert.rejects(result,failure('lifecycle',true,'unknown'));assert.equal(getEventListeners(controller.signal,'abort').length,0);
 pending.reject(Error('private-native-data'));await new Promise(r=>setImmediate(r));assert.equal(calls,1);t.close();
});
test('timeout and close reject once, ignore late valid response and clean listeners',async()=>{
 for(const mode of ['timeout','close']){
  const pending=deferred(),controller=new AbortController();const t=createLongMessageResponseTransport({sendSsoCmdReqByContend(){return pending.promise;}});
  const result=t.send(LONG_MESSAGE_COMMAND,request,{signal:controller.signal,timeoutMs:mode==='timeout'?5:1000});const rejected=assert.rejects(result,failure('lifecycle',true,'unknown'));
  if(mode==='close')t.close();await rejected;assert.equal(getEventListeners(controller.signal,'abort').length,0);pending.resolve({rspbuffer:response});await new Promise(r=>setImmediate(r));t.close();
 }
});
test('native failure, invalid envelope and malformed wire remain distinct, without leaking native errors',async()=>{
 for(const call of [()=>{throw Error('secret');},()=>Promise.reject(Error('secret'))]){
  const t=createLongMessageResponseTransport({sendSsoCmdReqByContend:call});await assert.rejects(t.send(LONG_MESSAGE_COMMAND,request),e=>{failure('native',true,'unknown')(e);assert.ok(!(e as Error).message.includes('secret'));return true;});t.close();
 }
 for(const envelope of [null,{}, {rspbuffer:new Uint8Array(response)}, {rspbuffer:Buffer.alloc(1024*1024+1)},Object.create({rspbuffer:response}),Object.defineProperty({},'rspbuffer',{get(){throw Error('getter secret');}})]){
  const t=createLongMessageResponseTransport({sendSsoCmdReqByContend(){return envelope;}});await assert.rejects(t.send(LONG_MESSAGE_COMMAND,request),failure('response',true,'response-received'));t.close();
 }
 const t=createLongMessageResponseTransport({sendSsoCmdReqByContend(){return{rspbuffer:Buffer.from('1200','hex')};}});await assert.rejects(t.send(LONG_MESSAGE_COMMAND,request),failure('protobuf',true,'response-received'));t.close();
});
test('close during synchronous dispatch cannot resolve or retry; native late rejection observed',async()=>{
 const pending=deferred();let calls=0;let t:ReturnType<typeof createLongMessageResponseTransport>;
 t=createLongMessageResponseTransport({sendSsoCmdReqByContend(){calls++;t.close();return pending.promise;}});
 await assert.rejects(t.send(LONG_MESSAGE_COMMAND,request),failure('lifecycle',true,'unknown'));pending.reject(Error('late'));await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});

test('normal settlement removes abort listener and malformed options fail before dispatch',async()=>{
 let calls=0;const controller=new AbortController();const t=createLongMessageResponseTransport({sendSsoCmdReqByContend(){calls++;return{rspbuffer:response};}});
 assert.deepEqual(await t.send(LONG_MESSAGE_COMMAND,request,{signal:controller.signal}),{resId:'res-fixture'});
 assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();
 for(const options of [null,[],{signal:{}},{timeoutMs:Infinity},{timeoutMs:1.5},{timeoutMs:60001}])await assert.rejects(t.send(LONG_MESSAGE_COMMAND,request,options as never),failure('input',false,'not-dispatched'));
 assert.equal(calls,1);t.close();assert.throws(()=>createLongMessageResponseTransport({} as never),LongMessageResponseError);
});
