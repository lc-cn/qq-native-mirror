import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createKernel} from '../src/kernel.ts';

async function waitFor(predicate:()=>boolean) {
 const deadline=Date.now()+1000;
 while(!predicate()){if(Date.now()>deadline)throw new Error('Mock callback deadline exceeded');await new Promise(resolve=>setImmediate(resolve));}
}

async function fixture(records:any[] = [{uin:'123',isQuickLogin:true}]) {
 const dataDir=await mkdtemp(join(tmpdir(),'qq-identity-test-'));
 let loginListener:any;let response:any={uin:'123',uid:'u_fake'};
 let resolveRecords:((value:any)=>void)|undefined;
 const sessions:any[]=[];const events:Array<[string,any]>=[];const dispatched:unknown[]=[];
 const service={initConfig(){},addKernelLoginListener(value:any){loginListener=value;},connect(){loginListener.onLoginConnected();},getMsfStatus:()=>0,
  getLoginList:()=>new Promise(resolve=>{resolveRecords=resolve;}),
  quickLoginWithUin(uin:unknown){dispatched.push(uin);loginListener.onQRCodeLoginSucceed(response);return{result:'0'};},
  getQRCodePicture(){loginListener.onQRCodeLoginSucceed(response);return true;},
  getMachineGuid:()=> '0123456789abcdef0123456789abcdef'};
 const session={init(config:any,depends:any,_dispatcher:any,listener:any){sessions.push({config,depends,listener});},getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){return 1;}})};
 const kernel=createKernel({NodeIQQNTWrapperEngine:{get:()=>({initWithDeskTopConfig(){}})},NodeIKernelLoginService:{get:()=>service},NodeIQQNTStartupSessionWrapper:{create:()=>({start(){}})},NodeIQQNTWrapperSession:{getNTWrapperSession:()=>session}},
 {dataDir,version:{clientVersion:'7.0.2-53644',appId:'1',qua:'fake'},loginTimeoutMs:300},(name,value)=>events.push([name,value]));
 return {kernel,sessions,events,dispatched,setResponse(value:any){response=value;},listener:()=>loginListener,
  async releaseRecords(){await waitFor(()=>Boolean(resolveRecords));resolveRecords!({LocalLoginInfoList:records});resolveRecords=undefined;},
  async ready(){await waitFor(()=>sessions.length>0);sessions.at(-1).listener.onOpentelemetryInit({is_init:true});},
  async close(){await kernel.close();await rm(dataDir,{recursive:true,force:true});}};
}
for(const request of [{method:'quick' as const,uin:'123'},{method:'restore' as const,uin:'123'},{method:'restore' as const}]) {
 test(`account mismatch is rejected before Session init: ${JSON.stringify(request)}`,async()=>{
  const f=await fixture();f.setResponse({uin:'456',uid:'u_wrong'});
  try{const result=f.kernel.login(request);if(request.method==='restore')await f.releaseRecords();await assert.rejects(result,/account|identity|match/i);assert.deepEqual(f.dispatched,['123']);assert.equal(f.sessions.length,0);assert.equal(f.events.filter(([name])=>name==='authenticated').length,0);}
  finally{await f.close();}
 });
}
for(const request of [{method:'quick' as const,uin:'123'},{method:'restore' as const,uin:'123'},{method:'restore' as const},{method:'qr' as const}]) {
 test(`matching identity reaches readiness: ${JSON.stringify(request)}`,async()=>{
  const f=await fixture();try{const result=f.kernel.login(request);if(request.method==='restore')await f.releaseRecords();await f.ready();assert.deepEqual(await result,{uin:'123',uid:'u_fake'});assert.equal(f.sessions[0].config.selfUin,'123');}finally{await f.close();}
 });
}
test('mismatch failure does not retain its target for the next login attempt',async()=>{
 const f=await fixture();try{f.setResponse({uin:'456',uid:'u_wrong'});await assert.rejects(f.kernel.login({method:'quick',uin:'123'}),/account|identity|match/i);f.setResponse({uin:'456',uid:'u_next'});const next=f.kernel.login({method:'quick',uin:'456'});await f.ready();assert.deepEqual(await next,{uin:'456',uid:'u_next'});assert.deepEqual(f.dispatched,['123','456']);}finally{await f.close();}
});
test('authenticated event mutation does not change the Session or resolved identity',async()=>{
 const f=await fixture();
 // Mutation occurs synchronously at native authentication notification.
 const originalPush=f.events.push.bind(f.events);f.events.push=(...items)=>{for(const [name,value]of items)if(name==='authenticated'){value.uin='999';value.uid='u_mutated';}return originalPush(...items);};
 try{const result=f.kernel.login({method:'quick',uin:'123'});await f.ready();assert.equal(f.sessions[0].config.selfUin,'123');assert.equal(f.sessions[0].config.selfUid,'u_fake');assert.deepEqual(await result,{uin:'123',uid:'u_fake'});}finally{await f.close();}
});

