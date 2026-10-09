import {npm} from './npm.mjs';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {verifyForwardConsumer} from '../sdk/scripts/forward-consumer-contract.mjs';
import {verifyRecallConsumer} from '../sdk/scripts/recall-consumer-contract.mjs';
const execute=promisify(execFile),temp=await mkdtemp(join(tmpdir(),'qq-ci-consumer-'));
const {version}=JSON.parse(await readFile('sdk/package.json','utf8'));
const platformName=`qq-native-client-${process.platform}-${process.arch}`;
const binaries=new Map();
const add=async(name,v,path)=>{const body=await readFile(path);binaries.set(name,{version:v,body,integrity:'sha512-'+createHash('sha512').update(body).digest('base64')});};
await add('qq-native-client',version,`out/qq-native-client-${version}.tgz`);
await add(platformName,version,`out/${platformName}-${version}.tgz`);
execFileSync(npm[0],[...npm[1],'pack','--ignore-scripts','--pack-destination',resolve('out'),'--json'],{cwd:resolve('sdk/node_modules/silk-wasm'),stdio:'pipe'});
await add('silk-wasm','3.7.1','out/silk-wasm-3.7.1.tgz');
const deviceNames=['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'];
const manifests=new Map();
for(const name of ['qq-native-client',platformName,'silk-wasm']){const r=JSON.parse(execFileSync('tar',['-xOf',name==='silk-wasm'?'out/silk-wasm-3.7.1.tgz':`out/${name}-${version}.tgz`,'package/package.json'],{encoding:'utf8'}));manifests.set(name,r);}
// Metadata fixtures for foreign devices exercise npm's os/cpu filter; no foreign binary is created or executed.
for(const device of deviceNames){const name='qq-native-client-'+device;if(!manifests.has(name)){const [os,cpu]=device.split('-');manifests.set(name,{name,version,os:[os],cpu:[cpu],...(os==='linux'?{libc:['glibc']}:{}),engines:{node:'>=24'}});}}
let origin,client;const tarballRequests=[];
const server=createServer((req,res)=>{
 const name=decodeURIComponent((req.url??'').slice(1));
 if(name.endsWith('.tgz')){const packageName=name.slice(0,-4);tarballRequests.push(packageName);const found=binaries.get(packageName);if(!found)return void res.writeHead(404).end();return void res.end(found.body);}
 const manifest=manifests.get(name);if(!manifest)return void res.writeHead(404).end();
 const bin=binaries.get(name),v=manifest.version;
 res.setHeader('content-type','application/json');res.end(JSON.stringify({name,'dist-tags':{latest:v},versions:{[v]:{...manifest,dist:{tarball:`${origin}/${name}.tgz`,...(bin?{integrity:bin.integrity}:{})}}}}));
});
try {
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});origin=`http://127.0.0.1:${server.address().port}`;
 await writeFile(join(temp,'package.json'),JSON.stringify({name:'qq-ci-consumer',private:true,type:'module'}));
 const {stdout}=await execute(npm[0],[...npm[1],'install',`qq-native-client@${version}`,'--registry',origin,'--cache',join(temp,'npm-cache'),'--ignore-scripts','--no-audit','--no-fund'],{cwd:temp,maxBuffer:1024*1024,timeout:120000});console.log(stdout);
 const foreign=tarballRequests.filter(name=>name.startsWith('qq-native-client-')&&name!==platformName);if(foreign.length||!tarballRequests.includes(platformName))throw new Error('npm did not install exactly the matching native auxiliary package');
 for(const device of deviceNames){if(`qq-native-client-${device}`!==platformName){try{await readFile(join(temp,'node_modules',`qq-native-client-${device}`,'package.json'));throw new Error('Foreign auxiliary package installed');}catch(error){if(error.code!=='ENOENT')throw error;}}}
 const sdk=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/index.js')).href);
 const forwardChecks=await verifyForwardConsumer(join(temp,'node_modules/qq-native-client'));
 const recallChecks=await verifyRecallConsumer(join(temp,'node_modules/qq-native-client'));
 const cli=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/cli.js')).href);
 const elements=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/message-elements.js')).href);
 const mixed=[{type:'text',text:'fixture'},{type:'face',id:14},{type:'face',id:428}];
 assert.deepEqual(cli.normalizeMessage(mixed),mixed);
 assert.deepEqual(elements.faceElement(428),{elementType:6,elementId:'',faceElement:{faceIndex:428,faceType:2,faceText:'/收到',sourceType:1,stickerType:0,packId:'0',stickerId:'0'}});
 assert.throws(()=>cli.normalizeMessage([{type:'face',id:99999}]),/Unsupported QQ face/);
 await writeFile(join(temp,'faces.json'),JSON.stringify(mixed));
 const faceAction=await cli.prepareCommand('send',{kind:'group',target:'123','message-file':join(temp,'faces.json')});
 let faceArgs;await faceAction({sendGroupMessage:async(...args)=>{faceArgs=args;}});assert.deepEqual(faceArgs,['123',mixed]);
 const query=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/message-query.js')).href);
 const queryId='900719925474099312345',queryPeer={chatType:1,peerUid:'u_fixture'};
 assert.equal(typeof sdk.QQClient.prototype.getMessage,'function');
 assert.equal(await query.queryNativeMessage({getMsgsByMsgId:(peer,ids)=>{assert.deepEqual(peer,queryPeer);assert.deepEqual(ids,[queryId]);return{result:0,msgList:[]};}},queryPeer,queryId),undefined);
 await assert.rejects(query.queryNativeMessage({getMsgsByMsgId:()=>({result:23,msgList:[]})},queryPeer,queryId),{code:23});
 const queryAction=await cli.prepareCommand('message',{kind:'private',target:'456','message-id':queryId});
 let queryArgs;assert.equal(await queryAction({getMessage:async(...args)=>{queryArgs=args;}}),null);assert.deepEqual(queryArgs,[{type:'private',userId:'456'},queryId]);
 { // Installed compiled history query contract; synthetic native service only.
 const {createNativeServices}=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/native-services.js')).href);
 const {prepareCommand}=cli;const {queryNativeMessage}=query;
const peer={chatType:2,peerUid:'123'},id='900719925474099312345';
const raw={msgId:id,msgSeq:'9',msgTime:'100',chatType:2,peerUid:'123',peerUin:'123',senderUin:'456',senderUid:'u_friend',sendNickName:'fixture',elements:[{elementType:1,textElement:{content:'fixture',atType:0}}]};
function fixture(response){let calls=0;const services=createNativeServices({getMsgService:()=>({addKernelMsgListener(){},getMsgsIncludeSelf(...args){calls++;assert.deepEqual(args,[peer,'42',2,false]);return response;}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){}})},'7.0.2-53644',()=>{});return{services,calls:()=>calls};}
const payload={peer:{type:'group',groupId:'123'},options:{before:'42',limit:2}};
for(const [result,code] of [[-1,-1],[73,73],['denied','denied'],[undefined,'invalid-result'],[NaN,'invalid-result']])for(const msgList of [[],[raw]]){
 const{services,calls}=fixture({result,msgList,errMsg:'must-not-leak'});try{await assert.rejects(services.invokeOperation('getHistory',payload),error=>{assert.equal(error.code,code);assert.ok(!error.message.includes('must-not-leak'));return true;});assert.equal(calls(),1);}finally{services.close();}
}
for(const msgList of [Array(1),[{...raw,chatType:1}],[{...raw,chatType:99}],[{...raw,peerUid:'999'}],[{...raw,msgId:123}],[{...raw,elements:Array(1)}]]){
 const{services,calls}=fixture({result:0,msgList});try{await assert.rejects(services.invokeOperation('getHistory',payload),/invalid|mismatched/i);assert.equal(calls(),1);}finally{services.close();}
}
for(const msgList of [[],[{...raw,msgId:'3'},raw]]){
 const{services,calls}=fixture({result:0,msgList});try{const action=await prepareCommand('history',{kind:'group',target:'123',before:'42',limit:'2'});const records=await action({getHistory:(p,options)=>services.invokeOperation('getHistory',{peer:p,options})});assert.deepEqual(records.map(r=>r.messageId),msgList.map(r=>r.msgId));for(const record of records)assert.deepEqual(record.elements,[{type:'text',text:'fixture'}]);assert.equal(calls(),1);}finally{services.close();}
}
await assert.rejects(queryNativeMessage({getMsgsByMsgId:()=>({result:0,msgList:[{...raw,elements:Array(1)}]})},peer,id),/elements/i);
let finish,begin,calls=0;const began=new Promise(resolve=>{begin=resolve;});const delayed=new Promise(resolve=>{finish=resolve;});
const closing=createNativeServices({getMsgService:()=>({addKernelMsgListener(){},getMsgsIncludeSelf(){calls++;begin();return delayed;}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){}})},'7.0.2-53644',()=>{});
const pending=closing.invokeOperation('getHistory',payload);await began;closing.close();finish({result:0,msgList:[]});await assert.rejects(pending,/abort|closed/i);assert.equal(calls,1);
 }
 // Installed compiled code with a fake profile service: this checks field preservation,
 // not a QQ-native profile mutation. Native preparation below remains a separate check.
 const profile=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/self-profile.js')).href);
 assert.equal(typeof sdk.QQClient.prototype.setSignature,'function');
 for(const text of ['','  spaced signature  ']){
  const action=await cli.prepareCommand('signature',{text});let actual;
  await action({setSignature:async value=>{actual=value;}});assert.equal(actual,text);
 }
 const birthday={birthday_year:'2000',birthday_month:'1',birthday_day:'2'};
 function profileFixture(missingNick=false){
  let listener;const writes=[];
  const service={
   addKernelProfileListener(value){listener=value;return 1;},removeKernelProfileListener(){},
   fetchUserDetailInfo(trace,uids,source,biz){
    assert.equal(trace,'BuddyProfileStore');assert.deepEqual(uids,['self']);assert.equal(source,1);assert.deepEqual(biz,[0]);
    listener.onUserDetailInfoChanged({uid:'self',simpleInfo:{coreInfo:missingNick?{}:{nick:'original nickname'},baseInfo:{longNick:'original signature',sex:255,birthday_year:2000,birthday_month:1,birthday_day:2}}});return{result:0};
   },
   modifyDesktopMiniProfile(value){writes.push(value);return{result:0};}
  };
  return{module:profile.createSelfProfile({getProfileService:()=>service},()=> 'self'),writes};
 }
 const nickname=profileFixture();
 try{await nickname.module.invokeOperation('setNickname',{name:'new nickname'});assert.deepEqual(nickname.writes,[{nick:'new nickname',longNick:'original signature',sex:255,birthday,location:undefined}]);}finally{nickname.module.close();}
 for(const text of ['new signature','']){
  const fixture=profileFixture();
  try{await fixture.module.invokeOperation('setSignature',{text});assert.deepEqual(fixture.writes,[{nick:'original nickname',longNick:text,sex:255,birthday,location:undefined}]);}finally{fixture.module.close();}
 }
 const missing=profileFixture(true);
 try{await assert.rejects(missing.module.invokeOperation('setSignature',{text:'new'}),/nickname|preserv|profile/i);assert.equal(missing.writes.length,0);}finally{missing.module.close();}
 // Installed compiled contract only: synthetic services, no QQ group mutation.
 const {createGroupOperations}=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/group-operations.js')).href);
 const voidCases=[
  ['setGroupMemberCard','modifyMemberCardName',{groupId:'123',userId:'456',card:''},['123','u_fixture','']],
  ['setGroupAdmin','modifyMemberRole',{groupId:'123',userId:'456',enabled:true},['123','u_fixture',3]],
  ['kickGroupMember','kickMember',{groupId:'123',userId:'456',options:{rejectRejoin:true,reason:'fixture'}},['123',['u_fixture'],true,'fixture']],
  ['leaveGroup','quitGroup',{groupId:'123'},['123']],
 ];
 for(const [method,native,payload,expected] of voidCases){
  let calls=0;
  const invoke=(...args)=>{calls++;assert.deepEqual(args,expected);return undefined;};
  const operation=createGroupOperations({getGroupService:()=>({[native]:native==='kickMember'?async(...args)=>invoke(...args):invoke})},async()=> 'u_fixture');
  await operation.invokeOperation(method,payload);assert.equal(calls,1);
  for(const [result,code] of [['0','invalid-result'],[0,'invalid-result'],[{result:23},23],[{result:'23'},'23'],[{result:NaN},'invalid-result'],[{result:Infinity},'invalid-result']]){
   let failures=0;
   const rejected=createGroupOperations({getGroupService:()=>({[native]:()=>{failures++;return result;}})},async()=> 'u_fixture');
   await assert.rejects(rejected.invokeOperation(method,payload),{code});assert.equal(failures,1);
  }
 }
 for(const [method,native,payload] of [
  ['setGroupName','modifyGroupName',{groupId:'123',name:'fixture'}],
  ['setGroupMute','setGroupShutUp',{groupId:'123',enabled:true}],
  ['setGroupMemberMute','setMemberShutUp',{groupId:'123',userId:'456',seconds:0}],
 ]){
  let calls=0;
  const operation=createGroupOperations({getGroupService:()=>({[native]:()=>{calls++;return undefined;}})},async()=> 'u_fixture');
  await assert.rejects(operation.invokeOperation(method,payload),/Native group/);assert.equal(calls,1);
 }
 // Query contract uses only synthetic listener services, never native QQ calls.
 const {createNativeServices:queryServices}=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/native-services.js')).href);
 for(const [response,expectedCode] of [
  [{errCode:0,result:{finish:true,infos:new Map()}},undefined],
  [{errCode:23,result:{finish:true,infos:new Map()}},23],
  [{errCode:'23',result:{finish:true,infos:new Map()}},'23'],
  [{errCode:0,result:{finish:false,infos:new Map()}},'incomplete-result'],
 ]){
  let calls=0;
  const query=queryServices({
   getMsgService:()=>({addKernelMsgListener(){}}),
   getBuddyService:()=>({addKernelBuddyListener(){}}),
   getGroupService:()=>({addKernelGroupListener(){},getAllMemberList(group,refresh){calls++;assert.equal(group,'123');assert.equal(refresh,false);return response;}}),
  },'7.0.2-53644',()=>{});
  try{
   if(expectedCode===undefined)assert.deepEqual(await query.invokeOperation('getGroupMembers',{groupId:'123'}),[]);
   else await assert.rejects(query.invokeOperation('getGroupMembers',{groupId:'123'}),{code:expectedCode});
   assert.equal(calls,1);
  }finally{query.close();}
 }
 {
 const createNativeServices=queryServices;
// Complete member identity/DTO validation and failure-cache isolation.
const valid={uid:'u_member',uin:'900719925474099312345',nick:'member',cardName:'',role:2};
function membersFixture(infos){return createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){},getAllMemberList(){return{errCode:0,result:{finish:true,infos}};}})},'7.0.2-53644',()=>{});}
for(const [key,member] of [['u_member',{...valid,uin:456}],['u_member',{...valid,uin:{toString(){throw Error('Coercion must not run');}}}],['u_member',{...valid,uid:'u_other'}],['',{...valid,uid:''}],['u_member',{...valid,nick:{secret:true}}],['u_member',{...valid,cardName:12}],['u_member',{...valid,uid:undefined}],['u_member',{...valid,nick:undefined}],['u_member',{...valid,cardName:undefined}],['u_member',{...valid,role:'2'}],['u_member',{...valid,role:0}],['u_member',{...valid,role:1}]]){
 const query=membersFixture(new Map([[key,member]]));try{await assert.rejects(query.invokeOperation('getGroupMembers',{groupId:'123'}),/native group member/);}finally{query.close();}
}
const roles=membersFixture(new Map([['u_member',valid],['u_admin',{...valid,uid:'u_admin',uin:'456',role:3}],['u_owner',{...valid,uid:'u_owner',uin:'789',role:4}]]));
try{assert.deepEqual(await roles.invokeOperation('getGroupMembers',{groupId:'123'}),[{userId:valid.uin,uid:'u_member',nickname:'member',card:'',role:'member'},{userId:'456',uid:'u_admin',nickname:'member',card:'',role:'admin'},{userId:'789',uid:'u_owner',nickname:'member',card:'',role:'owner'}]);}finally{roles.close();}
let conversions=0;
const atomic=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){},getAllMemberList(){return{errCode:0,result:{finish:true,infos:new Map([['u_first',{...valid,uid:'u_first',uin:'456'}],['u_bad',{...valid,uid:'u_bad',role:999}]])}};}}),getUixConvertService:()=>({getUid(ids){assert.deepEqual(ids,['456']);conversions++;return{uidInfo:new Map()};}})},'7.0.2-53644',()=>{});
try{await assert.rejects(atomic.invokeOperation('getGroupMembers',{groupId:'123'}),/Unknown native group member role/);await assert.rejects(atomic.invokeOperation('sendPrivateMessage',{userId:'456',message:'fixture'}),/Could not resolve user identifier/);assert.equal(conversions,1);}finally{atomic.close();}
 }
 // Installed metadata callbacks are normalized using fake events only.
 const {createGroupEvents}=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/group-events.js')).href);
 const groupEvents=[];const groupListener=createGroupEvents((event,payload)=>groupEvents.push([event,payload]));
 groupListener.onGroupListUpdate(3,[{groupCode:'123'}]);
 assert.deepEqual(groupEvents.pop(),['group-list-updated',{kind:'removed',groups:[{groupId:'123'}]}]);
 groupListener.onMemberInfoChange('123',1,new Map([['u_fixture',{uid:'u_fixture',uin:'456',role:3,isChangeRole:true}]]));
 assert.deepEqual(groupEvents.pop(),['group-members-updated',{groupId:'123',source:'remote',members:[{uid:'u_fixture',userId:'456',role:'admin',roleChanged:true}]}]);
 groupListener.onGroupListUpdate(2,[{groupCode:'123',groupName:'private fixture'},{groupCode:'invalid'}]);
 groupListener.onGroupListUpdate(2,Array(1));
 groupListener.onMemberInfoChange('123',0,new Map([['u_valid',{nick:'private fixture'}],['u_invalid',{role:999}]]));
 assert.deepEqual(groupEvents,[['diagnostic',{stage:'invalid-native-group-list-update'}],['diagnostic',{stage:'invalid-native-group-list-update'}],['diagnostic',{stage:'invalid-native-group-member-update'}]]);
 assert.ok(!JSON.stringify(groupEvents).includes('private fixture'));
 const {observeWatchEvents}=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/cli.js')).href);
 const {EventEmitter}=await import('node:events');const fakeWatch=new EventEmitter();const watchLines=[];
 const unwatch=observeWatchEvents(fakeWatch,'all',line=>watchLines.push(JSON.parse(line)));
 fakeWatch.emit('group-list-updated',{kind:'removed',groups:[{groupId:'123'}]});
 fakeWatch.emit('group-members-updated',{groupId:'123',source:'remote',members:[]});
 fakeWatch.emit('msf-status',{fixture:true});fakeWatch.emit('authenticated',{fixture:true});
 assert.deepEqual(watchLines,[{event:'group-list-updated',payload:{kind:'removed',groups:[{groupId:'123'}]}},{event:'group-members-updated',payload:{groupId:'123',source:'remote',members:[]}}]);
 unwatch();fakeWatch.emit('group-list-updated',{kind:'all',groups:[]});assert.equal(watchLines.length,2);
 { // Synthetic installed friend metadata and CLI contract.
const {EventEmitter:FriendEmitter}=await import('node:events');
const {createFriendEvents}=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/friend-events.js')).href);
const {observeWatchEvents:watchFriends}=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/cli.js')).href);
const events=[];const listener=createFriendEvents((event,payload)=>events.push([event,payload]));
const expected={categories:[{categoryId:1,name:'fixture',memberCount:1,friends:[{uid:'u_friend',userId:'900719925474099312345',nickname:'friend',remark:'remark'}]}]};
listener.onBuddyListChange([{categoryId:1,categoryName:'fixture',categoryMbCount:1,buddyList:[{uid:'u_friend',uin:'900719925474099312345',nick:'friend',remark:'remark',secret:'must-not-leak'}],secret:'must-not-leak'}]);
assert.deepEqual(events.pop(),['friend-list-updated',expected]);
listener.onBuddyListChange([{categoryId:2,categoryName:'empty',categoryMbCount:0,buddyList:[]}]);
assert.deepEqual(events.pop(),['friend-list-updated',{categories:[{categoryId:2,name:'empty',memberCount:0,friends:[]}]}]);
listener.onBuddyListChange([{categoryId:1,categoryName:'private',categoryMbCount:0,buddyList:[]},{categoryId:'bad',categoryName:'bad',categoryMbCount:0,buddyList:[]}]);
assert.deepEqual(events,[['diagnostic',{stage:'invalid-native-friend-list-update'}]]);assert.ok(!JSON.stringify(events).includes('private'));
const client=new FriendEmitter(),lines=[];const cleanup=watchFriends(client,'all',line=>lines.push(JSON.parse(line)));
client.emit('friend-list-updated',expected);assert.deepEqual(lines,[{event:'friend-list-updated',payload:expected}]);cleanup();client.emit('friend-list-updated',expected);assert.equal(lines.length,1);
const plain=[];const cleanDefault=watchFriends(client,undefined,line=>plain.push(JSON.parse(line)));client.emit('friend-list-updated',expected);client.emit('message',{fixture:true});assert.deepEqual(plain,[{fixture:true}]);cleanDefault();
 }
 { // Synthetic installed friend-list query result contract.
const {createNativeServices}=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/native-services.js')).href);
for(const [result,code] of [[-1,-1],[73,73],['denied','denied'],[undefined,'invalid-result'],[NaN,'invalid-result']])for(const data of [[],[{buddyUids:['u_fixture']}]] ){
 let buddyCalls=0,profileCalls=0;
 const query=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){},getBuddyListV2(){buddyCalls++;return{result,data};}}),getProfileService:()=>({getCoreAndBaseInfo(){profileCalls++;throw Error('Unexpected profile query');}})},'7.0.2-53644',()=>{});
 try{await assert.rejects(query.invokeOperation('listFriends'),{code});assert.equal(buddyCalls,1);assert.equal(profileCalls,0);}finally{query.close();}
}
// Sparse native arrays must not become a valid empty list.
for(const data of [Array(1),[{buddyUids:Array(1)}]]){
 let profileCalls=0;
 const query=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){},getBuddyListV2(){return{result:0,data};}}),getProfileService:()=>({getCoreAndBaseInfo(){profileCalls++;return new Map();}})},'7.0.2-53644',()=>{});
 try{await assert.rejects(query.invokeOperation('listFriends'),/Invalid native buddy/);assert.equal(profileCalls,0);}finally{query.close();}
}
// A failed row must leave no usable UID cache entry from preceding rows.
let conversions=0;
const atomic=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){},getBuddyListV2(){return{result:0,data:[{buddyUids:['u_partial','u_bad']}]};}}),getProfileService:()=>({getCoreAndBaseInfo(){return new Map([['u_partial',{coreInfo:{uid:'u_partial',uin:'456',nick:'fixture',remark:''}}],['u_bad',{}]]);}}),getUixConvertService:()=>({getUid(ids){assert.deepEqual(ids,['456']);conversions++;return{uidInfo:new Map()};}})},'7.0.2-53644',()=>{});
try{await assert.rejects(atomic.invokeOperation('listFriends'),/Invalid native buddy profile/);await assert.rejects(atomic.invokeOperation('sendPrivateMessage',{userId:'456',message:'fixture'}),/Could not resolve user identifier/);assert.equal(conversions,1);}finally{atomic.close();}
// Preserve deduplication, category order and lossless long decimal IDs.
const complete=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){},getBuddyListV2(){return{result:0,data:[{buddyUids:['u_first','u_second']},{buddyUids:['u_first']}]};}}),getProfileService:()=>({getCoreAndBaseInfo(store,uids){assert.deepEqual([store,uids],['nodeStore',['u_first','u_second']]);return new Map([['u_first',{coreInfo:{uid:'u_first',uin:'900719925474099312345',nick:'first',remark:''}}],['u_second',{coreInfo:{uid:'u_second',uin:'456',nick:'second',remark:'remark'}}]]);}})},'7.0.2-53644',()=>{});
try{assert.deepEqual(await complete.invokeOperation('listFriends'),[{userId:'900719925474099312345',uid:'u_first',nickname:'first',remark:''},{userId:'456',uid:'u_second',nickname:'second',remark:'remark'}]);}finally{complete.close();}
// Friend profile identity/display fields must already have their declared types.
const validCore={uid:'u_friend',uin:'900719925474099312345',nick:'friend',remark:''};
for(const change of [{uin:456},{uin:{toString(){throw Error('Coercion must not run');}}},{nick:{}},{nick:null},{remark:12},{uid:'u_other'},{uid:undefined},{remark:undefined}]){
 const query=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){},getBuddyListV2(){return{result:0,data:[{buddyUids:['u_friend']}]};}}),getProfileService:()=>({getCoreAndBaseInfo(){return new Map([['u_friend',{coreInfo:{...validCore,...change}}]]);}})},'7.0.2-53644',()=>{});
 try{await assert.rejects(query.invokeOperation('listFriends'),/Invalid native buddy profile/);}finally{query.close();}
}
const omittedNick=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){},getBuddyListV2(){return{result:0,data:[{buddyUids:['u_friend']}]};}}),getProfileService:()=>({getCoreAndBaseInfo(){return new Map([['u_friend',{coreInfo:{...validCore,nick:undefined}}]]);}})},'7.0.2-53644',()=>{});
try{assert.deepEqual(await omittedNick.invokeOperation('listFriends'),[{userId:validCore.uin,uid:'u_friend',nickname:'',remark:''}]);}finally{omittedNick.close();}
// Full group callbacks reject malformed batches and retire their uncorrelated query.
const group={groupCode:'900719925474099312345',groupName:'group',memberCount:2,maxMember:100};
function groupFixture(groups){const listeners=[];let calls=0;const query=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(value){listeners.push(value);},getGroupList(){calls++;for(const listener of listeners)listener.onGroupListUpdate?.(1,groups);return{result:0};}})},'7.0.2-53644',()=>{});return{query,calls:()=>calls};}
for(const groups of [Array(1),[{...group,groupCode:undefined}],[{...group,groupCode:123}],[{...group,groupName:{secret:true}}],[{...group,memberCount:-1}],[{...group,memberCount:1.5}],[{...group,memberCount:Number.MAX_SAFE_INTEGER+1}],[{...group,maxMember:'100'}],[{...group,maxMember:Infinity}]]){
 const{query,calls}=groupFixture(groups);try{await assert.rejects(query.invokeOperation('listGroups'),/Invalid native group list/);await assert.rejects(query.invokeOperation('listGroups'),/channel invalidated/);assert.equal(calls(),1);}finally{query.close();}
}
for(const groups of [[],[group]]){const{query,calls}=groupFixture(groups);try{assert.deepEqual(await query.invokeOperation('listGroups'),groups.map(g=>({groupId:g.groupCode,name:g.groupName,memberCount:g.memberCount,maxMemberCount:g.maxMember})));assert.equal(calls(),1);}finally{query.close();}}
let successCalls=0;const success=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){},getBuddyListV2(){successCalls++;return{result:0,data:[]};}}),getProfileService:()=>({getCoreAndBaseInfo(){return new Map();}})},'7.0.2-53644',()=>{});
try{assert.deepEqual(await success.invokeOperation('listFriends'),[]);assert.equal(successCalls,1);}finally{success.close();}
 }
 globalThis.fetch=()=>{throw new Error('Unexpected mirror request with installed platform package');};
 client=await sdk.createClient({dataDir:join(temp,'unused-account'),autoReconnect:false,timeoutMs:30000});
 const exports=client.nativeExports.length;if(exports<80)throw new Error('Unexpected native export inventory');await client.close();if(client.state!=='closed')throw new Error('Client did not close');
 await writeFile('out/consumer.json',JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,exports,...forwardChecks,...recallChecks,installedMainOnly:true,automaticPlatformSelection:true,tarballRequests,faceContract:true,faceDeliveryAttempted:false,messageQueryContract:true,historyQueryContract:true,nativeHistoryQueryAttempted:false,nativeMessageQueryAttempted:false,selfProfileContract:true,profileMutationAttempted:false,groupOperationContract:true,groupMutationAttempted:false,groupMemberQueryContract:true,groupMemberIdentityContract:true,nativeGroupMemberQueryAttempted:false,groupMetadataEventContract:true,businessWatchContract:true,nativeGroupMetadataObserved:false,friendMetadataEventContract:true,nativeFriendMetadataObserved:false,friendListQueryContract:true,friendListBatchContract:true,friendProfileQueryContract:true,groupListQueryContract:true,nativeGroupListQueryAttempted:false,nativeFriendListQueryAttempted:false,prepared:true,closed:true,loginAttempted:false,registry:'isolated local fixture serving actual CI tarballs'},null,2));console.log(await readFile('out/consumer.json','utf8'));
}finally{await client?.close();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(temp,{recursive:true,force:true});}
