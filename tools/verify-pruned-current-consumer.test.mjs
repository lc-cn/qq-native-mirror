import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateCurrentPrunedReceipts} from './verify-pruned-current-consumer.mjs';
const profile=JSON.parse(await readFile(new URL('./profiles/darwin-x64-resources-codec-v2.json',import.meta.url)));
function fixture(){
 const binding={sdkCommit:'5907793ad848c68b3183ac5c2f2b06fbd1a5e0cf',sdkRun:'38000680198',nativeCommit:profile.source.commit,nativeRun:profile.source.runId,mainSha256:'owned-main-digest',auxiliarySha256:'owned-aux-digest'};
 const video={passed:true,noAccount:true,noQQ:true,nativeSendAttempted:false,platform:'darwin',arch:'x64',node:'v24.20.0',binary:profile.files.find(f=>f.path==='video/video-codec.node'),inputs:['ced7b4e1cd47d948ecf407116095282e5b5ca4df76142b7a06826eecb92cb932','1c8920f2db13e3c1b28b708bc94d3889ed8bd10f15ee5d89881d99715188b468','53a0baad6f0853d39e53263c22c847bd78435fc263e6844450878b471d13cc57'].map(sha256=>({sha256}))};
 video.binary={sha256:video.binary.sha256,bytes:video.binary.size};
 const consumer={platform:'darwin',arch:'x64',node:'v24.20.0',exports:104,prepared:true,closed:true,installedMainOnly:true,automaticPlatformSelection:true,accountUsed:false,loginAttempted:false,installedNativeStorage:{format:'plain-installed',nativePaths:58,allInstalledFilesVerified:true,installedPathsReused:true,networkFallbackAttempted:false},tarballRequests:['qq-native-client','qq-native-client-darwin-x64','silk-wasm'],installedVideo:video};
 for(const key of ['nativeSessionStrategyLoginAttempted','nativeHistoryQueryAttempted','nativeMessageQueryAttempted','nativeFriendListQueryAttempted','nativeGroupListQueryAttempted','nativeGroupMemberQueryAttempted','nativeSendAttempted','nativeRecallObserved','nativeVideoSendAttempted','nativeAttachmentDownloadAttempted','nativeMergedForwardAttempted'])consumer[key]=false;
 for(const key of ['sessionStrategyContract','attachmentDownloadContract','forwardResourceTypedElementsContract','forwardResourceDeclarationsContract','historyInputCaptureContract','pendingReadCloseContract','reentrantReadCloseContract','installedCliEntrypointContract'])consumer[key]=true;
 const distinct=new Map(profile.files.map(f=>[f.sha256,f]));
 const mirror={platform:'darwin',arch:'x64',node:'v24.20.0',mainSha256:binding.mainSha256,auxiliarySha256:binding.auxiliarySha256,nativeFiles:58,distinctNativeContents:distinct.size,allCachedFilesHashVerified:true,allWarmFileMtimesUnchanged:true,warmCacheReused:true,requests:{cold:{metadata:1,payload:distinct.size,payloadBytes:[...distinct.values()].reduce((n,f)=>n+f.size,0)},warm:{metadata:1,payload:0,payloadBytes:0}},localMirrorFixture:true,externalFetchAttempted:false,installedAuxiliaryUsed:false,nativeWrapperLoaded:false,accountUsed:false,loginAttempted:false,nativeSendAttempted:false,published:false,defaultsChanged:false,signingAuthenticityEstablished:false,audio:{realWasmEncodeDecode:true,decodedSeconds:0.2}};
 return {binding,consumer,video,mirror};
}
const run=f=>validateCurrentPrunedReceipts(f.binding,profile,f.consumer,f.video,f.mirror);
test('owned receipt fixture passes; this test executes no addons',()=>run(fixture()));
test('rejects SDK/native provenance confusion',()=>{const f=fixture();f.binding.sdkCommit=profile.source.commit;assert.throws(()=>run(f),/sources/);});
test('rejects a real Session login disguised as synthetic contract',()=>{const f=fixture();f.consumer.nativeSessionStrategyLoginAttempted=true;assert.throws(()=>run(f),/account operation/);});
test('rejects file path count substituted for unique mirror content count',()=>{const f=fixture();f.mirror.requests.cold.payload=58;assert.throws(()=>run(f));});
test('rejects warm redownload and missing actual codec proof',()=>{const f=fixture();f.mirror.requests.warm.payload=1;assert.throws(()=>run(f));const g=fixture();g.video.passed=false;assert.throws(()=>run(g),/video/);});
