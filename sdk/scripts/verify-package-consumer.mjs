import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { verifyForwardConsumer } from './consumers/forward-consumer-contract.mjs';
import { verifyRecallConsumer } from './consumers/recall-consumer-contract.mjs';
import { verifyMentionConsumer } from './consumers/mention-consumer-contract.mjs';
import { verifySendConsumer } from './consumers/send-consumer-contract.mjs';
import { verifyFaceConsumer } from './consumers/face-consumer-contract.mjs';
import { verifyElementPreparationConsumer } from './consumers/element-preparation-consumer-contract.mjs';
import { verifyReceivedConsumer } from './consumers/received-consumer-contract.mjs';
import { verifyVideoConsumerContract } from './consumers/video-consumer-contract.mjs';
import { verifyMessageBatchConsumer } from './consumers/message-batch-consumer-contract.mjs';
import { verifyHistoryLifecycleConsumer } from './consumers/history-lifecycle-consumer-contract.mjs';
import { verifyForwardResourceConsumer } from './consumers/forward-resource-consumer-contract.mjs';
import { verifyForwardResourceTypes } from './consumers/forward-resource-type-contract.mjs';
import { verifyDownloadConsumer } from './consumers/download-consumer-contract.mjs';
import { verifyKernelSessionConsumer } from './consumers/kernel-session-consumer-contract.mjs';
import { verifyReceivedForwardConsumer } from './consumers/received-forward-consumer-contract.mjs';
import { verifyContactGroupConsumer } from './consumers/contact-group-consumer-contract.mjs';
import { verifyPublicContracts } from './consumers/public-contract-consumer.mjs';
import { verifyGroupEssenceConsumer } from './consumers/group-essence-consumer-contract.mjs';
import { verifyWorkerReadCancellation } from './consumers/worker-read-consumer-contract.mjs';
import { verifyClientFactoryConsumer } from './consumers/client-factory-consumer-contract.mjs';
import { verifyWorkerErrorRoutes } from './consumers/worker-error-consumer-contract.mjs';
import { verifyWorkerDelivery } from './consumers/worker-delivery-consumer-contract.mjs';
import { verifyWorkerBootstrapConsumer } from './consumers/worker-bootstrap-consumer-contract.mjs';
import { verifyActionPortConsumer } from './consumers/action-port-consumer-contract.mjs';
import { verifyProfileRequestConsumer } from './consumers/profile-request-consumer-contract.mjs';
import { verifyGroupRequestConsumer } from './consumers/group-request-consumer-contract.mjs';
import { verifyGroupNoticeConsumer } from './consumers/group-notice-consumer-contract.mjs';
import { verifyGroupSearchConsumer } from './consumers/group-search-consumer-contract.mjs';
import { verifyGroupQueryOwnerConsumer } from './consumers/group-query-owner-consumer-contract.mjs';
import { verifyContactGroupSnapshots } from './consumers/contact-group-snapshot-consumer-contract.mjs';
import { verifyContactDirectoryLifetimeConsumer } from './consumers/contact-directory-lifetime-consumer-contract.mjs';
import { verifyFeatureWaitRetirementConsumer } from './consumers/feature-wait-retirement-consumer-contract.mjs';
import { verifyRequestResultConsumer } from './consumers/request-result-consumer-contract.mjs';
import { verifyGroupFileActionLifetimeConsumer } from './consumers/group-file-action-consumer-contract.mjs';
import { verifyGroupFilePagesConsumer } from './consumers/group-file-pages-consumer-contract.mjs';
import { verifyQunWebConsumer } from './consumers/qun-web-consumer-contract.mjs';
import { verifyFriendCategoryMutationsConsumer } from './consumers/friend-category-mutations-consumer-contract.mjs';
import { verifyFriendQueryConsumer } from './consumers/friend-query-consumer-contract.mjs';
import { verifyHistoryQueryConsumer } from './consumers/history-query-consumer-contract.mjs';

