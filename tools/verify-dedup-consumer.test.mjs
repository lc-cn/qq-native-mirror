import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDedupInstalledReceipts} from './verify-dedup-consumer.mjs';
const fixtures=['ced7b4e1cd47d948ecf407116095282e5b5ca4df76142b7a06826eecb92cb932','1c8920f2db13e3c1b28b708bc94d3889ed8bd10f15ee5d89881d99715188b468','53a0baad6f0853d39e53263c22c847bd78435fc263e6844450878b471d13cc57'];
function windowsArm(){
 const build={device:'win32-arm64'};
 const manifest={nodeVersion:'v24.20.0',videoCodec:'video/video-codec.node',files:[{path:'video/video-codec.node',sha256:'a'.repeat(64),size:19}]};
 const video={passed:true,noAccount:true,noQQ:true,nativeSendAttempted:false,platform:'win32',arch:'arm64',node:'v24.20.0',binary:{sha256:'a'.repeat(64),bytes:19},sdkFakeCache:true,inputs:fixtures.map(sha256=>({sha256}))};
 const receipt={platform:'win32',arch:'arm64',node:'v24.20.0',exports:98,installedMainOnly:true,automaticPlatformSelection:true,prepared:true,closed:true,loginAttempted:false,accountUsed:false,nativeMessageBatchQueryAttempted:false,installedCliEntrypointContract:true,posixNpmBinEntrypointChecked:false,pendingReadCloseContract:true,reentrantReadCloseContract:true,historyInputCaptureContract:true,loginWaitIdentityContract:true,watchReconnectPolicyContract:true,nativeHistoryQueryAttempted:false,sessionStrategyContract:true,nativeSessionStrategyLoginAttempted:false,attachmentDownloadContract:true,nativeAttachmentDownloadAttempted:false,forwardResourceContract:true,forwardResourceTypedElementsContract:true,forwardResourceDeclarationsContract:true,nativeForwardResourceAttempted:false,receivedForwardContract:true,nativeReceivedForwardObserved:false,mergedForwardClientContract:true,mergedForwardServiceContract:true,nativeMergedForwardAttempted:false,messageBatchQueryContract:true,messageBatchCliContract:true,installedNativeStorage:{format:'gzip-objects-v1',nativePaths:27,objects:26,allOriginalFilesVerified:true,warmCacheReused:true,networkFallbackAttempted:false},tarballRequests:['qq-native-client','qq-native-client-win32-arm64','silk-wasm']};
 return{build,manifest,receipt,video};
}
test('Windows ARM64 acceptance requires exact ABI, platform inventory, genuine codec and no account scope',()=>{
 const valid=windowsArm();validateDedupInstalledReceipts(valid.build,valid.manifest,valid.receipt,valid.video);
 for(const mutate of [
  x=>{x.receipt.node='v24.19.0';x.video.node='v24.19.0';},
  x=>x.receipt.arch='x64',x=>x.receipt.exports=104,
  x=>x.receipt.installedNativeStorage.nativePaths=32,
  x=>x.receipt.installedNativeStorage.objects=27,
  x=>x.receipt.accountUsed=true,x=>x.receipt.loginAttempted=true,
  x=>x.receipt.nativeMessageBatchQueryAttempted=true,
  x=>delete x.receipt.installedCliEntrypointContract,
  x=>x.receipt.posixNpmBinEntrypointChecked=true,
  x=>delete x.receipt.pendingReadCloseContract,
  x=>x.receipt.reentrantReadCloseContract=false,
  x=>delete x.receipt.historyInputCaptureContract,
  x=>x.receipt.loginWaitIdentityContract=false,
  x=>x.receipt.watchReconnectPolicyContract=false,
  x=>x.receipt.nativeHistoryQueryAttempted=true,
  x=>delete x.receipt.sessionStrategyContract,
  x=>x.receipt.nativeSessionStrategyLoginAttempted=true,
  x=>delete x.receipt.attachmentDownloadContract,
  x=>x.receipt.nativeAttachmentDownloadAttempted=true,
  x=>delete x.receipt.forwardResourceContract,
  x=>delete x.receipt.forwardResourceTypedElementsContract,
  x=>x.receipt.forwardResourceDeclarationsContract=false,
  x=>x.receipt.nativeForwardResourceAttempted=true,
  x=>delete x.receipt.receivedForwardContract,
  x=>x.receipt.nativeReceivedForwardObserved=true,
  x=>delete x.receipt.mergedForwardClientContract,
  x=>x.receipt.mergedForwardServiceContract=false,
  x=>x.receipt.nativeMergedForwardAttempted=true,
  x=>x.receipt.installedNativeStorage.networkFallbackAttempted=true,
  x=>x.receipt.closed=false,x=>x.video.noAccount=false,
  x=>x.video.binary.sha256='b'.repeat(64),
  x=>x.video.inputs[2]=x.video.inputs[0],
  x=>x.receipt.tarballRequests.push('qq-native-client-win32-x64')
 ]){const x=windowsArm();mutate(x);assert.throws(()=>validateDedupInstalledReceipts(x.build,x.manifest,x.receipt,x.video));}
});
test('Linux acceptance uses its own complete inventory rather than macOS counts',()=>{
 const x=windowsArm();x.build.device='linux-x64';delete x.manifest.nodeVersion;
 x.receipt.platform=x.video.platform='linux';x.receipt.posixNpmBinEntrypointChecked=true;x.receipt.arch=x.video.arch='x64';
 x.receipt.installedNativeStorage.nativePaths=19;x.receipt.installedNativeStorage.objects=19;
 x.receipt.tarballRequests=['qq-native-client','qq-native-client-linux-x64','silk-wasm'];
 validateDedupInstalledReceipts(x.build,x.manifest,x.receipt,x.video);
 x.receipt.installedNativeStorage.nativePaths=1168;x.receipt.installedNativeStorage.objects=321;
 assert.throws(()=>validateDedupInstalledReceipts(x.build,x.manifest,x.receipt,x.video));
});
