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
 globalThis.fetch=()=>{throw new Error('Unexpected mirror request with installed platform package');};
 client=await sdk.createClient({dataDir:join(temp,'unused-account'),autoReconnect:false,timeoutMs:30000});
 const exports=client.nativeExports.length;if(exports<80)throw new Error('Unexpected native export inventory');await client.close();if(client.state!=='closed')throw new Error('Client did not close');
 await writeFile('out/consumer.json',JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,exports,installedMainOnly:true,automaticPlatformSelection:true,tarballRequests,faceContract:true,faceDeliveryAttempted:false,messageQueryContract:true,nativeMessageQueryAttempted:false,selfProfileContract:true,profileMutationAttempted:false,prepared:true,closed:true,loginAttempted:false,registry:'isolated local fixture serving actual CI tarballs'},null,2));console.log(await readFile('out/consumer.json','utf8'));
}finally{await client?.close();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(temp,{recursive:true,force:true});}