// Offline packaging check: controlled services and actual worker routing with a replacement kernel; no QQ native binaries or accounts.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = await mkdtemp(join(tmpdir(), 'qq-package-consumer-'));
/** @param {string} command @param {string[]} args @param {string} [cwd] */
const run = (command, args, cwd = destination) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
run('npm', ['run', 'build'], root);
const packed = JSON.parse(
  run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], root),
)[0];
/** @type {string[]} */
const files = packed.files.map((/** @type {{path:string}} */ file) => file.path);
if (files.some((path) => /^dist\/features\/media\/media-operations\.(?:js|d\.ts)$/.test(path)))
  throw new Error('Obsolete generic media-operation module remains in package');
if (files.some((path) => /^dist\/features\/messages\/message-elements\.(?:js|d\.ts)$/.test(path)))
  throw new Error('Obsolete mixed message-element module remains in package');
if (
  files.some((path) =>
    /^dist\/features\/contacts\/friend-category-rename\.(?:js|d\.ts)$/.test(path),
  )
)
  throw new Error('Obsolete category rename implementation remains in package');
if (
  files.some((path) =>
    /(^|\/)(\.local|test|scripts|node_modules)(\/|$)|\.(db|db-wal|db-shm)$/.test(path),
  )
)
  throw new Error('Private or development files leaked into package');
for (const path of [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli.js',
  'native/registration-bridge.c',
]) {
  if (!files.includes(path)) throw new Error(`Missing package file ${path}`);
}
await writeFile(
  join(destination, 'package.json'),
  JSON.stringify({ private: true, type: 'module' }),
);
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const installedSilk = JSON.parse(
  await readFile(join(root, 'node_modules/silk-wasm/package.json'), 'utf8'),
);
const silkVersion = lock.packages?.['node_modules/silk-wasm']?.version;
if (silkVersion !== '3.7.1' || installedSilk.version !== silkVersion)
  throw new Error('Installed SILK dependency does not match the pinned lock version');
const silkPacked = JSON.parse(
  run('npm', [
    'pack',
    lock.packages['node_modules/silk-wasm'].resolved,
    '--offline',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destination,
  ]),
)[0];
if (
  silkPacked.name !== 'silk-wasm' ||
  silkPacked.version !== silkVersion ||
  silkPacked.integrity !== lock.packages['node_modules/silk-wasm'].integrity
)
  throw new Error('Offline SILK tarball does not match the pinned lock integrity');
