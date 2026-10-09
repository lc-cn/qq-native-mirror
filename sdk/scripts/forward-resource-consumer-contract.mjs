import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
// Hand-authored fixed-field fixture, not a native/server response.
const recordHex='0a1808c8031208755f617574686f723a09320766697874757265120230641a0d0a0b12090a070a0568656c6c6f';
const vi=value=>{const a=[];do{const n=value%128;value=Math.floor(value/128);a.push(n|(value?128:0));}while(value);return Buffer.from(a);};
const bytes=(n,data)=>Buffer.concat([vi(n*8+2),vi(data.length),data]);
export function resourceFixture() {
 const record=Buffer.from(recordHex,'hex');const raw=bytes(2,Buffer.concat([bytes(1,Buffer.from('MultiMsg')),bytes(2,bytes(1,record))]));
 return{record,raw,response:bytes(1,Buffer.concat([bytes(3,Buffer.from('r')),bytes(4,gzipSync(raw))]))};
}
export async function checkForwardResourceServices({createNativeServices}) {
 const data=resourceFixture();const calls=[],sideEffects=[];let msgAccesses=0;
 const create=(uid='u_self',sso=()=>({rspbuffer:data.response}))=>createNativeServices({
  getMsgService(){msgAccesses++;return{addKernelMsgListener(){},sendSsoCmdReqByContend(...args){calls.push(args);return sso(...args);},sendMsg(){sideEffects.push('send');throw Error('Unexpected send');},getMultiMsg(){sideEffects.push('native-id-query');throw Error('Unexpected native ID query');}};},
  getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),
  getUixConvertService:()=>({getUid(){sideEffects.push('uid');throw Error('Unexpected UID lookup');},getUin(){sideEffects.push('uin');throw Error('Unexpected UIN lookup');}}),
 },'7.0.2-53644',()=>{},undefined,undefined,'789',uid);
 const services=create();
 try {
  const before=msgAccesses;
  for(const invalid of ['',null,{},42,'\ud800','x'.repeat(4097)])await assert.rejects(services.invokeOperation('getForwardResource',{resourceId:invalid}));
  assert.equal(msgAccesses,before);assert.equal(calls.length,0);
  const value=await services.invokeOperation('getForwardResource',{resourceId:'r'});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg');
  assert.equal(calls[0][1].toString('hex'),'0a0f0a081206755f73656c6612017218017a080802100018002000');
  assert.equal(value.resourceId,'r');assert.deepEqual(value.raw,data.raw);assert.deepEqual(value.records,[{sender:{userId:'456',uid:'u_author',nickname:'fixture'},time:100,elements:[{type:'text',text:'hello'}],raw:data.record}]);
  for(const key of ['messageId','peer','sequence'])assert.equal(Object.hasOwn(value.records[0],key),false);
  assert.deepEqual(sideEffects,[]);
 }finally{services.close();}
 const missingUid=create('');try{const before=msgAccesses;await assert.rejects(missingUid.invokeOperation('getForwardResource',{resourceId:'r'}));assert.equal(msgAccesses,before);assert.equal(calls.length,1);}finally{missingUid.close();}
 let rejectLate;const stalled=create('u_self',()=>new Promise((_,reject)=>{rejectLate=reject;}));
 const request=stalled.invokeOperation('getForwardResource',{resourceId:'r'});const checked=assert.rejects(request,/closed|canceled/);stalled.close();
 let timer;try{await Promise.race([checked,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Close did not terminate read')),500);})]);}finally{clearTimeout(timer);}
 rejectLate(Error('late private native response'));await new Promise(done=>setImmediate(done));assert.equal(calls.length,2);assert.deepEqual(sideEffects,[]);
 await assert.rejects(stalled.invokeOperation('getForwardResource',{resourceId:'r'}),/closed/);assert.equal(calls.length,2);
}
export async function verifyForwardResourceConsumer(packagePath) {
 const load=name=>import(pathToFileURL(join(packagePath,'dist',name)).href);
 const {createNativeServices}=await load('native-services.js');await checkForwardResourceServices({createNativeServices});
 const {QQClient}=await load('index.js');const {EventEmitter}=await import('node:events');const requests=[];
 const worker=new EventEmitter();Object.assign(worker,{connected:true,stdout:new EventEmitter(),stderr:new EventEmitter(),send(value,callback){requests.push(value);callback(null);if(value.method==='close')queueMicrotask(()=>worker.emit('message',{id:value.id,result:null}));},kill(){this.connected=false;queueMicrotask(()=>this.emit('exit',0,null));return true;}});
 const client=new QQClient(worker,500);
 try{
  await assert.rejects(client.getForwardResource('r'),/not online/);assert.equal(requests.length,0);worker.emit('message',{event:'ready',payload:{uin:'789',uid:'u_self'}});
  for(const invalid of ['',42,{},'\ud800','x'.repeat(4097)])await assert.rejects(client.getForwardResource(invalid));assert.equal(requests.length,0);
  const pending=client.getForwardResource('r');const request=requests.at(-1);assert.equal(request.method,'getForwardResource');assert.equal(request.resourceId,'r');worker.emit('message',{id:request.id,result:{resourceId:'r',records:[],raw:Buffer.alloc(0)}});assert.equal((await pending).resourceId,'r');
 }finally{await client.close();}
 const {prepareCommand}=await load('cli.js');const cliCalls=[];const action=await prepareCommand('forward-resource',{'resource-id':'r'});await action({getForwardResource(id){cliCalls.push(id);return Promise.resolve({resourceId:id,records:[],raw:Buffer.alloc(0)});}});assert.deepEqual(cliCalls,['r']);await assert.rejects(prepareCommand('forward-resource',{}));await assert.rejects(prepareCommand('forward-resource',{'resource-id':'x'.repeat(4097)}));
 const cli=join(packagePath,'dist/cli.js'),missing=join(packagePath,'nonexistent-resource-fixture-config.json');
 const invalid=spawnSync(process.execPath,[cli,'forward-resource','--config',missing],{encoding:'utf8'});assert.equal(invalid.status,1);assert.match(invalid.stderr,/resource-id/);assert.doesNotMatch(invalid.stderr,/Unknown command|ENOENT/);
 const recognized=spawnSync(process.execPath,[cli,'forward-resource','--config',missing,'--resource-id','r'],{encoding:'utf8'});assert.equal(recognized.status,1);assert.match(recognized.stderr,/ENOENT/);assert.doesNotMatch(recognized.stderr,/Unknown command|Unknown option/);
 const batch=spawnSync(process.execPath,[cli,'messages','--config',missing,'--kind','group','--target','123','--message-ids','invalid'],{encoding:'utf8'});assert.equal(batch.status,1);assert.match(batch.stderr,/message.?ids|numeric/i);assert.doesNotMatch(batch.stderr,/Unknown command|ENOENT/);
 const merged=spawnSync(process.execPath,[cli,'send-forward','--config',missing,'--kind','group','--target','123'],{encoding:'utf8'});assert.equal(merged.status,1);assert.match(merged.stderr,/nodes-file/);assert.doesNotMatch(merged.stderr,/Unknown command|ENOENT/);
 return{forwardResourceContract:true,nativeForwardResourceAttempted:false};
}
