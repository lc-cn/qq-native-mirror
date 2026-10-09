import {readFile,writeFile,readdir,lstat,mkdir,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function bundleVideoCodec(target,manifest){
 const base=resolve('out/video-codec'),runtime=join(base,'runtime');
 const pin=JSON.parse(await readFile('sdk/native/video/ffmpeg-source.json'));
 const build=JSON.parse(await readFile(join(runtime,'build.json')));
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
 const bytes=Buffer.from(JSON.stringify({schemaVersion:1,component:'Project-owned MIT Node addon with LGPL FFmpeg; QQ vendor licensing is unchanged',ffmpeg:pin,addonSourceSha256:build.addonSourceSha256,repository:process.env.GITHUB_REPOSITORY,commit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,producerArtifact:`video-${process.platform}-${process.arch}`,permanentMaterialsAvailable:false,distribution:'CI candidate only; archive and publication blocked pending permanent source/relink closure'},null,2)+'\n');
 await writeFile(join(target,path),bytes);manifest.files.push({path,url:path,sha256:sha(bytes),size:bytes.length});
 manifest.videoCodec='video/video-codec.node';
}
