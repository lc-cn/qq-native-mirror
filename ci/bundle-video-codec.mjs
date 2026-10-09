import {readFile,writeFile,readdir,lstat,mkdir,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function bundleVideoCodec(target,manifest){
 const base=resolve('out/video-codec'),runtime=join(base,'runtime');
 const binding=JSON.parse(await readFile('out/video-materials/video-materials-binding.json'));
 const materialBytes=await readFile('out/video-materials/video-materials.json'),materials=JSON.parse(materialBytes);
 const sdk=JSON.parse(await readFile('sdk/package.json'));
 const tag=`video-npm-v${sdk.version}-ci-${process.env.GITHUB_RUN_ID}-attempt-${process.env.GITHUB_RUN_ATTEMPT}`;
 if(binding.schemaVersion!==1||binding.repository!==process.env.GITHUB_REPOSITORY||binding.commit!==process.env.GITHUB_SHA||binding.runId!==process.env.GITHUB_RUN_ID||binding.runAttempt!==Number(process.env.GITHUB_RUN_ATTEMPT)||binding.version!==sdk.version||binding.tag!==tag||!Number.isSafeInteger(binding.releaseId)||binding.releaseId<1||!Array.isArray(binding.assets)||binding.assets.length!==12)throw Error('Permanent materials CI binding mismatch');
 const assetNames=new Set();for(const asset of binding.assets){if(typeof asset.name!=='string'||!/^[\w.-]+$/.test(asset.name)||assetNames.has(asset.name)||!Number.isSafeInteger(asset.size)||asset.size<1||!/^[a-f0-9]{64}$/.test(asset.sha256)||asset.url!==`https://github.com/${binding.repository}/releases/download/${tag}/${asset.name}`)throw Error('Invalid permanent materials asset');assetNames.add(asset.name);}
 const reportAsset=binding.assets.find(a=>a.name==='video-materials.json');
 if(!reportAsset||reportAsset.sha256!==sha(materialBytes)||reportAsset.size!==materialBytes.length||materials.schemaVersion!==1||materials.archiveExtractionInventoryVerified!==true||materials.platforms?.length!==6||materials.assets?.length!==11)throw Error('Permanent materials report mismatch');
 for(const asset of materials.assets){const bound=binding.assets.find(a=>a.name===asset.path);if(!bound||bound.sha256!==asset.sha256||bound.size!==asset.size)throw Error('Materials inventory binding mismatch');}
 const pin=JSON.parse(await readFile('sdk/native/video/ffmpeg-source.json'));
 const build=JSON.parse(await readFile(join(runtime,'build.json')));
 const materialDevice=materials.platforms.find(p=>p.platform===process.platform&&p.arch===process.arch);
 if(!materialDevice||JSON.stringify(materialDevice.build)!==JSON.stringify(build)||materialDevice.binarySha256!==build.binarySha256||materialDevice.sourceArchiveSha256!==build.sourceArchiveSha256)throw Error('Materials do not bind this platform build');
 const consumer=JSON.parse(await readFile(join(runtime,'consumer.json')));
 const relink=JSON.parse(await readFile(join(base,'relink/consumer.json')));
 const binary=await readFile(join(runtime,'video-codec.node'));
 if(build.platform!==process.platform||build.arch!==process.arch||build.node!==process.version||build.napiVersion!==8||build.ffmpegVersion!==pin.version||build.ffmpegCommit!==pin.commit||build.sourceArchiveSha256!==pin.sha256||build.addonSourceSha256!==sha(await readFile('sdk/native/video/video-codec.cc'))||build.binarySha256!==sha(binary)||build.binaryBytes!==binary.length)throw Error('Video producer identity mismatch');
 if(build.nodeHeadersSha256!==sha(await readFile(join(base,'relink/node-headers.tar.gz')))||build.addonSourceSha256!==sha(await readFile(join(base,'relink/video-codec.cc'))))throw Error('Video relink source binding mismatch');
 const relinkPin=JSON.parse(await readFile(join(base,'relink/ffmpeg-source.json')));
 if(JSON.stringify(relinkPin)!==JSON.stringify(pin)||build.configurationSha256!==sha(await readFile(join(base,'relink/config.h')))||build.nodeLicenseSha256!==sha(await readFile(join(runtime,'NODE-LICENSE.txt')))||build.accountUsed!==false||build.qqWrapperLoaded!==false||build.nativeSendAttempted!==false)throw Error('Video build configuration/source/notice binding mismatch');
 if(process.platform==='win32'&&build.nodeImportSha256!==sha(await readFile(join(base,'relink/node.lib'))))throw Error('Video Node import binding mismatch');
 for(const receipt of [consumer,relink])if(receipt.platform!==process.platform||receipt.arch!==process.arch||receipt.node!==process.version||receipt.passed!==true||receipt.noAccount!==true||receipt.noQQ!==true||receipt.nativeSendAttempted!==false||receipt.inputs?.length!==3||receipt.sdkFakeCache!==true)throw Error('Video producer decoding/relink acceptance missing');
 if(consumer.binary?.sha256!==sha(binary))throw Error('Video consumer binary mismatch');
 for(const required of ['ADDON-LICENSE.txt','NODE-LICENSE.txt','FFMPEG-LICENSE.md','FFMPEG-COPYING.LGPLv2.1','NOTICE.txt'])if(!(await readFile(join(runtime,required))).length)throw Error('Missing video license notice');
 const names=new Set(manifest.files.map(f=>f.path));
 async function copy(directory,prefix=''){
  for(const name of await readdir(directory)){
   if(!name||name==='.'||name==='..'||/[\\/\0:]/.test(name))throw Error('Unsafe video runtime name');
   const from=join(directory,name),path=prefix?prefix+'/'+name:name,stat=await lstat(from);
   if(stat.isDirectory()){await copy(from,path);continue;}
   if(!stat.isFile())throw Error('Video runtime must contain regular files only');
   const destination='video/'+path;if(names.has(destination))throw Error('Video runtime path collision');names.add(destination);
   await mkdir(join(target,'video',prefix),{recursive:true});await copyFile(from,join(target,destination));
   const bytes=await readFile(join(target,destination));manifest.files.push({path:destination,url:destination,sha256:sha(bytes),size:bytes.length});
  }
 }
 await copy(runtime);
 const path='video/SOURCE-PROVENANCE.json';if(names.has(path))throw Error('Video provenance collision');
 const bytes=Buffer.from(JSON.stringify({schemaVersion:1,component:'Project-owned MIT Node addon with LGPL FFmpeg; QQ vendor licensing is unchanged',ffmpeg:pin,addonSourceSha256:build.addonSourceSha256,repository:process.env.GITHUB_REPOSITORY,commit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,producerArtifact:`video-${process.platform}-${process.arch}`,materials:binding,permanentMaterialsAvailable:true,platform:process.platform,arch:process.arch,binarySha256:build.binarySha256,distribution:'Corresponding source and relink materials are bound to the immutable CI prerelease; QQ vendor licensing is unchanged'},null,2)+'\n');
 await writeFile(join(target,path),bytes);manifest.files.push({path,url:path,sha256:sha(bytes),size:bytes.length});
 const noticePath='video/SOURCE-AND-RELINK.txt';if(names.has(noticePath))throw Error('Video material notice collision');
 const selected=['video-materials.json',`ffmpeg-${pin.version}.tar.xz`,`ffmpeg-${pin.version}.tar.xz.asc`,'ffmpeg-release-key.asc','source-verification.json','video-addon-source.tar.gz',`video-${process.platform}-${process.arch}-relink.tar.gz`];
 const notice=Buffer.from('Video component corresponding source and relink materials\n\nThe addon glue is MIT. FFmpeg '+pin.version+' is LGPL-2.1-or-later. QQ vendor licensing is unchanged.\nThis package uses the original compiled binary named in SOURCE-PROVENANCE.json.\nThe platform relink archive includes object files, static libraries, headers, flags, scripts and notices.\nFresh relink was tested with the preserved libraries; modified-library compatibility and byte-identical output have not been established.\n\n'+selected.map(name=>{const asset=binding.assets.find(a=>a.name===name);if(!asset)throw Error('Source notice material missing');return `${name}\n${asset.url}\nSHA256 ${asset.sha256}\n`;}).join('\n'));
 await writeFile(join(target,noticePath),notice);manifest.files.push({path:noticePath,url:noticePath,sha256:sha(notice),size:notice.length});
 manifest.videoCodec='video/video-codec.node';
}
