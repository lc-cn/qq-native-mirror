import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {getEventListeners} from 'node:events';
import {createForwardResourceTransport,ForwardResourceError} from '../src/forward-resource-transport.ts';
import {buildForwardResourceRequest} from '../src/forward-resource-wire.ts';
const vi=(n:number)=>{const a:number[]=[];do{a.push((n%128)|(n>=128?128:0));n=Math.floor(n/128);}while(n);return Buffer.from(a);};
const bytes=(n:number,b:Buffer)=>Buffer.concat([vi(n*8+2),vi(b.length),b]);
// Independent minimal response: matching resource ID and gzip MultiMsg with zero records.
const response=(id='r')=>bytes(1,Buffer.concat([bytes(3,Buffer.from(id)),bytes(4,gzipSync(bytes(2,Buffer.concat([bytes(1,Buffer.from('MultiMsg')),bytes(2,Buffer.alloc(0))]))))]));
function deferred(){let resolve!:(v:any)=>void,reject!:(e:unknown)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const tick=()=>new Promise(done=>setImmediate(done));
const failure=(stage:string,dispatched:boolean)=>(error:unknown)=>{assert.ok(error instanceof ForwardResourceError);assert.equal(error.stage,stage);assert.equal(error.dispatched,dispatched);assert.ok(!error.message.includes('PRIVATE'));return true;};

test('one real interface dispatch, copied request and independent parsed resource without fabricated IDs',async()=>{
 const expected=buildForwardResourceRequest('u_self','r');let calls=0,request:Buffer|undefined;
 const t=createForwardResourceTransport({sendSsoCmdReqByContend(command,data){calls++;assert.equal(command,expected.command);assert.deepEqual(data,expected.data);request=data;return{rspbuffer:response()};}});
 const result=await t.read('u_self','r');assert.equal(result.resourceId,'r');assert.deepEqual(result.records,[]);assert.ok(Buffer.isBuffer(result.raw));assert.ok(!('messageId'in result));
 assert.notEqual(request,expected.data);assert.equal(calls,1);t.close();t.close();
});

test('invalid options/input and preabort/closed never dispatch or register listeners',async()=>{
 let calls=0,getters=0;const t=createForwardResourceTransport({sendSsoCmdReqByContend(){calls++;return{rspbuffer:response()};}});
 const accessor=Object.defineProperty({},'timeoutMs',{get(){getters++;throw Error('PRIVATE');}});
 for(const options of [null,[],{extra:1},{timeoutMs:0},{timeoutMs:60001},{timeoutMs:1.5},{signal:undefined},{signal:{}},accessor,Object.create({timeoutMs:1}),{[Symbol('private')]:1}])await assert.rejects(t.read('u_self','r',options as any),failure('input',false));
 for(const [uid,id]of [['','r'],['u_self',''],['u_self',{}],['u_self','\ud800']])await assert.rejects(t.read(uid as string,id as string),failure('input',false));
 const controller=new AbortController();controller.abort();await assert.rejects(t.read('u_self','r',{signal:controller.signal}),failure('lifecycle',false));assert.equal(getEventListeners(controller.signal,'abort').length,0);
 t.close();await assert.rejects(t.read('u_self','r'),failure('lifecycle',false));assert.equal(calls,0);assert.equal(getters,0);
});

test('sync throw and arbitrary rejected objects are sanitized without inspecting native error properties',async()=>{
 let accessed=0;const error=Object.defineProperty({PRIVATE:'PRIVATE'},'code',{get(){accessed++;throw Error('PRIVATE');}});
 for(const call of [()=>{throw error;},()=>Promise.reject(error)]){
  let calls=0;const t=createForwardResourceTransport({sendSsoCmdReqByContend(){calls++;return call();}});
  await assert.rejects(t.read('u_self','r'),failure('native',true));assert.equal(calls,1);t.close();
 }assert.equal(accessed,0);
});

test('response envelopes reject getters, inheritance, subclasses, empty and oversized buffers',async()=>{
 let getters=0;class Envelope{rspbuffer=response();}
 const accessor=Object.defineProperty({},'rspbuffer',{get(){getters++;throw Error('PRIVATE');}});
 const subclass=response();Object.setPrototypeOf(subclass,Object.create(Buffer.prototype));
 for(const value of [null,{},accessor,Object.create({rspbuffer:response()}),new Envelope(),{rspbuffer:new Uint8Array(response())},{rspbuffer:subclass},{rspbuffer:Buffer.alloc(0)},{rspbuffer:Buffer.alloc(8*1024*1024+1)}]){
  const t=createForwardResourceTransport({sendSsoCmdReqByContend(){return value;}});await assert.rejects(t.read('u_self','r'),failure('response',true));t.close();
 }assert.equal(getters,0);
});

test('malformed protobuf and mismatched resource ID are sanitized and never retried',async()=>{
 for(const value of [Buffer.from('PRIVATE'),response('different')]){
  let calls=0;const t=createForwardResourceTransport({sendSsoCmdReqByContend(){calls++;return{rspbuffer:value};}});
  await assert.rejects(t.read('u_self','PRIVATE'),failure('protobuf',true));assert.equal(calls,1);t.close();
 }
});

for(const mode of ['abort','close','timeout'] as const)test(`${mode} retires a never-settling native call promptly and cleans listeners`,async()=>{
 const pending=deferred(),controller=new AbortController();let calls=0;
 const t=createForwardResourceTransport({sendSsoCmdReqByContend(){calls++;return pending.promise;}});
 const request=t.read('u_self','r',{signal:controller.signal,timeoutMs:mode==='timeout'?5:1000});const checked=assert.rejects(request,failure('lifecycle',true));
 assert.equal(getEventListeners(controller.signal,'abort').length,1);
 if(mode==='abort')controller.abort();if(mode==='close'){t.close();t.close();}
 await checked;assert.equal(getEventListeners(controller.signal,'abort').length,0);
 pending.reject(Error('PRIVATE late rejection'));await tick();assert.equal(calls,1);t.close();
});

test('abort/close during synchronous dispatch ignores late valid response and does not replay',async()=>{
 for(const mode of ['abort','close']){
  const controller=new AbortController();let t:ReturnType<typeof createForwardResourceTransport>,calls=0;
  t=createForwardResourceTransport({sendSsoCmdReqByContend(){calls++;if(mode==='abort')controller.abort();else t.close();return{rspbuffer:response()};}});
  await assert.rejects(t.read('u_self','r',{signal:controller.signal}),failure('lifecycle',true));assert.equal(calls,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);t.close();
 }
});

test('concurrent reads remain isolated when one is aborted and the other resolves',async()=>{
 const first=deferred(),second=deferred(),controller=new AbortController();let calls=0;
 const t=createForwardResourceTransport({sendSsoCmdReqByContend(){return ++calls===1?first.promise:second.promise;}});
 const canceled=t.read('u_self','r',{signal:controller.signal}),success=t.read('u_self','second');const checked=assert.rejects(canceled,failure('lifecycle',true));controller.abort();
 second.resolve({rspbuffer:response('second')});assert.equal((await success).resourceId,'second');await checked;
 first.resolve({rspbuffer:response()});await tick();assert.equal(calls,2);t.close();
});

test('response and returned raw buffers are copied before external mutation',async()=>{
 const supplied=response();const t=createForwardResourceTransport({sendSsoCmdReqByContend(){return{rspbuffer:supplied};}});
 const result=await t.read('u_self','r'),raw=Buffer.from(result.raw);supplied.fill(0);assert.deepEqual(result.raw,raw);t.close();
});

test('native AbortSignal operations ignore hostile own methods/getters and keep cancellation safe',async()=>{
 const controller=new AbortController();let accessed=0;
 for(const name of ['addEventListener','removeEventListener','aborted'])Object.defineProperty(controller.signal,name,{get(){accessed++;throw Error('PRIVATE signal override');}});
 const t=createForwardResourceTransport({sendSsoCmdReqByContend(){return new Promise(()=>{});}});
 const request=t.read('u_self','r',{signal:controller.signal});const rejected=assert.rejects(request,failure('lifecycle',true));
 controller.abort();await rejected;assert.equal(accessed,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);t.close();
});
