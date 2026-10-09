import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat,realpath,lstat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readNativeTarFiles} from '../sdk/scripts/native-tar-files.mjs';
import {npm} from './npm.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
// This probe never loads QQ addons: prepareNative only verifies/materializes files.
assert.equal(process.platform,'darwin');assert.ok(['arm64','x64'].includes(process.arch));
assert.ok(process.argv.length<=4,'Usage: node ci/pruned-runtime-probe.mjs [OUT_DIR] [BINDING_PATH]');
const out=resolve(process.argv[2]??'out');
await assert.rejects(lstat(join(out,'pruned-runtime-cache-audio.json')),error=>error.code==='ENOENT','Receipt must be fresh');
const bindingPath=resolve(process.argv[3]??join(out,'input-binding.json'));
const bindingBytes=await readFile(bindingPath),binding=JSON.parse(bindingBytes);
assert.equal(binding.sdkCommit,'5907793ad848c68b3183ac5c2f2b06fbd1a5e0cf');
assert.equal(String(binding.sdkRun),'38000680198');
assert.equal(binding.nativeCommit,'6cae1ec0a5e1bfb03cb7871083915b3d03272347');
assert.equal(String(binding.nativeRun),'37962268125');
const main='qq-native-client-0.0.2.tgz',aux=`qq-native-client-darwin-${process.arch}-0.0.2.tgz`;
const mainBytes=await readFile(join(out,main)),auxBytes=await readFile(join(out,aux));
assert.equal(sha(mainBytes),binding.mainSha256);assert.equal(sha(auxBytes),binding.auxiliarySha256);
const profileBytes=await readFile(join(out,'pruning-profile.json')),profile=JSON.parse(profileBytes);
const canonicalProfile=await readFile(new URL(`../tools/profiles/darwin-${process.arch}-resources-codec-v2.json`,import.meta.url));
assert.equal(sha(profileBytes),sha(canonicalProfile));
assert.equal(profile.platform,'darwin');assert.equal(profile.arch,process.arch);
assert.equal(profile.files.length,58);assert.equal(new Set(profile.files.map(f=>f.path)).size,58);
const sourceBytes=await readFile(join(out,'source-release-manifest.json')),source=JSON.parse(sourceBytes);
assert.equal(sha(sourceBytes),profile.source.releaseManifestSha256);
assert.equal(source.commit,binding.nativeCommit);assert.equal(String(source.runId),String(binding.nativeRun));
const sourceAux=source.packages.find(p=>p.name===`qq-native-client-darwin-${process.arch}`);
assert.equal(sourceAux.sha256,profile.source.auxiliary.sha256);assert.equal(sourceAux.size,profile.source.auxiliary.size);
assert.equal(sourceAux.manifestSha256,profile.source.nativeManifestSha256);
const files=await readNativeTarFiles(join(out,aux));
const manifestBytes=files.get('package/manifest.json'),manifest=JSON.parse(manifestBytes);
assert.equal(manifest.files.length,58);assert.equal(manifest.files.filter(f=>f.path.startsWith('video/')).length,11);
assert.equal(manifest.platform,'darwin');assert.equal(manifest.arch,process.arch);
assert.deepEqual(manifest.version,profile.version);assert.equal(manifest.wrapper,'wrapper.node');assert.equal(manifest.videoCodec,profile.videoCodec);assert.equal(manifest.npmStorage,undefined);
assert.deepEqual(manifest.files.map(f=>({path:f.path,sha256:f.sha256,size:f.size})),profile.files.map(f=>({path:f.path,sha256:f.sha256,size:f.size})));
assert.deepEqual([...files.keys()].sort(),[...profile.files.map(f=>'package/'+f.path),'package/manifest.json','package/package.json','package/README.md'].sort());
for(const row of manifest.files){const bytes=files.get('package/'+row.path);assert.equal(bytes.length,row.size);assert.equal(sha(bytes),row.sha256);}
const auxiliaryMetadata=JSON.parse(files.get('package/package.json'));assert.equal(auxiliaryMetadata.name,`qq-native-client-darwin-${process.arch}`);assert.equal(auxiliaryMetadata.version,'0.0.2');assert.equal(Object.keys(auxiliaryMetadata.scripts??{}).length,0);
const root=join(out,'pruned-runtime-consumer');await mkdir(root);await writeFile(join(root,'package.json'),JSON.stringify({private:true,type:'module'}));
execFileSync(npm[0],[...npm[1],'install',join(out,main),join(out,'silk-wasm-3.7.1.tgz'),'--offline','--omit=optional','--ignore-scripts','--no-audit','--no-fund','--cache',join(root,'npm-cache')],{cwd:root,stdio:'pipe',timeout:120000});
await assert.rejects(lstat(join(root,'node_modules',`qq-native-client-darwin-${process.arch}`)),error=>error.code==='ENOENT','Optional native package unexpectedly installed');
const installed=join(root,'node_modules/qq-native-client');
const packed=await readNativeTarFiles(join(out,main));
for(const [path,body] of packed)assert.deepEqual(await readFile(join(installed,path.slice('package/'.length))),body);
const {prepareNative}=await import(pathToFileURL(join(installed,'dist/native-package.js')).href);
let phase='cold';const requests={cold:{metadata:0,payload:0,payloadBytes:0},warm:{metadata:0,payload:0,payloadBytes:0}};
const server=createServer((req,res)=>{
 let key;try{key=decodeURIComponent(req.url.slice(1));}catch{res.writeHead(400).end();return;}
 if(key==='manifest.json'){requests[phase].metadata++;res.setHeader('Content-Type','application/json');res.end(manifestBytes);return;}
 const row=manifest.files.find(f=>f.path===key);if(!row){res.writeHead(404).end();return;}
 const bytes=files.get('package/'+key);requests[phase].payload++;requests[phase].payloadBytes+=bytes.length;res.end(bytes);
});
await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
const origin=`http://127.0.0.1:${server.address().port}`;
const fetchOriginal=globalThis.fetch;globalThis.fetch=(url,...args)=>{const target=new URL(String(url));assert.equal(target.origin,origin,'Unexpected external fetch');assert.equal(target.username,'');assert.equal(target.password,'');return fetchOriginal(url,...args);};
let receipt;
try{
 const options={manifestUrl:origin+'/manifest.json',manifestSha256:sha(manifestBytes),cacheDir:join(root,'native-cache')};
 const cold=await prepareNative(options);const nativeRoot=await realpath(dirname(cold.wrapperPath));
 assert.ok(nativeRoot.startsWith(join(root,'native-cache')+'/'));
 const mtimes={};for(const row of manifest.files){const path=join(nativeRoot,row.path),bytes=await readFile(path);assert.equal(bytes.length,row.size);assert.equal(sha(bytes),row.sha256);mtimes[row.path]=(await stat(path)).mtimeMs;}
 const distinct=new Map(manifest.files.map(f=>[f.sha256,f]));assert.ok(distinct.size>0&&distinct.size<=58);assert.equal(requests.cold.payload,distinct.size);assert.equal(requests.cold.payloadBytes,[...distinct.values()].reduce((n,f)=>n+f.size,0));
 phase='warm';const warm=await prepareNative(options);assert.deepEqual(warm,cold);assert.equal(requests.warm.payload,0);assert.equal(requests.warm.payloadBytes,0);
 for(const row of manifest.files){const path=join(nativeRoot,row.path),bytes=await readFile(path);assert.equal(bytes.length,row.size);assert.equal(sha(bytes),row.sha256);assert.equal((await stat(path)).mtimeMs,mtimes[row.path]);}
 const {builtinRecordCodec}=await import(pathToFileURL(join(installed,'dist/builtin-record-codec.js')).href);
 const samples=4800,wav=Buffer.alloc(44+samples*2);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
 const input=join(root,'owned-silence.wav'),output=join(root,'owned-silence.silk');await writeFile(input,wav,{flag:'wx'});await builtinRecordCodec.convertToNTSilkTct(input,output);const seconds=await builtinRecordCodec.getDuration(output);assert.equal(seconds,0.2);
 receipt={schemaVersion:1,platform:process.platform,arch:process.arch,node:process.version,mainSha256:binding.mainSha256,auxiliarySha256:binding.auxiliarySha256,nativeManifestSha256:sha(manifestBytes),nativeFiles:58,distinctNativeContents:distinct.size,distinctNativeBytes:[...distinct.values()].reduce((n,f)=>n+f.size,0),allNativeBytesEqualProfile:true,sourceBinding:{...binding,bindingSha256:sha(bindingBytes),profileSha256:sha(profileBytes),sourceReleaseManifestSha256:sha(sourceBytes),mainSize:mainBytes.length,auxiliarySize:auxBytes.length,probeSha256:sha(await readFile(new URL(import.meta.url))),silkTarballSha256:sha(await readFile(join(out,'silk-wasm-3.7.1.tgz')))},allInstalledMainBytesEqualTarball:true,requests,allCachedFilesHashVerified:true,warmCacheReused:true,allWarmFileMtimesUnchanged:true,installedAuxiliaryUsed:false,localMirrorFixture:true,externalFetchAttempted:false,audio:{realWasmEncodeDecode:true,wavSha256:sha(wav),silkSha256:sha(await readFile(output)),decodedSeconds:seconds},nativeWrapperLoaded:false,accountUsed:false,loginAttempted:false,nativeSendAttempted:false,signingAuthenticityEstablished:false,published:false,defaultsChanged:false};
 await writeFile(join(out,'pruned-runtime-cache-audio.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receipt));
}finally{globalThis.fetch=fetchOriginal;server.closeAllConnections();await new Promise(ok=>server.close(ok));}
