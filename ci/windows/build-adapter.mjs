import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
if(process.platform!=='win32'||process.version!=='v24.20.0')throw new Error('Windows internal adapter requires official Node 24.20.0');
const sha=b=>createHash('sha256').update(b).digest('hex');
const base=`https://nodejs.org/dist/${process.version}/`;
const sums=await (await fetch(base+'SHASUMS256.txt')).text();
async function official(path,output){const expected=sums.split('\n').find(l=>l.trim().endsWith(' '+path))?.split(/\s+/)[0];if(!/^[a-f0-9]{64}$/.test(expected??''))throw new Error('Official checksum missing '+path);let cached;try{cached=await readFile(output);}catch{}if(cached&&sha(cached)===expected)return expected;const r=await fetch(base+path,{signal:AbortSignal.timeout(600000)});if(!r.ok)throw new Error('Node artifact unavailable');const data=Buffer.from(await r.arrayBuffer());if(sha(data)!==expected)throw new Error('Node artifact hash mismatch');await writeFile(output,data);return expected;}
await mkdir('out/node-internals',{recursive:true});
const archive=`node-${process.version}.tar.gz`;const sourceHash=await official(archive,'out/node-internals/source.tar.gz');
await official(`win-${process.arch}/node.lib`,'out/node-internals/node.lib');
execFileSync('tar',['-xzf','out/node-internals/source.tar.gz','-C','out/node-internals'],{stdio:'inherit'});
const root=resolve('out/node-internals',`node-${process.version}`);
const report=JSON.parse(await readFile('out/windows-source/dependency-report.json','utf8'));
// All imports except the single implemented stopping-state adapter must really exist in this Node binary.
const filter={...report,requiredQQNTExports:report.requiredQQNTExports.filter(n=>n!=='?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z')};
await writeFile('out/node-internals/forwarder-report.json',JSON.stringify(filter));
execFileSync('python',['ci/windows/generate-windows-forwarder.py','out/node-internals/forwarder-report.json',process.execPath,'out/QQNT.def'],{stdio:'inherit'});
await writeFile('out/QQNT.def',(await readFile('out/QQNT.def','utf8'))+' ?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z=qq_node_environment_stopping\n');
const vars=process.config.variables;
if(!vars.node_use_openssl||!vars.v8_enable_inspector)throw new Error('Unexpected official Node feature configuration');
const includes=['src','deps/v8/include','deps/uv/include','deps/simdjson','deps/simdutf','deps/sqlite','deps/openssl/openssl/include','deps/openssl/config','deps/openssl/config/archs/'+(process.arch==='x64'?'VC-WIN64A':'VC-WIN64-ARM')+'/'+(process.arch==='arm64'||vars.openssl_no_asm?'no-asm':'asm')+'/include'];
// This DLL consumes Node exports. node.h otherwise defaults to dllexport on Windows,
// using the correct import attributes for Node's public API.
// simdjson.gyp builds static linkage by default; there is no SIMDJSON_STATIC macro to add.
const args=['/nologo','/LD','/std:c++20','/Zc:__cplusplus','/Zc:inline','/EHsc','/MD','/O2','/Gy','/Gw','/DNOMINMAX','/D_ITERATOR_DEBUG_LEVEL=0','/DBUILDING_NODE_EXTENSION=1','/DNODE_WANT_INTERNALS=1','/DHAVE_INSPECTOR=1','/DHAVE_OPENSSL=1','/DNODE_USE_V8_PLATFORM=1',`/DHAVE_SQLITE=${vars.node_use_sqlite?1:0}`,`/DHAVE_AMARO=${vars.node_use_amaro?1:0}`];
if(vars.v8_enable_pointer_compression)args.push('/DV8_COMPRESS_POINTERS');if(vars.v8_enable_sandbox)args.push('/DV8_ENABLE_SANDBOX');
// MSVC command-line defaults /Zc:inline off. Suppress unreferenced inline COMDATs
// before linking; /OPT:REF alone does not prevent their unresolved references.
// Internal Node headers retain simdjson inline references even with /Zc:inline.
// Link the genuine implementation from this same checksum-verified Node source.
args.push(...includes.map(p=>'/I'+join(root,p)),resolve('ci/windows/environment-stopping.cc'),join(root,'deps/simdjson/simdjson.cpp'),'/link','/OPT:REF',resolve('out/node-internals/node.lib'),'/DEF:'+resolve('out/QQNT.def'),'/OUT:'+resolve('out/windows-source/QQNT.dll'));
execFileSync('cl',args,{stdio:'inherit'});
const probeArgs=['/nologo','/LD','/std:c++20','/Zc:__cplusplus','/Zc:inline','/EHsc','/MD','/O2','/Gy','/Gw','/DNOMINMAX','/D_ITERATOR_DEBUG_LEVEL=0','/DBUILDING_NODE_EXTENSION=1',...includes.map(p=>'/I'+join(root,p)),resolve('ci/windows/verify-stopping.cc'),'/link','/OPT:REF',resolve('out/node-internals/node.lib'),'/OUT:'+resolve('out/verify-stopping.node')];
execFileSync('cl',probeArgs,{stdio:'inherit'});
const transition=execFileSync(process.execPath,['-e',`require(${JSON.stringify(resolve('out/verify-stopping.node'))}).verify()`],{encoding:'utf8',env:{...process.env,QQ_STOPPING_ADAPTER_DLL:resolve('out/windows-source/QQNT.dll')}});
console.log(transition);await writeFile('out/windows-stopping-transition.json',transition);
if(!JSON.parse(transition).passed)throw new Error('Real stopping transition failed');
const manifest=JSON.parse(await readFile('out/windows-source/manifest.json','utf8'));
manifest.nodeVersion=process.version;manifest.nodeConfigSha256=sha(JSON.stringify(process.config));
manifest.files.push({path:'QQNT.dll',url:'QQNT.dll',sha256:sha(await readFile('out/windows-source/QQNT.dll'))});
await writeFile('out/windows-source/manifest.json',JSON.stringify(manifest,null,2));
await mkdir(`sdk/native/win32-${process.arch}`,{recursive:true});await copyFile('out/windows-source/QQNT.dll',`sdk/native/win32-${process.arch}/QQNT.dll`);
await writeFile('out/windows-adapter-build.json',JSON.stringify({node:process.version,arch:process.arch,sourceSha256:sourceHash,nodeConfigSha256:manifest.nodeConfigSha256,exports:report.requiredQQNTExports.length,stoppingContract:'real Environment::is_stopping(), null environment/isolate => true',runtimeVerified:false},null,2));