run('npm', [
  'install',
  '--offline',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  join(destination, packed.filename),
  join(destination, silkPacked.filename),
]);
await writeFile(
  join(destination, 'import.mjs'),
  `import {createClient, QQClient} from 'qq-native-client';\nif(typeof createClient !== 'function' || typeof QQClient !== 'function') throw new Error('Invalid exports');\n`,
);
run(process.execPath, ['import.mjs']);
const clientFactoryChecks = await verifyClientFactoryConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const publicContractChecks = await verifyPublicContracts(
  join(destination, 'node_modules/qq-native-client'),
  resolve(root, 'node_modules/typescript'),
  [resolve(root, 'node_modules/@types')],
);
const contactGroupChecks = await verifyContactGroupConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const messageBatchChecks = await verifyMessageBatchConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const groupEssenceChecks = await verifyGroupEssenceConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const readCancellationChecks = await verifyWorkerReadCancellation({
  QQClient: (
    await import(
      pathToFileURL(join(destination, 'node_modules/qq-native-client/dist/index.js')).href
    )
  ).QQClient,
  workerPath: join(destination, 'node_modules/qq-native-client/dist/worker.js'),
  kernelPath: join(destination, 'node_modules/qq-native-client/dist/kernel.js'),
  nativeServicesPath: join(destination, 'node_modules/qq-native-client/dist/native-services.js'),
});
const workerBootstrapChecks = await verifyWorkerBootstrapConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const workerDeliveryChecks = await verifyWorkerDelivery({
  workerPath: join(destination, 'node_modules/qq-native-client/dist/worker.js'),
  bootstrapPath: join(destination, 'node_modules/qq-native-client/dist/worker/bootstrap.js'),
});
const workerErrorChecks = await verifyWorkerErrorRoutes({
  errorsPath: join(destination, 'node_modules/qq-native-client/dist/errors.js'),
  QQClient: (
    await import(
      pathToFileURL(join(destination, 'node_modules/qq-native-client/dist/index.js')).href
    )
  ).QQClient,
  workerPath: join(destination, 'node_modules/qq-native-client/dist/worker.js'),
  kernelPath: join(destination, 'node_modules/qq-native-client/dist/kernel.js'),
  nativeContractsPath: join(
    destination,
    'node_modules/qq-native-client/dist/native/native-contract-inspection.js',
  ),
});
const historyLifecycleChecks = await verifyHistoryLifecycleConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const forwardResourceChecks = await verifyForwardResourceConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const downloadChecks = await verifyDownloadConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const sessionStrategyChecks = await verifyKernelSessionConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const forwardResourceTypeChecks = await verifyForwardResourceTypes(
  join(destination, 'node_modules/qq-native-client'),
  resolve(root, 'node_modules/typescript'),
  [resolve(root, 'node_modules/@types')],
);
const receivedForwardChecks = await verifyReceivedForwardConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const faceChecks = await verifyFaceConsumer(join(destination, 'node_modules/qq-native-client'));
const profileRequestChecks = await verifyProfileRequestConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const actionPortChecks = await verifyActionPortConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const groupRequestChecks = await verifyGroupRequestConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const groupNoticeChecks = await verifyGroupNoticeConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const groupSearchChecks = await verifyGroupSearchConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const groupQueryOwnerChecks = await verifyGroupQueryOwnerConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const contactGroupSnapshotChecks = await verifyContactGroupSnapshots(
  join(destination, 'node_modules/qq-native-client'),
);
const requestResultChecks = await verifyRequestResultConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const contactDirectoryLifetimeChecks = await verifyContactDirectoryLifetimeConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const featureWaitRetirementChecks = await verifyFeatureWaitRetirementConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const groupFileActionChecks = await verifyGroupFileActionLifetimeConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const groupFilePagesChecks = await verifyGroupFilePagesConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const friendCategoryMutationChecks = await verifyFriendCategoryMutationsConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const groupWebChecks = await verifyQunWebConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
await writeFile(
  join(destination, 'group-members.mjs'),
  `import assert from 'node:assert/strict';
import {createNativeServices} from './node_modules/qq-native-client/dist/native-services.js';
let response={errCode:0,result:{infos:new Map(),finish:true}},calls=0;
const module=createNativeServices({
  session: {getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){},getAllMemberList(groupId,refresh){assert.deepEqual([groupId,refresh],['123',false]);calls++;return response;}})},
  version: '7.0.2-53644',
  events: { emit: ()=>{} }
});
try {
 assert.deepEqual(await module.invokeOperation('getGroupMembers',{groupId:'123'}),[]);
 for(const [value,code] of [[{errCode:73,result:{infos:new Map(),finish:true}},73],[{errCode:'denied',result:{infos:new Map(),finish:true}},'denied'],[{errCode:0,result:{infos:new Map(),finish:false}},'incomplete-result']]){response=value;await assert.rejects(module.invokeOperation('getGroupMembers',{groupId:'123'}),{code});}
 assert.equal(calls,4);
} finally {module.close();}
// Complete member identity/DTO validation and failure-cache isolation.
const valid={uid:'u_member',uin:'900719925474099312345',nick:'member',cardName:'',role:2};
function membersFixture(infos){return createNativeServices({
  session: {getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){},getAllMemberList(){return{errCode:0,result:{finish:true,infos}};}})},
  version: '7.0.2-53644',
  events: { emit: ()=>{} }
});}
for(const [key,member] of [['u_member',{...valid,uin:456}],['u_member',{...valid,uin:{toString(){throw Error('Coercion must not run');}}}],['u_member',{...valid,uid:'u_other'}],['',{...valid,uid:''}],['u_member',{...valid,nick:{secret:true}}],['u_member',{...valid,cardName:12}],['u_member',{...valid,uid:undefined}],['u_member',{...valid,nick:undefined}],['u_member',{...valid,cardName:undefined}],['u_member',{...valid,role:'2'}],['u_member',{...valid,role:0}],['u_member',{...valid,role:1}]]){
 const query=membersFixture(new Map([[key,member]]));try{await assert.rejects(query.invokeOperation('getGroupMembers',{groupId:'123'}),/native group member/);}finally{query.close();}
}
const roles=membersFixture(new Map([['u_member',valid],['u_admin',{...valid,uid:'u_admin',uin:'456',role:3}],['u_owner',{...valid,uid:'u_owner',uin:'789',role:4}]]));
try{assert.deepEqual(await roles.invokeOperation('getGroupMembers',{groupId:'123'}),[{userId:valid.uin,uid:'u_member',nickname:'member',card:'',role:'member'},{userId:'456',uid:'u_admin',nickname:'member',card:'',role:'admin'},{userId:'789',uid:'u_owner',nickname:'member',card:'',role:'owner'}]);}finally{roles.close();}
let conversions=0;
const atomic=createNativeServices({
  session: {getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){},getAllMemberList(){return{errCode:0,result:{finish:true,infos:new Map([['u_first',{...valid,uid:'u_first',uin:'456'}],['u_bad',{...valid,uid:'u_bad',role:999}]])}};}}),getUixConvertService:()=>({getUid(ids){assert.deepEqual(ids,['456']);conversions++;return{uidInfo:new Map()};}})},
  version: '7.0.2-53644',
  events: { emit: ()=>{} }
});
try{await assert.rejects(atomic.invokeOperation('getGroupMembers',{groupId:'123'}),/Unknown native group member role/);await assert.rejects(atomic.invokeOperation('sendPrivateMessage',{userId:'456',message:'fixture'}),/Could not resolve user identifier/);assert.equal(conversions,1);}finally{atomic.close();}
`,
);
run(process.execPath, ['group-members.mjs']);
await writeFile(
  join(destination, 'group-events.mjs'),
  `import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createGroupEvents} from './node_modules/qq-native-client/dist/features/groups/group-events.js';
import {observeWatchEvents} from './node_modules/qq-native-client/dist/cli.js';
const client=new EventEmitter(),lines=[],diagnostics=[];
client.on('diagnostic',value=>diagnostics.push(value));
const listener=createGroupEvents((name,value)=>client.emit(name,value));
const cleanup=observeWatchEvents(client,'all',line=>lines.push(JSON.parse(line)));
listener.onGroupListUpdate(3,[{groupCode:'123'}]);
listener.onMemberInfoChange('123',1,new Map([['u',{uid:'u',uin:'456',role:3,isChangeRole:true}]]));
assert.deepEqual(lines,[{event:'group-list-updated',payload:{kind:'removed',groups:[{groupId:'123'}]}},{event:'group-members-updated',payload:{groupId:'123',source:'remote',members:[{uid:'u',userId:'456',role:'admin',roleChanged:true}]}}]);
client.emit('authenticated',{credential:'fixture-secret'});client.emit('msf-status',{status:1});
listener.onGroupListUpdate(1,Array(1));
listener.onMemberInfoChange('123',1,new Map([['u',{uid:'different',credential:'fixture-secret'}]]));
assert.equal(lines.length,2);assert.deepEqual(diagnostics,[{stage:'invalid-native-group-list-update'},{stage:'invalid-native-group-member-update'}]);
assert.doesNotMatch(JSON.stringify({lines,diagnostics}),/credential|fixture-secret/);
cleanup();listener.onGroupListUpdate(0,[]);assert.equal(lines.length,2);
const defaults=[];const removeDefault=observeWatchEvents(client,undefined,line=>defaults.push(JSON.parse(line)));
client.emit('message',{messageId:'42'});listener.onGroupListUpdate(0,[]);assert.deepEqual(defaults,[{messageId:'42'}]);removeDefault();
`,
);
run(process.execPath, ['group-events.mjs']);
await writeFile(
  join(destination, 'friend-events.mjs'),
  `import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createFriendEvents} from './node_modules/qq-native-client/dist/features/contacts/friend-events.js';
import {observeWatchEvents} from './node_modules/qq-native-client/dist/cli.js';
const events=[];const listener=createFriendEvents((event,payload)=>events.push([event,payload]));
const expected={categories:[{categoryId:1,name:'fixture',memberCount:1,friends:[{uid:'u_friend',userId:'900719925474099312345',nickname:'friend',remark:'remark'}]}]};
listener.onBuddyListChange([{categoryId:1,categoryName:'fixture',categoryMbCount:1,buddyList:[{uid:'u_friend',uin:'900719925474099312345',nick:'friend',remark:'remark',secret:'must-not-leak'}],secret:'must-not-leak'}]);
assert.deepEqual(events.pop(),['friend-list-updated',expected]);
listener.onBuddyListChange([{categoryId:2,categoryName:'empty',categoryMbCount:0,buddyList:[]}]);
assert.deepEqual(events.pop(),['friend-list-updated',{categories:[{categoryId:2,name:'empty',memberCount:0,friends:[]}]}]);
listener.onBuddyListChange([{categoryId:1,categoryName:'private',categoryMbCount:0,buddyList:[]},{categoryId:'bad',categoryName:'bad',categoryMbCount:0,buddyList:[]}]);
assert.deepEqual(events,[['diagnostic',{stage:'invalid-native-friend-list-update'}]]);assert.ok(!JSON.stringify(events).includes('private'));
const client=new EventEmitter(),lines=[];const cleanup=observeWatchEvents(client,'all',line=>lines.push(JSON.parse(line)));
client.emit('friend-list-updated',expected);assert.deepEqual(lines,[{event:'friend-list-updated',payload:expected}]);cleanup();client.emit('friend-list-updated',expected);assert.equal(lines.length,1);
const plain=[];const cleanDefault=observeWatchEvents(client,undefined,line=>plain.push(JSON.parse(line)));client.emit('friend-list-updated',expected);client.emit('message',{fixture:true});assert.deepEqual(plain,[{fixture:true}]);cleanDefault();
`,
);
run(process.execPath, ['friend-events.mjs']);
/** @type {Awaited<ReturnType<typeof verifyFriendQueryConsumer>>} */
const friendQueryChecks = await verifyFriendQueryConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const help = run(process.execPath, ['node_modules/qq-native-client/dist/cli.js', '--help']);
if (!help.includes('group-kick') || !help.includes('--message-file'))
  throw new Error('Installed CLI lacks commands');
