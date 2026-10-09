import {readFile,writeFile,mkdir,readdir,lstat,realpath,copyFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const args=process.argv.slice(2);if(args.length!==2)throw Error('Usage: node ci/prepare-video-materials.mjs ARTIFACT_ROOT OUTPUT_DIR');
const root=await realpath(resolve(args[0])),out=resolve(args[1]),repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(out===root||out.startsWith(root+sep))throw Error('Output must be outside input artifacts');
const sha=b=>createHash('sha256').update(b).digest('hex');
const normalized=b=>b.toString('utf8').replaceAll('\r\n','\n');
async function regular(path){const stat=await lstat(path);if(!stat.isFile())throw Error('Regular file required: '+path);return readFile(path);}
async function inventory(directory,prefix=''){
 const stat=await lstat(directory);if(!stat.isDirectory())throw Error('Directory required: '+directory);
 const result=[];for(const name of (await readdir(directory)).sort()){
  if(!name||name==='.'||name==='..'||/[\\/\0:]/.test(name))throw Error('Unsafe member name');
  const path=join(directory,name),member=prefix?prefix+'/'+name:name,stat=await lstat(path);
  if(stat.isDirectory())result.push(...await inventory(path,member));
  else {const bytes=await regular(path);result.push({path:member,size:bytes.length,sha256:sha(bytes)});}
 }return result;
}
async function copyInventory(from,to,files){for(const file of files){await mkdir(dirname(join(to,file.path)),{recursive:true});await copyFile(join(from,file.path),join(to,file.path));}}
const pin=JSON.parse(await regular(join(repo,'sdk/native/video/ffmpeg-source.json')));
const localSource=await regular(join(repo,'sdk/native/video/video-codec.cc'));
const source=join(root,'verified-video-source');await inventory(source);
const verification=JSON.parse(await regular(join(source,'source-verification.json')));
assert.equal(verification.version,pin.version);assert.equal(verification.commit,pin.commit);assert.equal(verification.archiveSha256,pin.sha256);assert.equal(verification.configureSha256,pin.configureSha256);assert.equal(verification.pgpVerified,true);assert.equal(verification.keyFingerprint,pin.keyFingerprint);
const sourceNames=[`ffmpeg-${pin.version}.tar.xz`,`ffmpeg-${pin.version}.tar.xz.asc`,'ffmpeg-release-key.asc','source-verification.json'];
assert.equal(sha(await regular(join(source,sourceNames[0]))),pin.sha256);
// This tool verifies the producer's signed-source receipt and archive digest; it does not rerun GPG.
assert.equal(sha(execFileSync('tar',['-xOf',join(source,sourceNames[0]),`ffmpeg-${pin.version}/configure`],{maxBuffer:8*1024*1024})),pin.configureSha256);
const fixtureHashes=['ced7b4e1cd47d948ecf407116095282e5b5ca4df76142b7a06826eecb92cb932','1c8920f2db13e3c1b28b708bc94d3889ed8bd10f15ee5d89881d99715188b468','53a0baad6f0853d39e53263c22c847bd78435fc263e6844450878b471d13cc57'];
const devices=['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'];
const validated=[];
for(const device of devices){
 const base=join(root,'video-'+device),[platform,arch]=device.split('-');
 const all=await inventory(base),runtime=join(base,'runtime'),relink=join(base,'relink');
 const build=JSON.parse(await regular(join(runtime,'build.json'))),relinkBuild=JSON.parse(await regular(join(relink,'build.json')));
 assert.deepEqual(relinkBuild,build);assert.equal(build.platform,platform);assert.equal(build.arch,arch);assert.equal(build.napiVersion,8);assert.equal(build.node,'v24.20.0');assert.equal(build.ffmpegVersion,pin.version);assert.equal(build.ffmpegCommit,pin.commit);assert.equal(build.sourceArchiveSha256,pin.sha256);
 for(const key of ['accountUsed','qqWrapperLoaded','nativeSendAttempted'])assert.equal(build[key],false);
 const binary=await regular(join(runtime,'video-codec.node'));assert.equal(sha(binary),build.binarySha256);assert.equal(binary.length,build.binaryBytes);
 for(const name of ['build-video-native.mjs','prepare-video-source.mjs','relink-video-native.mjs'])assert.equal(normalized(await regular(join(relink,name))),normalized(await regular(join(repo,'sdk/scripts',name))),'Preserved script source differs');
 const preservedSource=await regular(join(relink,'video-codec.cc'));assert.equal(sha(preservedSource),build.addonSourceSha256);assert.equal(normalized(preservedSource),normalized(localSource));
 assert.equal(sha(await regular(join(relink,'node-headers.tar.gz'))),build.nodeHeadersSha256);
 if(platform==='win32')assert.equal(sha(await regular(join(relink,'node.lib'))),build.nodeImportSha256);
 assert.equal(sha(await regular(join(relink,'config.h'))),build.configurationSha256);
 assert.deepEqual(JSON.parse(await regular(join(relink,'ffmpeg-source.json'))),pin);
 assert.equal(sha(await regular(join(runtime,'NODE-LICENSE.txt'))),build.nodeLicenseSha256);
 for(const name of ['NOTICE.txt','ADDON-LICENSE.txt','FFMPEG-LICENSE.md','FFMPEG-COPYING.LGPLv2.1'])assert.ok((await regular(join(runtime,name))).length);
 assert.equal(normalized(await regular(join(runtime,'ADDON-LICENSE.txt'))),normalized(await regular(join(repo,'sdk/native/video/LICENSE'))));
 const receipts={};for(const kind of ['runtime','relink']){
  const receipt=JSON.parse(await regular(join(base,kind,'consumer.json')));assert.equal(receipt.passed,true);assert.equal(receipt.platform,platform);assert.equal(receipt.arch,arch);assert.equal(receipt.node,build.node);assert.equal(receipt.noAccount,true);assert.equal(receipt.noQQ,true);assert.equal(receipt.nativeSendAttempted,false);assert.equal(receipt.sdkFakeCache,true);
  assert.deepEqual(receipt.inputs.map(x=>x.sha256),fixtureHashes);if(kind==='runtime')assert.equal(receipt.binary.sha256,build.binarySha256);receipts[kind]=receipt;
 }
 const libraries=platform==='win32'?['avformat.lib','avcodec.lib','swscale.lib','avutil.lib','video-codec.obj']:['libavformat.a','libavcodec.a','libswscale.a','libavutil.a','video-codec.o'];for(const file of libraries)assert.ok((await regular(join(relink,file))).length);
 for(const key of ['configureArgs','compileArgs','linkArgs','systemLinkFlags'])assert.ok(Array.isArray(build[key])&&build[key].every(x=>typeof x==='string'));
 validated.push({device,base,build,receipts,members:all,normalizedAddonSourceSha256:sha(Buffer.from(normalized(preservedSource)))});
}
await mkdir(out,{recursive:true});if(!(await lstat(out)).isDirectory())throw Error('Output must be a regular directory');if((await readdir(out)).length)throw Error('Output directory must be empty');
const scratch=await mkdtemp(join(tmpdir(),'qq-video-materials-')),assets=[];
async function asset(name){const b=await regular(join(out,name));assets.push({path:name,size:b.length,sha256:sha(b)});}
async function archive(name,directory){
 const before=await inventory(directory);execFileSync('tar',['-czf',join(out,name),'-C',directory,'.']);
 const extracted=join(scratch,'verify-'+name);await mkdir(extracted);execFileSync('tar',['-xzf',join(out,name),'-C',extracted]);
 const after=await inventory(extracted);assert.deepEqual(after,before,'Archive extraction inventory mismatch');await asset(name);return before;
}
try{
 for(const name of sourceNames){await copyFile(join(source,name),join(out,name));await asset(name);}
 const addon=join(scratch,'addon');await mkdir(join(addon,'native/video'),{recursive:true});
 const nativeFiles=await inventory(join(repo,'sdk/native/video'));await copyInventory(join(repo,'sdk/native/video'),join(addon,'native/video'),nativeFiles);
 await mkdir(join(addon,'scripts'));for(const name of ['build-video-native.mjs','prepare-video-source.mjs','relink-video-native.mjs'])await writeFile(join(addon,'scripts',name),await regular(join(repo,'sdk/scripts',name)));
 await writeFile(join(addon,'README.md'),'# Video addon source\n\nRequires Node 24 and the platform compiler/GNU make tools. From this directory run `node scripts/prepare-video-source.mjs build --verify-signature`, then `node scripts/build-video-native.mjs build`. The native/video and scripts layout is intentional. FFmpeg is obtained from the pinned official source.\n\nPlatform relink archives retain a flat relink directory: `node relink/relink-video-native.mjs relink FFMPEG_LIBRARY_DIRECTORY output/video-codec.node`. Use the preserved objects and compatible FFmpeg static libraries/toolchain/CRT; consult build.json for flags. Fresh relink receipts verify the original preserved libraries, not modified-library compatibility or byte-identical output.\n');
 const addonMembers=await archive('video-addon-source.tar.gz',addon);
 const platforms=[];for(const item of validated){
  const directory=join(scratch,item.device);await mkdir(directory);await copyInventory(item.base,directory,item.members);
  const members=await archive('video-'+item.device+'-relink.tar.gz',directory);
  platforms.push({platform:item.build.platform,arch:item.build.arch,node:item.build.node,ffmpegVersion:item.build.ffmpegVersion,sourceArchiveSha256:item.build.sourceArchiveSha256,binarySha256:item.build.binarySha256,addonSourceSha256:item.build.addonSourceSha256,normalizedAddonSourceSha256:item.normalizedAddonSourceSha256,flagsSource:'relink/build.json',build:item.build,receipts:item.receipts,members,relinkedBinaryPreserved:false});
 }
 const report={schemaVersion:1,candidateOnly:true,pgpVerification:'Producer receipt bound to pinned archive; GPG not rerun by this offline packager',ffmpeg:pin,sourceVerification:verification,assets,addonMembers,platforms,archiveExtractionInventoryVerified:true,nativeExecuted:false,accountUsed:false,published:false};
 await writeFile(join(out,'video-materials.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output:out,assets:assets.length,platforms:platforms.length,archiveExtractionInventoryVerified:true}));
}finally{await rm(scratch,{recursive:true,force:true});}