test('late readiness from a failed account cannot complete a differently targeted attempt',async()=>{
 const f=await fixture();
 try{
  const first=f.kernel.login({method:'quick',uin:'123'});
  await waitFor(()=>f.sessions.length>0);
  const stale=f.sessions[0];f.listener().onLoginDisConnected('mock failure');await assert.rejects(first,/offline/);
  f.setResponse({uin:'456',uid:'u_new'});let resolved=false;
  const next=f.kernel.login({method:'quick',uin:'456'}).then(value=>{resolved=true;return value;});
  await waitFor(()=>f.sessions.length>=2);
  stale.listener.onOpentelemetryInit({is_init:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(resolved,false);
  f.sessions[1].listener.onOpentelemetryInit({is_init:true});assert.deepEqual(await next,{uin:'456',uid:'u_new'});
 }finally{await f.close();}
});

for(const request of [{method:'quick' as const,uin:'123'},{method:'restore' as const}]) {
 test(`safe integer native identity and restored record normalize to decimal strings: ${request.method}`,async()=>{
  const f=await fixture([{uin:123,isQuickLogin:true}]);f.setResponse({uin:123,uid:'u_fake'});
  try{const result=f.kernel.login(request);if(request.method==='restore')await f.releaseRecords();await f.ready();assert.deepEqual(await result,{uin:'123',uid:'u_fake'});assert.equal(f.sessions[0].config.selfUin,'123');assert.deepEqual(f.dispatched,['123']);}finally{await f.close();}
 });
}
for(const response of [{uin:{toString:()=> '123'},uid:'u_fake'},{uin:Number.MAX_SAFE_INTEGER+1,uid:'u_fake'},{uin:'12x3',uid:'u_fake'},{uin:'123',uid:'   '}]) {
 test(`invalid native identity cannot authenticate: ${typeof response.uin}/${JSON.stringify(response)}`,async()=>{
  const f=await fixture();f.setResponse(response);
  try{await assert.rejects(f.kernel.login({method:'quick',uin:'123'}),/identity|account/i);assert.equal(f.sessions.length,0);assert.equal(f.events.filter(([name])=>name==='authenticated').length,0);}finally{await f.close();}
 });
}
test('unexpected authentication while restore list is pending fails and cannot later dispatch quick login',async()=>{
 const f=await fixture();
 try{
  const result=f.kernel.login({method:'restore'});
  await waitFor(()=>Boolean(f.listener()));
  // Allow connect/getLoginList to reach the asynchronous list query.
  await new Promise(resolve=>setImmediate(resolve));
  f.listener().onQRCodeLoginSucceed({uin:'123',uid:'u_fake'});
  await assert.rejects(result,/identity|account|authentication/i);
  await f.releaseRecords();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.dispatched,[]);assert.equal(f.sessions.length,0);assert.equal(f.events.filter(([name])=>name==='authenticated').length,0);
 }finally{await f.close();}
});
test('authentication, login, ready and resolved identity mutation cannot alter stored identity',async()=>{
 const f=await fixture();const originalPush=f.events.push.bind(f.events);
 f.events.push=(...items)=>{for(const [name,value]of items)if(['authenticated','login','ready'].includes(name)){value.uin='999';value.uid='u_mutated';}return originalPush(...items);};
 try{
  const pending=f.kernel.login({method:'quick',uin:'123'});await f.ready();const result=await pending;
  assert.deepEqual(result,{uin:'123',uid:'u_fake'});result.uin='888';result.uid='u_changed_result';
  assert.deepEqual(await f.kernel.login({method:'quick',uin:'123'}),{uin:'123',uid:'u_fake'});
  assert.equal(f.sessions[0].config.selfUin,'123');assert.equal(f.sessions[0].config.selfUid,'u_fake');
 }finally{await f.close();}
});

test('interruption during authenticated notification cannot initialize a replacement attempt with the old account',async()=>{
 const f=await fixture();const originalPush=f.events.push.bind(f.events);
 let next:ReturnType<typeof f.kernel.login>|undefined;
 f.events.push=(...items)=>{
  for(const [name,value]of items)if(name==='authenticated'&&value.uin==='123'){
   f.listener().onLoginDisConnected('mock interrupted notification');
   f.setResponse({uin:'456',uid:'u_next'});
   next=f.kernel.login({method:'quick',uin:'456'});
   void next.catch(()=>{});
  }
  return originalPush(...items);
 };
 try{
  await assert.rejects(f.kernel.login({method:'quick',uin:'123'}),/offline/);
  await waitFor(()=>f.sessions.length>0);
  assert.equal(f.sessions.length,1);assert.equal(f.sessions[0].config.selfUin,'456');
  f.sessions[0].listener.onOpentelemetryInit({is_init:true});
  assert.deepEqual(await next,{uin:'456',uid:'u_next'});
 }finally{await f.close();}
});

test('a disconnect during login notification suppresses stale ready after offline',async()=>{
 const f=await fixture();const originalPush=f.events.push.bind(f.events);
 f.events.push=(...items)=>{
  for(const [name]of items)if(name==='login')f.listener().onLoginDisConnected('mock interruption at login');
  return originalPush(...items);
 };
 try{
  const result=f.kernel.login({method:'quick',uin:'123'});await f.ready();await result;
  assert.ok(f.events.some(([name])=>name==='disconnected'));
  assert.equal(f.events.filter(([name])=>name==='ready').length,0);
  await assert.rejects(f.kernel.invokeOperation('listFriends'),/not online/);
 }finally{await f.close();}
});
