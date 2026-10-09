import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {validateProfile} from './prune-codec-native-npm.mjs';
import {readNativeTarFiles} from '../sdk/scripts/native-tar-files.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(ok,message)=>{if(!ok)throw Error(message);};
export function validateCurrentPrunedReceipts(binding,profile,consumer,video,mirror){
 check(binding.sdkCommit==='5907793ad848c68b3183ac5c2f2b06fbd1a5e0cf'&&binding.sdkRun==='38000680198'&&binding.nativeCommit===profile.source.commit&&binding.nativeRun===profile.source.runId,'SDK/native sources changed');
 check(consumer.platform==='darwin'&&consumer.arch===profile.arch&&consumer.node==='v24.20.0'&&consumer.exports===104&&consumer.prepared===true&&consumer.closed===true,'Installed runtime failed');
 check(consumer.installedMainOnly===true&&consumer.automaticPlatformSelection===true&&consumer.accountUsed===false&&consumer.loginAttempted===false,'Account or platform scope changed');
 for(const flag of ['nativeSessionStrategyLoginAttempted','nativeHistoryQueryAttempted','nativeMessageQueryAttempted','nativeFriendListQueryAttempted','nativeGroupListQueryAttempted','nativeGroupMemberQueryAttempted','nativeSendAttempted','nativeRecallObserved','nativeVideoSendAttempted','nativeAttachmentDownloadAttempted','nativeMergedForwardAttempted'])check(consumer[flag]===false,'Unexpected native account operation');
 for(const flag of ['sessionStrategyContract','attachmentDownloadContract','forwardResourceTypedElementsContract','forwardResourceDeclarationsContract','historyInputCaptureContract','pendingReadCloseContract','reentrantReadCloseContract','installedCliEntrypointContract'])check(consumer[flag]===true,'Current installed contract missing');
 assert.deepEqual(consumer.installedNativeStorage,{format:'plain-installed',nativePaths:58,allInstalledFilesVerified:true,installedPathsReused:true,networkFallbackAttempted:false});
 assert.deepEqual(consumer.tarballRequests.slice().sort(),['qq-native-client',`qq-native-client-darwin-${profile.arch}`,'silk-wasm'].sort());
 assert.deepEqual(consumer.installedVideo,video);
 const codec=profile.files.find(f=>f.path==='video/video-codec.node');
 check(video.passed===true&&video.noAccount===true&&video.noQQ===true&&video.nativeSendAttempted===false&&video.platform==='darwin'&&video.arch===profile.arch&&video.node===consumer.node&&video.binary.sha256===codec.sha256&&video.binary.bytes===codec.size,'Real installed video failed');
 assert.deepEqual(video.inputs.map(i=>i.sha256).sort(),['ced7b4e1cd47d948ecf407116095282e5b5ca4df76142b7a06826eecb92cb932','1c8920f2db13e3c1b28b708bc94d3889ed8bd10f15ee5d89881d99715188b468','53a0baad6f0853d39e53263c22c847bd78435fc263e6844450878b471d13cc57'].sort());
 check(mirror.platform==='darwin'&&mirror.arch===profile.arch&&mirror.node===consumer.node,'Mirror runtime changed');
 check(mirror.mainSha256===binding.mainSha256&&mirror.auxiliarySha256===binding.auxiliarySha256,'Mirror package binding changed');
 const groups=new Map(profile.files.map(f=>[f.sha256,f]));
 check(mirror.nativeFiles===58&&mirror.distinctNativeContents===groups.size&&mirror.allCachedFilesHashVerified===true&&mirror.allWarmFileMtimesUnchanged===true&&mirror.warmCacheReused===true,'Mirror cache verification missing');
 assert.deepEqual(mirror.requests,{cold:{metadata:1,payload:groups.size,payloadBytes:[...groups.values()].reduce((n,f)=>n+f.size,0)},warm:{metadata:1,payload:0,payloadBytes:0}});
 check(mirror.localMirrorFixture===true&&mirror.externalFetchAttempted===false&&mirror.installedAuxiliaryUsed===false&&mirror.nativeWrapperLoaded===false,'Mirror scope changed');
 check(mirror.accountUsed===false&&mirror.loginAttempted===false&&mirror.nativeSendAttempted===false&&mirror.published===false&&mirror.defaultsChanged===false&&mirror.signingAuthenticityEstablished===false,'Mirror acceptance scope changed');
 check(mirror.audio.realWasmEncodeDecode===true&&mirror.audio.decodedSeconds===0.2,'Actual audio conversion missing');
}
export async function verifyCurrentPrunedConsumer(directory='out'){
 const bindingBytes=await readFile(join(directory,'input-binding.json')),binding=JSON.parse(bindingBytes);
 const profileBytes=await readFile(join(directory,'pruning-profile.json')),profile=validateProfile(JSON.parse(profileBytes));
 assert.deepEqual(profileBytes,await readFile(`tools/profiles/darwin-${profile.arch}-resources-codec-v2.json`));
 check(sha(await readFile(join(directory,'source-release-manifest.json')))===profile.source.releaseManifestSha256,'Native release changed');
 const main=await readFile(join(directory,'qq-native-client-0.0.2.tgz')),auxName=`qq-native-client-darwin-${profile.arch}-0.0.2.tgz`,aux=await readFile(join(directory,auxName));
 check(sha(main)===binding.mainSha256&&sha(aux)===binding.auxiliarySha256,'Actual input tarball changed');
 const sdk=JSON.parse(await readFile(join(directory,'consumer-sdk.json')));
 check(sdk.builderCommit===binding.sdkCommit&&sdk.builderRunId===binding.sdkRun&&sdk.sha256===binding.mainSha256&&sdk.size===main.length,'Actual SDK provenance changed');
 const build=JSON.parse(await readFile(join(directory,'pruning-build.json')));
 check(build.tarballSha256===binding.auxiliarySha256&&build.size===aux.length&&build.profileSha256===sha(profileBytes),'Pruned source provenance changed');
 assert.deepEqual(build.source,profile.source);
 const files=await readNativeTarFiles(join(directory,auxName));
 assert.deepEqual([...files.keys()].sort(),[...profile.files.map(f=>'package/'+f.path),'package/manifest.json','package/package.json','package/README.md'].sort());
 const manifest=JSON.parse(files.get('package/manifest.json'));
 assert.deepEqual(manifest.files,profile.files.map(f=>({...f,url:f.path})));
 for(const row of profile.files){const body=files.get('package/'+row.path);check(body.length===row.size&&sha(body)===row.sha256,'Retained native bytes changed');}
 const consumerBytes=await readFile(join(directory,'consumer.json')),videoBytes=await readFile(join(directory,'installed-video.json')),mirrorBytes=await readFile(join(directory,'pruned-runtime-cache-audio.json'));
 const consumer=JSON.parse(consumerBytes),video=JSON.parse(videoBytes),mirror=JSON.parse(mirrorBytes);
 check(mirror.sourceBinding?.bindingSha256===sha(bindingBytes),'Probe source binding changed');
 validateCurrentPrunedReceipts(binding,profile,consumer,video,mirror);
 const proof={schemaVersion:1,experimental:true,device:`darwin-${profile.arch}`,verificationCommit:process.env.GITHUB_SHA??null,verificationRunId:process.env.GITHUB_RUN_ID??null,sdkCommit:binding.sdkCommit,sdkRunId:binding.sdkRun,nativeCommit:binding.nativeCommit,nativeRunId:binding.nativeRun,prunedRunId:binding.prunedRun,mainSha256:sha(main),auxiliarySha256:sha(aux),inputBindingSha256:sha(bindingBytes),consumerReceiptSha256:sha(consumerBytes),videoReceiptSha256:sha(videoBytes),mirrorReceiptSha256:sha(mirrorBytes),nativeFiles:58,prepared:true,closed:true,realVideoDecoded:true,realAudioConverted:true,coldWarmMirrorVerified:true,accountAcceptanceEstablished:false,signingAuthenticityEstablished:false,published:false,defaultsChanged:false};
 await writeFile(join(directory,'pruned-current-acceptance.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});return proof;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){check(process.argv.length<=3,'Use DIRECTORY only');console.log(JSON.stringify(await verifyCurrentPrunedConsumer(process.argv[2]??'out')));}
