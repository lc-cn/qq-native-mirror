import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Offline packaging check: never creates a QQ client or loads native binaries.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = await mkdtemp(join(tmpdir(), 'qq-package-consumer-'));
const run = (command, args, cwd = destination) => execFileSync(command, args, {
  cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(root, '.local/npm-cache') },
});
run('npm', ['run', 'build'], root);
const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], root))[0];
const files = packed.files.map(file => file.path);
if (files.some(path => /(^|\/)(\.local|test|scripts|node_modules)(\/|$)|\.(db|db-wal|db-shm)$/.test(path))) throw new Error('Private or development files leaked into package');
for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'native/registration-bridge.c']) {
  if (!files.includes(path)) throw new Error(`Missing package file ${path}`);
}
await writeFile(join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(destination, packed.filename), join(root, '.local/artifacts/silk-wasm-3.7.1.tgz')]);
await writeFile(join(destination, 'import.mjs'), `import {createClient, QQClient} from 'qq-native-client';\nif(typeof createClient !== 'function' || typeof QQClient !== 'function') throw new Error('Invalid exports');\n`);
run(process.execPath, ['import.mjs']);
await writeFile(join(destination, 'faces.mjs'), `import assert from 'node:assert/strict';
import {normalizeMessage, prepareCommand} from './node_modules/qq-native-client/dist/cli.js';
import {faceElement} from './node_modules/qq-native-client/dist/message-elements.js';
const mixed=[{type:'text',text:'hello'},{type:'face',id:14},{type:'face',id:333}];
assert.deepEqual(normalizeMessage(mixed),mixed);
assert.deepEqual(faceElement(428),{elementType:6,elementId:'',faceElement:{faceIndex:428,faceType:2,faceText:'/收到',sourceType:1,stickerType:0,packId:'0',stickerId:'0'}});
assert.throws(()=>normalizeMessage([{type:'face',id:99999}]),/Unsupported QQ face/);
const action=await prepareCommand('send',{kind:'group',target:'123','message-file':'faces.json'});
let received; await action({sendGroupMessage:async(...args)=>{received=args;}});
assert.deepEqual(received,['123',mixed]);
`);
await writeFile(join(destination, 'faces.json'), JSON.stringify([{type:'text',text:'hello'},{type:'face',id:14},{type:'face',id:333}]));
run(process.execPath, ['faces.mjs']);
await writeFile(join(destination, 'self-profile.mjs'), `import assert from 'node:assert/strict';
import {QQClient} from 'qq-native-client';
import {createSelfProfile} from './node_modules/qq-native-client/dist/self-profile.js';
import {prepareCommand} from './node_modules/qq-native-client/dist/cli.js';
for(const text of ['','  spaced signature  ']){let actual;const action=await prepareCommand('signature',{text});await action({setSignature:async value=>{actual=value;}});assert.equal(actual,text);}
assert.equal(typeof QQClient.prototype.setSignature,'function');
function fixture(nickname='original nickname',missing=false) {
 let listener; const writes=[];
 const service={addKernelProfileListener(value){listener=value;return 1;},removeKernelProfileListener(){},
  fetchUserDetailInfo(trace,uids,source,biz){assert.equal(trace,'BuddyProfileStore');assert.deepEqual(uids,['self']);assert.equal(source,1);assert.deepEqual(biz,[0]);listener.onUserDetailInfoChanged({uid:'self',simpleInfo:{coreInfo:missing?{}:{nick:nickname},baseInfo:{longNick:'original signature',sex:255,birthday_year:2000,birthday_month:1,birthday_day:2}}});return{result:0};},
  modifyDesktopMiniProfile(payload){writes.push(payload);return{result:0};}};
 return {module:createSelfProfile({getProfileService:()=>service},()=> 'self'),writes};
}
const birthday={birthday_year:'2000',birthday_month:'1',birthday_day:'2'};
const nickname=fixture();try{await nickname.module.invokeOperation('setNickname',{name:'new nickname'});assert.deepEqual(nickname.writes,[{nick:'new nickname',longNick:'original signature',sex:255,birthday,location:undefined}]);}finally{nickname.module.close();}
for(const text of ['new signature','']){const f=fixture();try{await f.module.invokeOperation('setSignature',{text});assert.deepEqual(f.writes,[{nick:'original nickname',longNick:text,sex:255,birthday,location:undefined}]);}finally{f.module.close();}}
const missing=fixture('unused',true);try{await assert.rejects(missing.module.invokeOperation('setSignature',{text:'new'}),/nickname|preserv|profile/i);assert.equal(missing.writes.length,0);}finally{missing.module.close();}
`);
run(process.execPath, ['self-profile.mjs']);
await writeFile(join(destination, 'group-operations.mjs'), `import assert from 'node:assert/strict';
import {QQClient} from 'qq-native-client';
import {createGroupOperations} from './node_modules/qq-native-client/dist/group-operations.js';
import {prepareCommand} from './node_modules/qq-native-client/dist/cli.js';
const calls=[];
const service={modifyMemberRole:(...args)=>{calls.push(['role',args]);},modifyMemberCardName:(...args)=>{calls.push(['card',args]);},kickMember:async(...args)=>{calls.push(['kick',args]);},quitGroup:(...args)=>{calls.push(['quit',args]);}};
const module=createGroupOperations({getGroupService:()=>service},async()=> 'u_fixture');
const client={};
for(const method of ['setGroupAdmin','setGroupMemberCard','kickGroupMember','leaveGroup']){assert.equal(typeof QQClient.prototype[method],'function');}
client.setGroupAdmin=(groupId,userId,enabled)=>module.invokeOperation('setGroupAdmin',{groupId,userId,enabled});
client.setGroupMemberCard=(groupId,userId,card)=>module.invokeOperation('setGroupMemberCard',{groupId,userId,card});
client.kickGroupMember=(groupId,userId,options)=>module.invokeOperation('kickGroupMember',{groupId,userId,options});
client.leaveGroup=groupId=>module.invokeOperation('leaveGroup',{groupId});
for(const [command,flags] of [['member-admin',{'user-id':'456',enabled:'true'}],['member-card',{'user-id':'456',card:''}],['group-kick',{'user-id':'456'}],['group-leave',{}]]){await (await prepareCommand(command,{'group-id':'123',...flags}))(client);}
assert.deepEqual(calls,[['role',['123','u_fixture',3]],['card',['123','u_fixture','']],['kick',['123',['u_fixture'],false,'']],['quit',['123']]]);
const strict=createGroupOperations({getGroupService:()=>({modifyGroupName(){},setGroupShutUp(){},setMemberShutUp(){}})},async()=> 'u_fixture');
for(const [method,payload] of [['setGroupName',{name:'name'}],['setGroupMute',{enabled:true}],['setGroupMemberMute',{userId:'456',seconds:0}]]){await assert.rejects(strict.invokeOperation(method,{groupId:'123',...payload}),{code:'invalid-result'});}
for(const [result,code] of [[{result:'denied'},'denied'],[{result:73},73],[{result:NaN},'invalid-result'],[{},'invalid-result']]){let attempts=0;const rejection=createGroupOperations({getGroupService:()=>({quitGroup(){attempts++;return result;}})},async()=> 'u_fixture');await assert.rejects(rejection.invokeOperation('leaveGroup',{groupId:'123'}),{code});assert.equal(attempts,1);}
`);
run(process.execPath, ['group-operations.mjs']);
await writeFile(join(destination, 'group-members.mjs'), `import assert from 'node:assert/strict';
import {createNativeServices} from './node_modules/qq-native-client/dist/native-services.js';
let response={errCode:0,result:{infos:new Map(),finish:true}},calls=0;
const module=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){},getAllMemberList(groupId,refresh){assert.deepEqual([groupId,refresh],['123',false]);calls++;return response;}})},'7.0.2-53644',()=>{});
try {
 assert.deepEqual(await module.invokeOperation('getGroupMembers',{groupId:'123'}),[]);
 for(const [value,code] of [[{errCode:73,result:{infos:new Map(),finish:true}},73],[{errCode:'denied',result:{infos:new Map(),finish:true}},'denied'],[{errCode:0,result:{infos:new Map(),finish:false}},'incomplete-result']]){response=value;await assert.rejects(module.invokeOperation('getGroupMembers',{groupId:'123'}),{code});}
 assert.equal(calls,4);
} finally {module.close();}
`);
run(process.execPath, ['group-members.mjs']);
const help = run(process.execPath, ['node_modules/qq-native-client/dist/cli.js', '--help']);
if (!help.includes('group-kick') || !help.includes('--message-file')) throw new Error('Installed CLI lacks commands');
const cliEntry='node_modules/qq-native-client/dist/cli.js';
if (!help.includes('signature')) throw new Error('Installed CLI lacks signature command');
if (!help.includes('message --config')) throw new Error('Installed CLI lacks single-message lookup');
await writeFile(join(destination, 'message-query.mjs'), `import assert from 'node:assert/strict';
import {prepareCommand} from './node_modules/qq-native-client/dist/cli.js';
import {queryNativeMessage} from './node_modules/qq-native-client/dist/message-query.js';
const peer={chatType:2,peerUid:'123'},id='900719925474099312345';
const action=await prepareCommand('message',{kind:'group',target:'123','message-id':id});
let received;assert.equal(await action({getMessage:async(...args)=>{received=args;}}),null);
assert.deepEqual(received,[{type:'group',groupId:'123'},id]);
assert.equal(await queryNativeMessage({getMsgsByMsgId:(p,ids)=>{assert.deepEqual(p,peer);assert.deepEqual(ids,[id]);return{result:0,msgList:[]};}},peer,id),undefined);
await assert.rejects(queryNativeMessage({getMsgsByMsgId:()=>({result:23,msgList:[]})},peer,id),{code:23});
`);
run(process.execPath, ['message-query.mjs']);
run(process.execPath,[cliEntry,'init','--config','qq.json','--data-dir','account','--download-mirror','https://gh-proxy.com/']);
const configuration=JSON.parse(run(process.execPath,[cliEntry,'config','--config','qq.json']));
if(configuration.wrapperPath || configuration.version || configuration.downloadMirrors?.[0]!=='https://gh-proxy.com/')throw new Error('Installed CLI default catalog configuration failed');
await writeFile(join(destination, 'consumer.ts'), `import {createClient, type ClientOptions, type QQClient} from 'qq-native-client';
const options: ClientOptions = {dataDir:'/account',downloadMirrors:['https://gh-proxy.com/'],autoReconnect:false};
const factory: (options: ClientOptions) => Promise<QQClient> = createClient;
function subscribe(client: QQClient) {
 client.on('native-callback', diagnostic => diagnostic.argumentTypes.join(','));
 client.on('kicked', info => info.args.length);
 client.on('request.group', request => request.sequence);
 const page = client.listGroupRequests({doubt:false,limit:20});
 const publish: Promise<void> = client.publishGroupNotice('123','example',{pinned:true,confirmRequired:false});
 const remove: Promise<void> = client.deleteGroupNotice('123','notice_id');
 const notices = client.listGroupNotices('123');
 const nickname: Promise<void> = client.setNickname('example');
 const signature: Promise<void> = client.setSignature('');
 void signature;
 const message = client.getMessage({type:'group',groupId:'123'},'900719925474099312345');
 void message.then(value=>value?.messageId);
 void client.getGroupMembers('123').then(values=>values.map(value=>value.role));
 void nickname;
 void notices.then(page=>page.notices.map(notice=>notice.noticeId));
 void publish; void remove;
 void page.then(value => value.requests.map(request => request.kind));
 return client.sendPrivateMessage('123', [{type:'text',text:'example'},{type:'face',id:14}]);
}
void factory; void options; void subscribe;
`);
run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--types', 'node', '--module', 'NodeNext', '--target', 'ES2023', '--typeRoots', resolve(root, 'node_modules/@types'), 'consumer.ts']);
const receipt = { checkedAt: new Date().toISOString(), package: packed.name, version: packed.version,
  integrity: packed.integrity, fileCount: files.length, checks: { privateFilesExcluded:true, installedImport:true, cliHelp:true, cliDefaultConfig:true, faceContract:true, messageQueryContract:true, selfProfileContract:true, groupOperationContract:true, groupMemberQueryContract:true, declarations:true },
  nativeExecuted:false, accountUsed:false };
await mkdir(join(root, '.local'), {recursive:true});
await writeFile(join(root, '.local/package-consumer-verification.json'), JSON.stringify(receipt, null, 2));
await mkdir(join(root, '.local/research'), {recursive:true});
await writeFile(join(root, '.local/research/signature-installed-consumer.json'), JSON.stringify(receipt, null, 2));
await writeFile(join(root, '.local/research/group-return-installed-consumer.json'), JSON.stringify(receipt, null, 2));
await writeFile(join(root, '.local/research/group-members-installed-consumer.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
