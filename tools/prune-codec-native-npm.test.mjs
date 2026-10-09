import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {validateProfile,validateConsumerReceipts} from './prune-codec-native-npm.mjs';
const profile=JSON.parse(await readFile(new URL('./profiles/darwin-arm64-resources-codec-v2.json',import.meta.url)));
const copy=()=>structuredClone(profile);
test('codec inventory and fixed source reject duplicate, escape, missing codec and old source',()=>{
 assert.equal(validateProfile(copy()).files.length,58);
 for(const mutate of [p=>p.source.runId='37925080425',p=>p.files[0].path='../wrapper.node',p=>p.files[0]=p.files[1],p=>p.files=p.files.filter(f=>f.path!=='video/video-codec.node'),p=>p.videoCodec=undefined,p=>p.source.schemaVersion=1]){const p=copy();mutate(p);assert.throws(()=>validateProfile(p));}
});
test('acceptance requires automatic actual codec, same builder, no account and exact packages',()=>{
 const build={schemaVersion:1,experimental:true,profile:profile.id,nativePaths:58,packagedPaths:61,accountAcceptanceEstablished:false,signingAuthenticityEstablished:false,published:false,defaultsChanged:false,builderCommit:'fixture',builderRunId:'1',source:profile.source};
 const receipt={platform:'darwin',arch:'arm64',exports:104,installedMainOnly:true,automaticPlatformSelection:true,prepared:true,closed:true,loginAttempted:false,nativeHistoryQueryAttempted:false,nativeFriendListQueryAttempted:false,nativeGroupListQueryAttempted:false,nativeGroupMemberQueryAttempted:false,automaticVideoCodec:true,installedVideoDecoder:true,installedVideoFakeCache:true,nativeVideoSendAttempted:false,node:'v24.20.0',tarballRequests:['qq-native-client','qq-native-client-darwin-arm64','silk-wasm']};
 const env={GITHUB_SHA:'fixture',GITHUB_RUN_ID:'1'};validateConsumerReceipts(profile,build,receipt,env);
 for(const changes of [{automaticVideoCodec:false},{installedVideoDecoder:false},{loginAttempted:true},{closed:false},{tarballRequests:['qq-native-client','silk-wasm']}])assert.throws(()=>validateConsumerReceipts(profile,build,{...receipt,...changes},env));
 assert.throws(()=>validateConsumerReceipts(profile,{...build,nativePaths:47},receipt,env));
 assert.throws(()=>validateConsumerReceipts(profile,build,receipt,{...env,GITHUB_RUN_ID:'2'}));
});
