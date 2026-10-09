import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateVideoMaterials,verifyVideoMaterialsOnline,videoTargets,videoAssetNames } from '../scripts/video-materials.mjs';
import { publishValidated } from '../scripts/local-first-publish.mjs';
const hash=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
const fixtures=['ced7b4e1cd47d948ecf407116095282e5b5ca4df76142b7a06826eecb92cb932','1c8920f2db13e3c1b28b708bc94d3889ed8bd10f15ee5d89881d99715188b468','53a0baad6f0853d39e53263c22c847bd78435fc263e6844450878b471d13cc57'];
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'qq-video-materials-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'video-materials'));
 const pin=JSON.parse(await readFile(new URL('../native/video/ffmpeg-source.json',import.meta.url),'utf8'));
 const manifest:any={repository:'lc-cn/qq-native-mirror',commit:'a'.repeat(40),runId:'123',runAttempt:1,version:'0.0.3'};
 const tag='video-npm-v0.0.3-ci-123-attempt-1',binary=Buffer.from('never-executed-codec'),binaryHash=hash(binary),sourceHash='b'.repeat(64);
 const binding:any={schemaVersion:1,...manifest,tag,releaseId:456,assets:videoAssetNames.map(name=>({name,url:`https://github.com/lc-cn/qq-native-mirror/releases/download/${tag}/${name}`,size:10,sha256:name==='ffmpeg-9.0.2.tar.xz'?pin.sha256:'c'.repeat(64)}))};
 const member=(path:string,sha256='d'.repeat(64))=>({path,size:10,sha256});
 const proof=(platform:string,arch:string)=>({passed:true,platform,arch,node:'v24.20.0',noAccount:true,noQQ:true,nativeSendAttempted:false,sdkFakeCache:true,sourceUnchanged:true,concurrentDecode:true,unicodeFilename:true,malformedMissingNetworkRejected:true,inputs:fixtures.map(sha256=>({sha256})),binary:{sha256:binaryHash,bytes:binary.length}});
 const report:any={schemaVersion:1,ffmpeg:pin,sourceVerification:{version:pin.version,commit:pin.commit,archiveSha256:pin.sha256,configureSha256:pin.configureSha256,keyFingerprint:pin.keyFingerprint,pgpVerified:true},archiveExtractionInventoryVerified:true,nativeExecuted:false,accountUsed:false,published:false,
 assets:binding.assets.filter((row:any)=>row.name!=='video-materials.json').map((row:any)=>({path:row.name,size:row.size,sha256:row.sha256})),
 addonMembers:['native/video/video-codec.cc','native/video/ffmpeg-source.json','native/video/LICENSE','scripts/build-video-native.mjs','scripts/prepare-video-source.mjs','scripts/relink-video-native.mjs'].map(path=>member(path,path.endsWith('.cc')?sourceHash:undefined)),platforms:[]};
 for(const target of videoTargets){const[platform,arch]=target.split('-');const build:any={platform,arch,node:'v24.20.0',napiVersion:8,binarySha256:binaryHash,addonSourceSha256:sourceHash,ffmpegVersion:pin.version,ffmpegCommit:pin.commit,sourceArchiveSha256:pin.sha256,nodeHeadersSha256:'d'.repeat(64),nodeImportSha256:'d'.repeat(64),nodeLicenseSha256:'d'.repeat(64),configurationSha256:'d'.repeat(64),accountUsed:false,qqWrapperLoaded:false,nativeSendAttempted:false,configureArgs:['--disable-gpl','--disable-nonfree','--disable-version3','--enable-static','--disable-network'],compileArgs:['compile'],linkArgs:['link'],systemLinkFlags:[]};
 const names=['runtime/video-codec.node','runtime/build.json','runtime/consumer.json','runtime/NODE-LICENSE.txt','runtime/NOTICE.txt','runtime/ADDON-LICENSE.txt','runtime/FFMPEG-LICENSE.md','runtime/FFMPEG-COPYING.LGPLv2.1','relink/build.json','relink/consumer.json','relink/video-codec.cc','relink/ffmpeg-source.json','relink/node-headers.tar.gz','relink/config.h','relink/config_components.h','relink/ffbuild-config.mak','relink/ADDON-LICENSE.txt','relink/build-video-native.mjs','relink/prepare-video-source.mjs','relink/relink-video-native.mjs',...(platform==='win32'?['relink/avformat.lib','relink/avcodec.lib','relink/swscale.lib','relink/avutil.lib','relink/video-codec.obj','relink/node.lib']:['relink/libavformat.a','relink/libavcodec.a','relink/libswscale.a','relink/libavutil.a','relink/video-codec.o'])];
 report.platforms.push({platform,arch,node:build.node,ffmpegVersion:pin.version,sourceArchiveSha256:pin.sha256,binarySha256:binaryHash,addonSourceSha256:sourceHash,normalizedAddonSourceSha256:sourceHash,flagsSource:'relink/build.json',build,members:names.map(path=>member(path,path==='runtime/video-codec.node'?binaryHash:path==='relink/video-codec.cc'?sourceHash:undefined)),receipts:{runtime:proof(platform,arch),relink:proof(platform,arch)}});}
 // Windows preserved source uses CRLF; normalize only source/archive equality,
 // retain the platform-specific original compiled-source digest.
 for(const platform of report.platforms.filter((row:any)=>row.platform==='win32')){
  platform.addonSourceSha256='e'.repeat(64);platform.build.addonSourceSha256='e'.repeat(64);
  platform.members.find((row:any)=>row.path==='relink/video-codec.cc').sha256='e'.repeat(64);
 }
 const nativePackages:any[]=[];
 const save=async()=>{const bytes=Buffer.from(JSON.stringify(report));const asset=binding.assets.find((row:any)=>row.name==='video-materials.json');asset.sha256=hash(bytes);asset.size=bytes.length;const b=Buffer.from(JSON.stringify(binding));await writeFile(join(root,'video-materials/video-materials.json'),bytes);await writeFile(join(root,'video-materials/video-materials-binding.json'),b);manifest.videoMaterials={binding:{path:'video-materials/video-materials-binding.json',sha256:hash(b)},report:{path:'video-materials/video-materials.json',sha256:hash(bytes)}};};
 await save();
 for(const target of videoTargets){const stage=join(root,target,'package/video');await mkdir(stage,{recursive:true});const source=Buffer.from(JSON.stringify({materials:binding,binarySha256:binaryHash}));await writeFile(join(stage,'video-codec.node'),binary);await writeFile(join(stage,'SOURCE-PROVENANCE.json'),source);const tar=join(root,`${target}.tgz`);execFileSync('tar',['-czf',tar,'-C',join(root,target),'package']);const[platform,arch]=target.split('-');nativePackages.push({target,path:tar,native:{videoCodec:'video/video-codec.node',files:[{path:'video/video-codec.node',sha256:binaryHash,size:binary.length},{path:'video/SOURCE-PROVENANCE.json',sha256:hash(source)}]},receipt:{automaticVideoCodec:true,installedVideoDecoder:true,installedVideoFakeCache:true,installedVideo:proof(platform,arch)}});}
 return{root,manifest,binding,report,nativePackages,save};
}
test('complete six-platform video source closure validates offline and requires anonymous online release proof',async t=>{
 const f=await fixture(t),materials=await validateVideoMaterials(f.root,f.manifest,f.nativePackages);assert.equal(materials.pending,false);let commands=0;
 assert.throws(()=>publishValidated({videoMaterials:materials,packages:[]},()=>{commands++;}),/verified online/);assert.equal(commands,0);
 let requests=0;await verifyVideoMaterialsOnline(materials,{fetch:async(url:any)=>{requests++;if(String(url).startsWith('https://api.github.com/'))return new Response(JSON.stringify({id:456,draft:false,prerelease:true,target_commitish:f.manifest.commit,tag_name:f.binding.tag,assets:f.binding.assets.map((row:any)=>({name:row.name,size:row.size,digest:`sha256:${row.sha256}`,browser_download_url:row.url}))}));return new Response(JSON.stringify(f.report));}});assert.equal(materials.onlineVerified,true);assert.equal(requests,2);
});
test('codec-free is compatible and absent closure stays blocked; bad partial/digest declaration rejects',async t=>{
 const f=await fixture(t);assert.equal(await validateVideoMaterials(f.root,{},[]),undefined);assert.deepEqual(await validateVideoMaterials(f.root,{},f.nativePackages),{pending:true});
 await assert.rejects(validateVideoMaterials(f.root,{...f.manifest,videoMaterials:{}},f.nativePackages),/declaration/);
 await writeFile(join(f.root,'video-materials/video-materials.json'),'corrupt');await assert.rejects(validateVideoMaterials(f.root,f.manifest,f.nativePackages),/digest/);
});
test('rehashed material proofs cannot omit libraries, source, fixtures or identity',async t=>{
 for(const kind of ['library','source','fixture','flags','identity','url','installed','provenance','normalized']){
  const f=await fixture(t);
  if(kind==='library')f.report.platforms[0].members=f.report.platforms[0].members.filter((row:any)=>row.path!=='relink/libavcodec.a');
  if(kind==='source')f.report.addonMembers=f.report.addonMembers.filter((row:any)=>row.path!=='native/video/video-codec.cc');
  if(kind==='fixture')f.report.platforms[0].receipts.runtime.inputs[0].sha256='0'.repeat(64);
  if(kind==='flags')f.report.platforms[0].build.configureArgs=[];
  if(kind==='identity')f.binding.runAttempt=2;
  if(kind==='url')f.binding.assets[0].url='https://other.invalid/source';
  if(kind==='installed')f.nativePackages[0].receipt.installedVideoDecoder=false;
  if(kind==='normalized')f.report.platforms[0].normalizedAddonSourceSha256='0'.repeat(64);
  if(kind==='provenance')f.nativePackages[0].native.files[1].sha256='0'.repeat(64);
  await f.save();await assert.rejects(validateVideoMaterials(f.root,f.manifest,f.nativePackages));
 }
});
test('online drift rejects draft, commit, asset digest and report byte changes without credentials',async t=>{
 const f=await fixture(t);
 for(const kind of ['draft','commit','digest','report']){const materials=await validateVideoMaterials(f.root,f.manifest,f.nativePackages);const metadata:any={id:456,draft:false,prerelease:true,target_commitish:f.manifest.commit,tag_name:f.binding.tag,assets:f.binding.assets.map((row:any)=>({name:row.name,size:row.size,digest:`sha256:${row.sha256}`,browser_download_url:row.url}))};if(kind==='draft')metadata.draft=true;if(kind==='commit')metadata.target_commitish='b'.repeat(40);if(kind==='digest')metadata.assets[0].digest='sha256:'+'0'.repeat(64);
 await assert.rejects(verifyVideoMaterialsOnline(materials,{fetch:async(url:any,options:any)=>{assert.equal(options?.headers?.Authorization,undefined);return new Response(String(url).startsWith('https://api.github.com/')?JSON.stringify(metadata):kind==='report'?'changed':JSON.stringify(f.report));}}));assert.equal(materials.onlineVerified,false);}
});
