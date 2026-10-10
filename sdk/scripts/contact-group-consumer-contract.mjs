import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Actual worker IPC with only the kernel and dlopen replaced by local fixtures. */
export async function verifyContactGroupWorkerRoutes({ QQClient, workerPath, kernelPath }) {
  workerPath = await realpath(workerPath);
  kernelPath = await realpath(kernelPath);
  const directory = await mkdtemp(join(tmpdir(), 'qq-contact-routes-'));
  const hook = join(directory, 'fixture-hook.mjs');
  await writeFile(hook, `import {registerHooks} from 'node:module';
process.dlopen = () => {};
registerHooks({load(url,context,next){
 if(url!==${JSON.stringify(pathToFileURL(kernelPath).href)})return next(url,context);
 return {format:'module',shortCircuit:true,source:\`export function createKernel(_native,_options,emit){if(_options.nativeContracts!==undefined)throw Error('Caller-provided native contract reached kernel');return {
  async prepare(){},async close(){},async login(){const account={uin:'123',uid:'u_fixture'};emit('ready',account);return account;},
  async invokeOperation(method,payload){if(method==='addFriendCategory')return {categoryId:8,name:payload.name};if(method==='listGroupMutedMembers')return [];if(method==='getGroupInfo')return {groupId:payload.groupId,name:'fixture',memberCount:0,maxMemberCount:200,ownerUid:'u_fixture',ownerUserId:'123',description:''};if(method==='listFriendCategories')return [{categoryId:1,sortId:0,name:'fixture',memberCount:0,onlineCount:0,friends:[]}];
   if(method==='setGroupRemark')return {method,groupId:payload.groupId,remark:payload.remark};throw Error('Unexpected fixture operation');}
 };}\`};
}});
`);
  const worker = fork(workerPath, [], { cwd: directory, execArgv: ['--import', hook], serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Drain child output without forwarding fixture paths into consumer output.
  worker.stdout.resume(); worker.stderr.resume();
  const client = new QQClient(worker, 5000);
  try {
    await client.request('init', { options: { dataDir: join(directory, 'account'), wrapperPath: join(directory, 'fixture.node'), version: 'fixture', preloadLibraries: [], nativeContracts:{platform:'darwin',arch:'arm64',clientVersion:'7.0.2-53644',wrapperSha256:'forged'} } });
    await client.login({ method: 'restore', uin: '123' });
    assert.deepEqual(await client.addFriendCategory(' 新分组 '),{categoryId:8,name:' 新分组 '});
    await assert.rejects(client.addFriendCategory(' '),/nonblank/);
    assert.deepEqual(await client.listGroupMutedMembers('000123'),[]);
    assert.equal((await client.getGroupInfo('000123')).groupId,'000123');
    assert.deepEqual(await client.listFriendCategories(), [{ categoryId: 1, sortId: 0, name: 'fixture', memberCount: 0, onlineCount: 0, friends: [] }]);
    assert.deepEqual(await client.setGroupRemark('000123', ''), { method: 'setGroupRemark', groupId: '000123', remark: '' });
  } finally {
    try { await client.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { contactGroupActualWorkerRoutes: true, kernelReplacedByFixture: true, nativeExecuted: false, accountUsed: false };
}

export async function verifyContactGroupConsumer(packageRoot) {
  const load = file => import(pathToFileURL(join(packageRoot, 'dist', file)).href);
  const { QQClient } = await load('index.js');
  const { prepareCommand, observeWatchEvents } = await load('cli.js');
  const { createGroupEvents } = await load('group-events.js');
  const { EventEmitter } = await import('node:events');
  const calls = [];
  await (await prepareCommand('group-muted', {'group-id':'123'}))({ listGroupMutedMembers: async id => { calls.push(['muted',id]); return []; } });
  await (await prepareCommand('group-info', {'group-id':'123'}))({ getGroupInfo: async id => { calls.push(['info',id]); return {}; } });
  await (await prepareCommand('friend-category-add', {name:' 新分组 '}))({addFriendCategory:async name=>{calls.push(['add-category',name]);return {categoryId:8,name};}});
  await assert.rejects(prepareCommand('friend-category-add',{name:' '}),/blank/);
  await (await prepareCommand('friend-categories', {}))({ listFriendCategories: async () => { calls.push('categories'); return []; } });
  await (await prepareCommand('group-remark', { 'group-id': '123', remark: '' }))({ setGroupRemark: async (...args) => calls.push(args) });
  assert.deepEqual(calls, [['muted','123'],['info','123'], ['add-category',' 新分组 '], 'categories', ['123', '']]);
  const events = new EventEmitter(), lines = [];
  const stop = observeWatchEvents(events, 'normalized', line => lines.push(JSON.parse(line)));
  const listener = createGroupEvents((name, payload) => events.emit(name, payload));
  listener.onGroupDetailInfoChange({ groupCode: '123', groupName: '', memberNum: 0, maxMemberNum: 200, ownerUid: 'u_owner', ownerUin: '456', fingerMemo: '' });
  assert.equal(lines.length, 1); assert.equal(lines[0].event, 'group-info-updated');
  const {createGroupSystemEvents}=await load('group-system-events.js');
  const membership=createGroupSystemEvents((name,payload)=>events.emit(name,payload));
  membership.onRecvSysMsg([18,2,8,34,26,7,18,5,8,123,32,130,1]);
  // Valid envelope with an absent subject; no identity fields are invented.
  assert.equal(lines.at(-1).event,'group-membership');assert.equal(lines.at(-1).payload.kind,'leave');
  membership.onRecvSysMsg([18,2,8,44,26,11,18,9,8,123,34,5,18,3,10,1,117]);
  assert.equal(lines.at(-1).event,'group-admin');assert.equal(lines.at(-1).payload.memberUid,'u');
  membership.onRecvMsg([{msgId:'1',chatType:2,msgType:5,peerUid:'123',elements:[{grayTipElement:{subElementType:4,groupElement:{type:8,shutUp:{duration:'0',admin:{uid:'u_admin'},member:{uid:''}}}}}]}]);
  assert.equal(lines.at(-1).event,'group-mute');assert.equal(lines.at(-1).payload.scope,'all');
  const {createNativeServices}=await load('native-services.js');
  const groupListeners=[];const compiledServices=createNativeServices({
    getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),
    getGroupService:()=>({addKernelGroupListener(value){groupListeners.push(value);},getGroupShutUpMemberList(id){for(const listener of groupListeners)listener.onShutUpMemberListChanged(id,[]);return {result:0};}})
  },'7.0.2-53644',()=>{});
  try{assert.deepEqual(await compiledServices.invokeOperation('listGroupMutedMembers',{groupId:'123'}),[]);}finally{compiledServices.close();}
  const categoryProfile={platform:'darwin',arch:'arm64',clientVersion:'7.0.2-53644',wrapperSha256:'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358'};
  const categoryCalls=[];const categoryServices=createNativeServices({
    getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),
    getBuddyService:()=>({addKernelBuddyListener(){},addCategoryV2(...args){categoryCalls.push(args);return {result:0,groupId:8,name:'native'};}})
  },'7.0.2-53644',()=>{},undefined,undefined,undefined,undefined,undefined,undefined,categoryProfile);
  try{assert.deepEqual(await categoryServices.invokeOperation('addFriendCategory',{name:' 新分组 '}),{categoryId:8,name:'native'});assert.deepEqual(categoryCalls,[[' 新分组 ',undefined]]);}finally{categoryServices.close();}
  membership.close();
  stop(); assert.equal(events.listenerCount('group-info-updated'), 0);assert.equal(events.listenerCount('group-membership'),0);assert.equal(events.listenerCount('group-admin'),0);assert.equal(events.listenerCount('group-mute'),0);
  return {friendCategoryCreationContract:true,nativeFriendCategoryCreationAttempted:false,...await verifyContactGroupWorkerRoutes({ QQClient, workerPath: join(packageRoot, 'dist/worker.js'), kernelPath: join(packageRoot, 'dist/kernel.js') })};
}
