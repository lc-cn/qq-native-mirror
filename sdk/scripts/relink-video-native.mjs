import {readFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
const [bundleArg,libraryArg,outputArg]=process.argv.slice(2);
if(!bundleArg||!libraryArg||!outputArg)throw Error('Usage: node relink-video-native.mjs RELINK_DIRECTORY FFMPEG_LIBRARY_DIRECTORY OUTPUT_NODE');
const bundle=resolve(bundleArg),libraries=resolve(libraryArg),output=resolve(outputArg);
const build=JSON.parse(await readFile(join(bundle,'build.json'),'utf8'));
if(build.platform!==process.platform||build.arch!==process.arch)throw Error('Relink materials belong to another platform');
await mkdir(dirname(output),{recursive:true});
const names=['avformat','avcodec','swscale','avutil'];
const extra=build.systemLinkFlags;
if(!Array.isArray(extra)||!extra.every(v=>typeof v==='string'))throw Error('Missing system linker configuration');
let compiler,args;
if(process.platform==='win32') {
  const cl=execFileSync('where.exe',['cl'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];compiler=join(dirname(cl),'link.exe');
  args=['/nologo','/DLL','/OPT:REF',join(bundle,'video-codec.obj'),...names.map(n=>join(libraries,n+'.lib')),join(bundle,'node.lib'),...Array.from(new Set(extra)).map(f=>f.startsWith('-l')?f.slice(2)+'.lib':f),'/OUT:'+output];
}else {
  compiler=process.platform==='darwin'?'clang++':'c++';
  args=[...(process.platform==='darwin'?['-dynamiclib','-undefined','dynamic_lookup','-Wl,-exported_symbol,_napi_register_module_v1','-Wl,-exported_symbol,_node_api_module_get_api_version_v1']:['-shared','-Wl,--exclude-libs,ALL']),join(bundle,'video-codec.o'),...names.map(n=>join(libraries,'lib'+n+'.a')),...extra,'-o',output];
}
execFileSync(compiler,args,{stdio:'inherit'});
if(process.platform==='darwin')execFileSync('codesign',['--force','--sign','-',output],{stdio:'inherit'});
console.log(JSON.stringify({relinked:output,platform:process.platform,arch:process.arch}));
