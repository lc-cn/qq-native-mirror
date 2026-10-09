import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readNativeTarFiles} from '../sdk/scripts/native-tar-files.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(ok,message)=>{if(!ok)throw Error(message);};
export const deviceContracts={
 'linux-x64':{paths:19,objects:19,exports:98},
 'linux-arm64':{paths:20,objects:20,exports:98},
 'darwin-x64':{paths:1168,objects:321,exports:104},
 'darwin-arm64':{paths:1168,objects:321,exports:104},
 'win32-x64':{paths:32,objects:31,exports:98},
 'win32-arm64':{paths:27,objects:26,exports:98}
};
const sourceCommit='6cae1ec0a5e1bfb03cb7871083915b3d03272347';
const sourceReleaseSha='9a362f3c4abada4c8cfc397039c20835bcb5393e0ae356873cccb518be9c8e1a';
export async function inspectDedupCandidate(directory){
 const buildBytes=await readFile(join(directory,'dedup-build.json')),build=JSON.parse(buildBytes);
 check(build.schemaVersion===1&&build.experimental===true&&Object.hasOwn(deviceContracts,build.device),'Unsupported dedup candidate');
 check(build.source.repository==='lc-cn/qq-native-mirror'&&build.source.commit===sourceCommit&&build.source.runId==='37962268125'&&build.source.runAttempt===1&&build.source.releaseManifestSha256===sourceReleaseSha,'Wrong original native source');
 check(build.accountAcceptanceEstablished===false&&build.signingAuthenticityEstablished===false&&build.published===false&&build.defaultsChanged===false,'Candidate acceptance scope changed');
 const contract=deviceContracts[build.device];
 const originalBytes=await readFile(join(directory,'source-native-manifest.json')),original=JSON.parse(originalBytes);
 const releaseBytes=await readFile(join(directory,'source-release-manifest.json')),release=JSON.parse(releaseBytes);
 check(sha(releaseBytes)===sourceReleaseSha&&sha(originalBytes)===build.source.auxiliary.nativeManifestSha256,'Original source manifests changed');
 const sourceRow=release.packages.find(r=>r.name==='qq-native-client-'+build.device);
 assert.deepEqual(build.source.auxiliary,{tarball:sourceRow.tarball,sha256:sourceRow.sha256,size:sourceRow.size,nativeManifestSha256:sourceRow.manifestSha256});
 check(build.candidate.tarball===sourceRow.tarball&&build.candidate.nativePaths===contract.paths&&build.candidate.objectCount===contract.objects,'Candidate identity changed');
 const packedBytes=await readFile(join(directory,build.candidate.tarball));
 check(sha(packedBytes)===build.candidate.sha256&&packedBytes.length===build.candidate.size,'Candidate tarball changed');
 const files=await readNativeTarFiles(join(directory,build.candidate.tarball));
 const manifestBytes=files.get('package/manifest.json'),manifest=JSON.parse(manifestBytes),metadata=JSON.parse(files.get('package/package.json'));
 check(sha(manifestBytes)===build.candidate.nativeManifestSha256,'Candidate manifest changed');
 check(metadata.name==='qq-native-client-'+build.device&&metadata.version==='0.0.2'&&Object.keys(metadata.scripts??{}).length===0,'Candidate npm metadata changed');
 assert.deepEqual(metadata.os,[original.platform]);assert.deepEqual(metadata.cpu,[original.arch]);
 if(original.platform==='linux')assert.deepEqual(metadata.libc,['glibc']);
 if(original.platform==='win32')check(original.nodeVersion==='v24.20.0'&&/^[a-f0-9]{64}$/.test(original.nodeConfigSha256),'Windows Node constraint missing');
 check(manifest.npmStorage?.format==='gzip-objects-v1'&&manifest.files.length===contract.paths&&original.files.length===contract.paths&&manifest.npmStorage.objects.length===contract.objects,'Full storage inventory missing');
 const {npmStorage,files:inventory,...fields}=manifest;const {files:sourceInventory,...sourceFields}=original;assert.deepEqual(fields,sourceFields);
 assert.deepEqual(inventory.map(({path,sha256})=>({path,sha256})),sourceInventory.map(({path,sha256})=>({path,sha256})));
 for(let i=0;i<sourceInventory.length;i++)if(sourceInventory[i].size!==undefined)check(inventory[i].size===sourceInventory[i].size,'Original declared size changed');
 assert.deepEqual([...files.keys()].sort(),['package/package.json','package/README.md','package/manifest.json',...npmStorage.objects.map(o=>'package/'+o.path)].sort());
 const raw=new Map();for(const object of npmStorage.objects){
  check(object.path===`objects/${object.sha256}.gz`&&!raw.has(object.sha256),'Duplicate or unsafe storage object');
  const bytes=files.get('package/'+object.path);check(bytes?.length===object.downloadSize&&sha(bytes)===object.downloadSha256,'Compressed content changed');
  const body=gunzipSync(bytes,{maxOutputLength:Math.max(1,object.size)});check(body.length===object.size&&sha(body)===object.sha256,'Raw content changed');raw.set(object.sha256,body);
 }
 for(const file of inventory)check(raw.get(file.sha256)?.length===file.size,'Original file absent from object set');
 check(raw.size===new Set(inventory.map(f=>f.sha256)).size,'Unused storage object');
 return {buildBytes,build,manifest,manifestBytes,packedBytes};
}
export async function bindConsumerSdk(directory,environment=process.env){
 const {build}=await inspectDedupCandidate(directory);
 const tarball='qq-native-client-0.0.2.tgz',bytes=await readFile(join(directory,tarball)),files=await readNativeTarFiles(join(directory,tarball));
 const pkg=JSON.parse(files.get('package/package.json'));check(pkg.name==='qq-native-client'&&pkg.version==='0.0.2','Wrong consumer SDK');
 check(files.has('package/dist/native-installed-storage.js'),'Consumer SDK has no installed storage loader');
 const binding={schemaVersion:1,tarball,sha256:sha(bytes),size:bytes.length,storageLoaderSha256:sha(files.get('package/dist/native-installed-storage.js')),builderCommit:environment.GITHUB_SHA??null,builderRunId:environment.GITHUB_RUN_ID??null,nativeSource:build.source};
 await writeFile(join(directory,'consumer-sdk.json'),JSON.stringify(binding,null,2)+'\n');return binding;
}
export function validateDedupInstalledReceipts(build,manifest,receipt,video){
 const contract=deviceContracts[build.device];check(contract,'Unsupported consumer device');
 check(`${receipt.platform}-${receipt.arch}`===build.device&&/^v24\./.test(receipt.node)&&receipt.exports===contract.exports&&receipt.installedMainOnly===true&&receipt.automaticPlatformSelection===true&&receipt.prepared===true&&receipt.closed===true&&receipt.loginAttempted===false&&receipt.accountUsed===false,'Installed preparation/close failed');
 if(manifest.nodeVersion!==undefined)check(receipt.node===manifest.nodeVersion,'Actual consumer Node ABI mismatch');
 check(receipt.receivedForwardContract===true&&receipt.nativeReceivedForwardObserved===false,'Installed received-forward contract missing or real observation claimed');
 check(receipt.forwardResourceContract===true&&receipt.nativeForwardResourceAttempted===false,'Installed forward-resource contract missing or real read claimed');
 check(receipt.forwardResourceTypedElementsContract===true&&receipt.forwardResourceDeclarationsContract===true,'Installed forward-resource element or declaration contract missing');
 check(receipt.historyInputCaptureContract===true&&receipt.loginWaitIdentityContract===true&&receipt.watchReconnectPolicyContract===true&&receipt.nativeHistoryQueryAttempted===false,'Installed history lifecycle contracts missing or real read claimed');
 check(receipt.pendingReadCloseContract===true&&receipt.reentrantReadCloseContract===true,'Installed pending or reentrant read close contract missing');
 check(receipt.installedCliEntrypointContract===true&&receipt.posixNpmBinEntrypointChecked===(receipt.platform!=='win32'),'Installed CLI entrypoint contract missing');
 check(receipt.mergedForwardClientContract===true&&receipt.mergedForwardServiceContract===true&&receipt.nativeMergedForwardAttempted===false,'Installed merged-forward contracts missing or real operation attempted');
 check(receipt.nativeMessageBatchQueryAttempted===false&&receipt.messageBatchQueryContract===true&&receipt.messageBatchCliContract===true,'Installed batch contracts missing');
 assert.deepEqual(receipt.installedNativeStorage,{format:'gzip-objects-v1',nativePaths:contract.paths,objects:contract.objects,allOriginalFilesVerified:true,warmCacheReused:true,networkFallbackAttempted:false});
 assert.deepEqual(receipt.tarballRequests.slice().sort(),['qq-native-client','qq-native-client-'+build.device,'silk-wasm'].sort());
 const codec=manifest.files.find(f=>f.path===manifest.videoCodec);
 check(video.passed===true&&video.noAccount===true&&video.noQQ===true&&video.nativeSendAttempted===false&&video.platform===receipt.platform&&video.arch===receipt.arch&&video.node===receipt.node&&video.binary.sha256===codec.sha256&&video.binary.bytes===codec.size&&video.sdkFakeCache===true,'Actual installed codec failed');
 assert.deepEqual(video.inputs.map(i=>i.sha256).sort(),['ced7b4e1cd47d948ecf407116095282e5b5ca4df76142b7a06826eecb92cb932','1c8920f2db13e3c1b28b708bc94d3889ed8bd10f15ee5d89881d99715188b468','53a0baad6f0853d39e53263c22c847bd78435fc263e6844450878b471d13cc57'].sort());
}
export async function verifyDedupConsumer(directory,environment=process.env){
 const {buildBytes,build,manifest}=await inspectDedupCandidate(directory);
 const bindingBytes=await readFile(join(directory,'consumer-sdk.json')),binding=JSON.parse(bindingBytes);
 check(binding.builderCommit===(environment.GITHUB_SHA??null)&&binding.builderRunId===(environment.GITHUB_RUN_ID??null),'Wrong SDK builder');
 assert.deepEqual(binding.nativeSource,build.source);
 const mainBytes=await readFile(join(directory,binding.tarball));check(binding.tarball==='qq-native-client-0.0.2.tgz'&&sha(mainBytes)===binding.sha256&&mainBytes.length===binding.size,'Consumer SDK changed');
 const main=await readNativeTarFiles(join(directory,binding.tarball));check(sha(main.get('package/dist/native-installed-storage.js'))===binding.storageLoaderSha256,'Consumer storage loader changed');
 const receiptBytes=await readFile(join(directory,'consumer.json')),receipt=JSON.parse(receiptBytes);
 const videoBytes=await readFile(join(directory,'installed-video.json')),video=JSON.parse(videoBytes);assert.deepEqual(receipt.installedVideo,video);
 validateDedupInstalledReceipts(build,manifest,receipt,video);
 const proof={schemaVersion:1,experimental:true,device:build.device,source:build.source,candidate:build.candidate,consumerSdk:binding,buildReceiptSha256:sha(buildBytes),consumerSdkBindingSha256:sha(bindingBytes),consumerReceiptSha256:sha(receiptBytes),videoReceiptSha256:sha(videoBytes),allOriginalPathsAndBytesPreserved:true,installedHydrationVerified:true,warmCacheVerified:true,prepared:true,closed:true,accountAcceptanceEstablished:false,signingAuthenticityEstablished:false,published:false,defaultsChanged:false};
 await writeFile(join(directory,'dedup-acceptance.json'),JSON.stringify(proof,null,2)+'\n');return proof;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 check(process.argv.length===4&&['--bind-main','--verify-consumer'].includes(process.argv[2]),'Usage: node tools/verify-dedup-consumer.mjs --bind-main|--verify-consumer DIRECTORY');
 console.log(JSON.stringify(await (process.argv[2]==='--bind-main'?bindConsumerSdk:verifyDedupConsumer)(resolve(process.argv[3]))));
}