const cliEntry = 'node_modules/qq-native-client/dist/cli.js';
for (const name of ['constructor', 'toString', '__proto__']) {
  const result = spawnSync(process.execPath, [cliEntry, name, '--config', 'absent-config.json'], {
    cwd: destination,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (
    result.status !== 1 ||
    !result.stderr.includes(`Unknown command: ${name}`) ||
    /ENOENT|TypeError|Duplicate option/.test(result.stderr)
  )
    throw new Error('Installed CLI accepted an inherited command name');
}
const inheritedOption = spawnSync(
  process.execPath,
  [cliEntry, 'contacts', '--__proto__', 'fixture'],
  {
    cwd: destination,
    encoding: 'utf8',
    timeout: 5000,
  },
);
if (
  inheritedOption.status !== 1 ||
  !inheritedOption.stderr.includes('Unknown option for contacts: --__proto__')
)
  throw new Error('Installed CLI did not validate an own unknown option');
if (!help.includes('signature')) throw new Error('Installed CLI lacks signature command');
if (!help.includes('--events message|all|normalized'))
  throw new Error('Installed CLI lacks business event watch mode');
if (!help.includes('message --config'))
  throw new Error('Installed CLI lacks single-message lookup');
await writeFile(
  join(destination, 'message-query.mjs'),
  `import assert from 'node:assert/strict';
import {prepareCommand} from './node_modules/qq-native-client/dist/cli.js';
import {queryNativeMessage} from './node_modules/qq-native-client/dist/features/messages/message-query.js';
const peer={chatType:2,peerUid:'123'},id='900719925474099312345';
const action=await prepareCommand('message',{kind:'group',target:'123','message-id':id});
let received;assert.equal(await action({getMessage:async(...args)=>{received=args;}}),null);
assert.deepEqual(received,[{type:'group',groupId:'123'},id]);
assert.equal(await queryNativeMessage({getMsgsByMsgId:(p,ids)=>{assert.deepEqual(p,peer);assert.deepEqual(ids,[id]);return{result:0,msgList:[]};}},peer,id),undefined);
await assert.rejects(queryNativeMessage({getMsgsByMsgId:()=>({result:23,msgList:[]})},peer,id),{code:23});
`,
);
run(process.execPath, ['message-query.mjs']);
/** @type {Awaited<ReturnType<typeof verifyHistoryQueryConsumer>>} */
const historyQueryChecks = await verifyHistoryQueryConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const forwardChecks = await verifyForwardConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const recallChecks = await verifyRecallConsumer(join(destination, 'node_modules/qq-native-client'));
const mentionChecks = await verifyMentionConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const sendChecks = await verifySendConsumer(join(destination, 'node_modules/qq-native-client'));
const elementPreparationChecks = await verifyElementPreparationConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const receivedChecks = await verifyReceivedConsumer(
  join(destination, 'node_modules/qq-native-client'),
);
const videoChecks = await verifyVideoConsumerContract(
  join(destination, 'node_modules/qq-native-client'),
);
run(process.execPath, [
  cliEntry,
  'init',
  '--config',
  'qq.json',
  '--data-dir',
  'account',
  '--download-mirror',
  'https://gh-proxy.com/',
]);
const configuration = JSON.parse(
  run(process.execPath, [cliEntry, 'config', '--config', 'qq.json']),
);
if (
  configuration.wrapperPath ||
  configuration.version ||
  configuration.downloadMirrors?.[0] !== 'https://gh-proxy.com/'
)
  throw new Error('Installed CLI default catalog configuration failed');
await writeFile(
  join(destination, 'consumer.ts'),
  `import {createClient, type ClientOptions, type QQClient, type MessageRecall, type VideoCodec, type VideoInfo, type Message, type FriendCategory, type CreatedFriendCategory} from 'qq-native-client';
const options: ClientOptions = {dataDir:'/account',videoCodecPath:'/codec.node',downloadMirrors:['https://gh-proxy.com/'],autoReconnect:false};
const videoInfo: VideoInfo = {width:1280,height:720,duration:2.75,format:'png',image:Buffer.alloc(0)};
const videoCodec: VideoCodec = {getVideoInfo:async (_filePath:string):Promise<VideoInfo>=>videoInfo};
void videoCodec;
const factory: (options: ClientOptions) => Promise<QQClient> = createClient;
function subscribe(client: QQClient) {
 client.on('message.recalled', (recall: MessageRecall) => { const fields: string[] = [recall.messageId,recall.sequence,recall.recallTime]; return [recall.peer,fields]; });
 client.on('native-callback', diagnostic => diagnostic.argumentTypes.join(','));
 client.on('kicked', info => info.args.length);
 client.on('friend-added', notice => [notice.uid,notice.messageId,notice.userId]);
 client.on('friend-list-updated', update => update.categories.map(category => category.friends.map(friend => friend.userId)));
 client.on('request.group', request => request.sequence);
 client.on('group-list-updated', update => update.groups.map(group=>group.groupId));
 client.on('group-members-updated', update => update.members.map(member=>[member.uid,member.deleted,member.role]));
 client.on('group-admin', update => [update.groupId,update.memberUid,update.enabled]);
 client.on('group-mute', update => [update.groupId,update.scope,update.durationSeconds,update.operatorUid,update.memberUid]);
 void client.listGroupMutedMembers('123').then(values=>values.map(value=>[value.role,value.shutUpTime]));
 client.on('group-membership', update => [update.groupId,update.kind,update.memberUid,update.operatorUid,update.code]);
 void client.getGroupInfo('123').then(value=>value.description);
 client.on('group-info-updated', update => [update.groupId,update.ownerUid,update.ownerUserId,update.description]);
 const createdCategory: Promise<CreatedFriendCategory> = client.addFriendCategory('分组');
 const renamedCategory: Promise<void> = client.renameFriendCategory(123, 'name');
 void renamedCategory;
 // @ts-expect-error Category selectors use numeric uint32 values, never names.
 client.renameFriendCategory('123', 'name');
 const deletedCategory: Promise<void> = client.deleteFriendCategory(123);
 void deletedCategory;
 // @ts-expect-error Deletion also requires numeric category selectors.
 client.deleteFriendCategory('123');
 const orderedCategories: Promise<void> = client.reorderFriendCategories([{categoryId:123,name:'original'}] as const);
 void orderedCategories;
 // @ts-expect-error Reordering requires explicit names as well as numeric category IDs.
 client.reorderFriendCategories([{categoryId:123}]);
 // @ts-expect-error Reordering does not expose native numeric coercion.
 client.reorderFriendCategories([{categoryId:'123',name:'original'}]);
 const categories: Promise<FriendCategory[]> = client.listFriendCategories();
 const fileCount: Promise<number> = client.getGroupFileCount('123');
 void fileCount;
 // @ts-expect-error Count queries require string group IDs.
 client.getGroupFileCount(123);
 const folderDelete: Promise<void> = client.deleteGroupFolder('18446744073709551615','opaque-folder');
 const fileDelete: Promise<void> = client.deleteGroupFile('18446744073709551615','opaque-file');
 // @ts-expect-error group file IDs remain opaque strings
 client.deleteGroupFile('123',123);
 void folderDelete;
 // @ts-expect-error Folder identity must be a string.
 client.deleteGroupFolder('123',123);
 // @ts-expect-error Group identity must be a string.
 client.deleteGroupFolder(123,'folder');
 const remark: Promise<void> = client.setGroupRemark('123','');
 const essencePage = client.getGroupEssencePage('123', { pageStart: 17, pageLimit: 2 });
 const fullEssence: Promise<import('qq-native-client').GroupEssenceMessage[]> = client.listGroupEssenceMessages('123', { maxPages: 2 });
 void fullEssence;
 // @ts-expect-error Full read budget requires a numeric value.
 client.listGroupEssenceMessages('123', { maxPages: '2' });
 // @ts-expect-error Full reads start from page zero with a fixed page size.
 client.listGroupEssenceMessages('123', { pageStart: 1 });
 void essencePage.then(page => [page.isEnd, page.messages.map(item=>[item.sequence,item.operatorId,item.content])]);
 // @ts-expect-error Essence pagination requires numeric values.
 client.getGroupEssencePage('123', { pageStart: '17' });
 const essence: Promise<void> = client.setGroupEssenceMessage('123','9876543210123456789',true);
 // @ts-expect-error Essence enablement is an explicit boolean.
 client.setGroupEssenceMessage('123','9','true');
 void essence;
 void categories; void remark;
 const page = client.listGroupRequests({doubt:false,limit:20});
 const publish: Promise<void> = client.publishGroupNotice('123','example',{pinned:true,confirmRequired:false});
 const remove: Promise<void> = client.deleteGroupNotice('123','notice_id');
 const notices = client.listGroupNotices('123');
 const nickname: Promise<void> = client.setNickname('example');
 const signature: Promise<void> = client.setSignature('');
 void signature;
 const message = client.getMessage({type:'group',groupId:'123'},'900719925474099312345');
 void message.then(value=>value?.messageId);
 const ids = ['900719925474099312345', '2'] as const;
 const batch: Promise<(Message | undefined)[]> = client.getMessages({type:'group',groupId:'123'}, ids);
 void batch.then(values=>values.map(value=>value?.messageId));
 void client.getGroupMembers('123').then(values=>values.map(value=>value.role));
 void nickname;
 void notices.then(page=>page.notices.map(notice=>notice.noticeId));
 void publish; void remove;
 void page.then(value => value.requests.map(request => request.kind));
 return client.sendPrivateMessage('123', [{type:'text',text:'example'},{type:'face',id:14}]);
}
void factory; void options; void subscribe;
`,
);
run(process.execPath, [
  resolve(root, 'node_modules/typescript/bin/tsc'),
  '--noEmit',
  '--strict',
  '--types',
  'node',
  '--module',
  'NodeNext',
  '--target',
  'ES2023',
  '--typeRoots',
  resolve(root, 'node_modules/@types'),
  'consumer.ts',
]);
const receipt = {
  checkedAt: new Date().toISOString(),
  package: packed.name,
  version: packed.version,
  integrity: packed.integrity,
  fileCount: files.length,
  checks: {
    ...clientFactoryChecks,
    ...groupEssenceChecks,
    ...readCancellationChecks,
    ...workerErrorChecks,
    ...workerDeliveryChecks,
    workerBootstrapChecks,
    ...actionPortChecks,
    ...profileRequestChecks,
    ...groupRequestChecks,
    ...groupNoticeChecks,
    ...groupWebChecks,
    ...friendCategoryMutationChecks,
    groupSearchChecks,
    groupQueryOwnerChecks,
    contactGroupSnapshotChecks,
    contactDirectoryLifetimeChecks,
    featureWaitRetirementChecks,
    requestResultChecks,
    groupFilePagesChecks,
    groupFileActionChecks,
    ...publicContractChecks,
    privateFilesExcluded: true,
    installedImport: true,
    cliHelp: true,
    cliCommandNamespaceContract: true,
    cliDefaultConfig: true,
    ...faceChecks,
    messageQueryContract: true,
    selfProfileContract: true,
    groupOperationContract: true,
    groupMemberQueryContract: true,
    groupMemberIdentityContract: true,
    groupMetadataEventContract: true,
    businessWatchContract: true,
    friendMetadataEventContract: true,
    nativeFriendMetadataObserved: false,
    ...friendQueryChecks,
    ...historyQueryChecks,
    declarations: true,
  },
  ...contactGroupChecks,
  ...sessionStrategyChecks,
  ...downloadChecks,
  ...messageBatchChecks,
  ...historyLifecycleChecks,
  ...forwardResourceChecks,
  forwardResourceDeclarationsContract: forwardResourceTypeChecks.success,
  forwardResourceTypeChecks,
  ...receivedForwardChecks,
  ...forwardChecks,
  ...recallChecks,
  ...mentionChecks,
  ...sendChecks,
  ...elementPreparationChecks,
  ...receivedChecks,
  ...videoChecks,
  nativeExecuted: false,
  accountUsed: false,
};
await mkdir(join(root, '.local'), { recursive: true });
await writeFile(
  join(root, '.local/package-consumer-verification.json'),
  JSON.stringify(receipt, null, 2),
);
await mkdir(join(root, '.local/research'), { recursive: true });
await writeFile(
  join(root, '.local/research/signature-installed-consumer.json'),
  JSON.stringify(receipt, null, 2),
);
await writeFile(
  join(root, '.local/research/group-return-installed-consumer.json'),
  JSON.stringify(receipt, null, 2),
);
await writeFile(
  join(root, '.local/research/group-members-installed-consumer.json'),
  JSON.stringify(receipt, null, 2),
);
await writeFile(
  join(root, '.local/research/group-events-installed-consumer.json'),
  JSON.stringify(receipt, null, 2),
);
await writeFile(
  join(root, '.local/research/forward-installed-consumer.json'),
  JSON.stringify(receipt, null, 2),
);
console.log(JSON.stringify(receipt, null, 2));
