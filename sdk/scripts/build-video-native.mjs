import { readFile,writeFile,mkdir,copyFile,readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { downloadNodeLicense } from './node-license-download.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=resolve(process.argv[2]??join(root,'.local/video-source-build'));
const pin=JSON.parse(await readFile(join(root,'native/video/ffmpeg-source.json'),'utf8'));
const source=join(directory,`ffmpeg-${pin.version}`),build=join(directory,'ffmpeg-build'),prefix=join(directory,'ffmpeg-install');
const sha=b=>createHash('sha256').update(b).digest('hex');
if(sha(await readFile(join(source,'configure')))!==pin.configureSha256||sha(await readFile(join(directory,`ffmpeg-${pin.version}.tar.xz`)))!==pin.sha256)throw Error('FFmpeg source identity mismatch');
// Resolve this small, hash-pinned build dependency before expensive compilation.
const nodeLicense=await downloadNodeLicense(process.version);
const nodeLicenseDownloader=await readFile(join(root,'scripts/node-license-download.mjs'));
const nodeLicenseDownloaderSha256=sha(nodeLicenseDownloader);
const nodeLicenseDownloaderNormalizedSha256=sha(Buffer.from(nodeLicenseDownloader.toString('utf8').replaceAll('\r\n','\n')));
for(const p of [build,prefix,join(directory,'runtime'),join(directory,'relink')])await mkdir(p,{recursive:true});
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const flags=['--disable-autodetect','--disable-gpl','--disable-nonfree','--disable-version3','--disable-asm','--disable-debug','--disable-doc','--disable-programs','--disable-shared','--enable-static','--enable-pic','--disable-network','--disable-avdevice','--disable-avfilter','--disable-swresample','--disable-encoders','--disable-muxers','--disable-demuxers','--enable-demuxer=mov','--disable-protocols','--enable-protocol=file','--disable-hwaccels'];
let configureArgs;
if(process.platform==='win32') {
  // Run from a GNU MSYS shell inheriting the selected VS /MT compiler target.
  const posix=p=>p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase());
  configureArgs=[posix(join(source,'configure')),'--prefix='+posix(prefix),'--toolchain=msvc','--arch='+(process.arch==='arm64'?'aarch64':'x86_64'),'--target-os=win32',...flags];
  run('bash',configureArgs,{cwd:build});
}else {configureArgs=[join(source,'configure'),'--prefix='+prefix,...flags];run('sh',configureArgs,{cwd:build});}
run('make',['-j',String(Math.min(availableParallelism(),8))],{cwd:build});run('make',['install'],{cwd:build});
const config=await readFile(join(build,'config.h'),'utf8');
for(const [name,value] of [['GPL',0],['NONFREE',0],['VERSION3',0],['NETWORK',0],['SHARED',0],['STATIC',1]])if(!config.includes(`#define CONFIG_${name} ${value}`))throw Error('Unexpected FFmpeg configuration: '+name);
// Use genuine Node headers. Windows also needs the official import library.
const headers=join(directory,'node-headers');await mkdir(headers,{recursive:true});
const base=`https://nodejs.org/dist/${process.version}/`;
const sums=await(await fetch(base+'SHASUMS256.txt',{signal:AbortSignal.timeout(60_000)})).text();
async function nodeArtifact(name,output) {
  const expected=sums.split('\n').find(l=>l.trim().endsWith(' '+name))?.split(/\s+/)[0];
  if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error('Node checksum unavailable');
  const response=await fetch(base+name,{signal:AbortSignal.timeout(300_000)});if(!response.ok)throw Error('Node artifact unavailable');const data=Buffer.from(await response.arrayBuffer());
  if(sha(data)!==expected)throw Error('Node artifact checksum mismatch');await writeFile(output,data);return expected;
}
const headerArchive=`node-${process.version}-headers.tar.gz`;const nodeHeadersSha256=await nodeArtifact(headerArchive,join(headers,'headers.tar.gz'));
run('tar',['-xzf','headers.tar.gz'],{cwd:headers});
const include=join(headers,`node-${process.version}`,'include/node');
const object=join(directory,'relink','video-codec'+(process.platform==='win32'?'.obj':'.o'));
const output=join(directory,'runtime','video-codec.node');
const src=join(root,'native/video/video-codec.cc');
const libs=['avformat','avcodec','swscale','avutil'];
const extra=[];
for(const name of libs) {
  const pc=await readFile(join(prefix,'lib/pkgconfig',`lib${name}.pc`),'utf8');
  for(const line of pc.split('\n').filter(l=>/^Libs(?:\.private)?:/.test(l))) {
    extra.push(...line.slice(line.indexOf(':')+1).trim().split(/\s+/).filter(f=>f&&!f.startsWith('-L')&&!libs.some(n=>f==='-l'+n)));
  }
}
// System linker flags come from the exact built FFmpeg .pc records, not guessed external codecs.
let compiler='cl',linker='link';
if(process.platform==='win32') {
  compiler=execFileSync('where.exe',['cl'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
  linker=join(dirname(compiler),'link.exe');
}
let compile,link,nodeImportSha256;
if(process.platform==='win32') {
  const nodeLib=join(directory,'relink','node.lib');nodeImportSha256=await nodeArtifact(`win-${process.arch}/node.lib`,nodeLib);
  compile=['/nologo','/c','/std:c++17','/EHsc','/MT','/O2','/DNOMINMAX','/DNAPI_VERSION=8','/DBUILDING_NODE_EXTENSION=1','/I'+include,'/I'+join(prefix,'include'),src,'/Fo:'+object];run(compiler,compile);
  link=['/nologo','/DLL','/OPT:REF',object,...libs.map(n=>join(prefix,'lib',n+'.lib')),nodeLib,...Array.from(new Set(extra)).map(f=>f.startsWith('-l')?f.slice(2)+'.lib':f),'/OUT:'+output];run(linker,link);
}else {
  compile=['-std=c++17','-O2','-fPIC','-fvisibility=hidden','-DNAPI_VERSION=8','-I'+include,'-I'+join(prefix,'include'),'-c',src,'-o',object];run(process.platform==='darwin'?'clang++':'c++',compile);
  const deps=[...libs.map(n=>join(prefix,'lib','lib'+n+'.a')),...extra];
  link=[...(process.platform==='darwin'?['-dynamiclib','-undefined','dynamic_lookup','-Wl,-exported_symbol,_napi_register_module_v1','-Wl,-exported_symbol,_node_api_module_get_api_version_v1']:['-shared','-Wl,--exclude-libs,ALL']),object,...deps,'-o',output];run(process.platform==='darwin'?'clang++':'c++',link);
  if(process.platform==='darwin')run('codesign',['--force','--sign','-',output]);
}
await copyFile(src,join(directory,'relink','video-codec.cc'));
for(const script of ['build-video-native.mjs','prepare-video-source.mjs','relink-video-native.mjs','node-license-download.mjs'])await copyFile(join(root,'scripts',script),join(directory,'relink',script));
await copyFile(join(headers,'headers.tar.gz'),join(directory,'relink','node-headers.tar.gz'));
await writeFile(join(directory,'runtime','NODE-LICENSE.txt'),nodeLicense);
await copyFile(join(root,'native/video/ffmpeg-source.json'),join(directory,'relink','ffmpeg-source.json'));
await copyFile(join(root,'native/video/LICENSE'),join(directory,'relink','ADDON-LICENSE.txt'));await copyFile(join(root,'native/video/LICENSE'),join(directory,'runtime','ADDON-LICENSE.txt'));
for(const file of ['LICENSE.md','COPYING.LGPLv2.1'])await copyFile(join(source,file),join(directory,'runtime','FFMPEG-'+file));
await writeFile(join(directory,'runtime','NOTICE.txt'),'Includes FFmpeg '+pin.version+' under LGPL-2.1-or-later; the addon glue is MIT. This software is based in part on the work of the Independent JPEG Group. No changes were made to FFmpeg jfdctfst.c, jfdctint_template.c or jrevdct.c. Corresponding source and relink materials must accompany distribution. Native video decoding does not prove QQ upload or signing authenticity.\n');
for(const file of await readdir(join(prefix,'lib')))if(/\.(a|lib)$/.test(file))await copyFile(join(prefix,'lib',file),join(directory,'relink',file));
for(const file of ['config.h','config_components.h','ffbuild/config.mak']){const target=join(directory,'relink',file.replaceAll('/','-'));await copyFile(join(build,file),target);}
const receipt={platform:process.platform,arch:process.arch,node:process.version,napiVersion:8,ffmpegVersion:pin.version,ffmpegCommit:pin.commit,sourceArchiveSha256:pin.sha256,addonSourceSha256:sha(await readFile(src)),binarySha256:sha(await readFile(output)),binaryBytes:(await readFile(output)).length,nodeHeadersSha256,nodeImportSha256,nodeLicenseSha256:sha(nodeLicense),nodeLicenseDownloaderSha256,nodeLicenseDownloaderNormalizedSha256,configureArgs,compileArgs:compile,linkArgs:link,systemLinkFlags:extra,configurationSha256:sha(config),accountUsed:false,qqWrapperLoaded:false,nativeSendAttempted:false};
await writeFile(join(directory,'runtime','build.json'),JSON.stringify(receipt,null,2)+'\n');await writeFile(join(directory,'relink','build.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({binary:output,binaryBytes:receipt.binaryBytes,platform:process.platform,arch:process.arch}));
