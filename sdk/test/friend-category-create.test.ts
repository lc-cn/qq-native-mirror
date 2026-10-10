import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {friendCategoryName,createFriendCategory,projectCreatedFriendCategory} from '../src/friend-category-create.ts';
import {inspectNativeContracts,supportsCategoryCreation,type NativeContractProfile} from '../src/native-contracts.ts';
import {createNativeServices} from '../src/native-services.ts';

const profiles: NativeContractProfile[] = [
  {platform:'linux',arch:'x64',clientVersion:'3.2.32-52194',wrapperSha256:'7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526'},
  {platform:'linux',arch:'arm64',clientVersion:'3.2.32-52194',wrapperSha256:'c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337'},
  {platform:'darwin',arch:'arm64',clientVersion:'7.0.2-53644',wrapperSha256:'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358'},
  {platform:'darwin',arch:'x64',clientVersion:'7.0.2-53644',wrapperSha256:'e91c58872d3d498f2d3ac1c304ab3ae4602d016274cf3e0f0cb651ad765f1f54'},
  {platform:'win32',arch:'x64',clientVersion:'9.9.33-52230',wrapperSha256:'63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0'},
  {platform:'win32',arch:'arm64',clientVersion:'9.9.33-52230',wrapperSha256:'54e5a6ce127a1f973f28e38ddfbf1338403ea323a141546a6578dd25332c928a'},
];
const receipt = {result:0,errMsg:'',name:' 服务端名称 ',groupId:0xffff_ffff,context:new Uint8Array([1,2])};
function fixture(profile:NativeContractProfile|undefined, dispatch:(...args:unknown[])=>unknown, version=profile?.clientVersion??'3.2.32-52194') {
  return createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),
    getBuddyService:()=>({addKernelBuddyListener(){},addCategoryV2:dispatch})},version,()=>{},undefined,undefined,undefined,undefined,undefined,undefined,profile);
}

for(const profile of profiles) test(`category ABI fixture ${profile.platform}/${profile.arch}: explicit second argument and native receipt`,async()=>{
  const calls:unknown[][]=[];const services=fixture(profile,(...args)=>{calls.push(args);return receipt;});
  try {
    assert.deepEqual(await services.invokeOperation('addFriendCategory',{name:' 自定义分组 '}),{categoryId:0xffff_ffff,name:' 服务端名称 '});
    assert.deepEqual(calls,[[' 自定义分组 ',undefined]]);
    assert.equal(supportsCategoryCreation({...profile,wrapperSha256:'0'.repeat(64)},profile.clientVersion),false);
    assert.equal(supportsCategoryCreation(profile,'unverified'),false);
  } finally {services.close();}
});

test('unknown binary/version rejects category mutation before native dispatch',async()=>{
  let dispatched=0;
  for(const [profile,version] of [[undefined,'3.2.32-52194'],[{...profiles[0],wrapperSha256:'0'.repeat(64)},'3.2.32-52194'],[profiles[0],'3.2.31-40994']] as const){
    const services=fixture(profile,()=>{dispatched++;return receipt;},version);
    try {await assert.rejects(services.invokeOperation('addFriendCategory',{name:'好友'}),/not verified/);}finally{services.close();}
  }
  assert.equal(dispatched,0);
});

test('invalid name rejects without coercion or dispatch; native name is preserved',async()=>{
  let dispatched=0,coerced=0;const services=fixture(profiles[0],()=>{dispatched++;return receipt;});
  try {
    for(const name of ['', '  ',undefined,1,{toString(){coerced++;return '好友';}}]) await assert.rejects(services.invokeOperation('addFriendCategory',{name}),/nonblank string/);
    assert.equal(dispatched,0);assert.equal(coerced,0);assert.equal(friendCategoryName(' 分组 '),' 分组 ');
  }finally{services.close();}
});

test('receipt rejects malformed IDs/accessors and preserves native errors without exposing opaque context',()=>{
  for(const groupId of [-1,2**32,1.5,'3',NaN,undefined]) assert.throws(()=>projectCreatedFriendCategory({...receipt,groupId}),/Invalid native/);
  for(const result of [7,'REMOTE_ERROR',undefined]) assert.throws(()=>projectCreatedFriendCategory({...receipt,result}),error=>{assert.equal((error as Error&{code:unknown}).code,result??'invalid-result');return true;});
  let getters=0;const raw={...receipt};Object.defineProperty(raw,'name',{get(){getters++;return 'bad';}});assert.throws(()=>projectCreatedFriendCategory(raw),/Invalid native/);assert.equal(getters,0);
  const dto=projectCreatedFriendCategory(receipt);dto.name='changed';assert.equal(receipt.name,' 服务端名称 ');assert.deepEqual(Object.keys(dto),['categoryId','name']);
});

test('Session close cancels pending creation; late rejection is consumed and does not retry',async()=>{
  let reject!:(value:Error)=>void,calls=0;const services=fixture(profiles[0],()=>{calls++;return new Promise((_,no)=>{reject=no;});});
  const stopped=assert.rejects(services.invokeOperation('addFriendCategory',{name:'一次'}),/closed.*unknown/);
  services.close();await stopped;reject(new Error('late'));await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(services.invokeOperation('addFriendCategory',{name:'closed'}),/closed/);assert.equal(calls,1);
});

test('timeout rejects one dispatch and a late result cannot create a second completion',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});let done!:(value:unknown)=>void,calls=0;
  const services=fixture(profiles[0],()=>{calls++;return new Promise(resolve=>{done=resolve;});});
  try {
    const stopped=assert.rejects(services.invokeOperation('addFriendCategory',{name:'一次'}),/timed out.*unknown/);
    context.mock.timers.tick(5000);await stopped;done(receipt);await Promise.resolve();assert.equal(calls,1);
  }finally{services.close();}
});

test('synchronous errors, rejected promises and abort before dispatch settle without retries',async()=>{
  for(const dispatch of [()=>{throw new Error('sync');},()=>Promise.reject(new Error('async'))]){
    const services=fixture(profiles[0],dispatch);try{await assert.rejects(services.invokeOperation('addFriendCategory',{name:'一次'}),/sync|async/);}finally{services.close();}
  }
  const stop=new AbortController();stop.abort();let called=0;
  await assert.rejects(createFriendCategory('一次',()=>{called++;return receipt;},stop.signal));assert.equal(called,0);
});

test('synchronous callback abort followed by a throw consumes both failures',async()=>{
  const stop=new AbortController();let calls=0;
  await assert.rejects(createFriendCategory('一次',()=>{calls++;stop.abort();throw new Error('native throw after close');},stop.signal),/native throw/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test('worker provenance hashes file bytes on the actual platform and skips unknown versions',async()=>{
  assert.equal(await inspectNativeContracts('/does/not/exist','fixture'),undefined);
  const dir=await mkdtemp(join(tmpdir(),'qq-native-contract-'));
  try {
    const file=join(dir,'fixture.node'),bytes=Buffer.from('synthetic binary bytes');await writeFile(file,bytes);
    const tag=process.platform==='darwin'?'7.0.2-53644':process.platform==='win32'?'9.9.33-52230':'3.2.32-52194';
    const profile=await inspectNativeContracts(file,{clientVersion:tag});
    if(profiles.some(row=>row.platform===process.platform&&row.arch===process.arch)){
      assert.deepEqual(profile,{platform:process.platform,arch:process.arch,clientVersion:tag,wrapperSha256:createHash('sha256').update(bytes).digest('hex')});
      assert.equal(Object.isFrozen(profile),true);assert.equal(supportsCategoryCreation(profile,tag),false);
    }else assert.equal(profile,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
});
