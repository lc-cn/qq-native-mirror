import {npm} from './npm.mjs';
import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
const sha=b=>createHash('sha256').update(b).digest('hex');
const relative=p=>{if(typeof p!=='string'||!p||isAbsolute(p)||p.includes('\\')||p.includes('\0')||p.split('/').some(s=>!s||s==='.'||s==='..'))throw new Error('Unsafe path');return p;};
const platform=process.platform,arch=process.arch;
const sources=JSON.parse(await readFile('ci/sources.json','utf8'));
const source=sources.find(s=>s.platform===platform&&s.arch===arch);
if(!source?.manifestUrl&&!source?.installerUrl)throw new Error(`No verified native source yet for ${platform}-${arch}; no placeholder package is produced`);
async function download(url,max=512*1024*1024){
 const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('HTTPS source required');
 const response=await fetch(url,{signal:AbortSignal.timeout(600000)});
 if(!response.ok||!response.body)throw new Error(`Download failed ${response.status}`);
 let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>max)throw new Error('Download too large');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);
}
const body=platform==='win32'?await readFile('out/windows-source/manifest.json'):await download(source.manifestUrl,1024*1024);if(platform!=='win32'&&sha(body)!==source.manifestSha256)throw new Error('Manifest hash mismatch');
const manifest=JSON.parse(body);
if(manifest.schemaVersion!==1||manifest.platform!==platform||manifest.arch!==(source.sourceArch??arch))throw new Error('Source device mismatch');
const sdk=JSON.parse(await readFile('sdk/package.json','utf8'));
const name=`qq-native-client-${platform}-${arch}`,target=resolve('out',name);
if(sdk.optionalDependencies[name]!==sdk.version)throw new Error('Main/auxiliary version pin mismatch');
if(['clientVersion','appId','qua'].some(key=>source.version[key]!==manifest.version[key]))throw new Error('Source version declaration mismatch');
await rm(target,{recursive:true,force:true});await mkdir(target,{recursive:true});
const groups=new Map();const paths=new Set();
for(const file of manifest.files){relative(file.path);if(paths.has(file.path))throw new Error('Duplicate manifest path');paths.add(file.path);if(!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid file hash');let list=groups.get(file.sha256);if(!list)groups.set(file.sha256,list=[]);list.push(file);}
if(!paths.has(relative(manifest.wrapper)))throw new Error('Missing wrapper');
const queue=[...groups];
await Promise.all(Array.from({length:4},async()=>{while(queue.length){const [hash,files]=queue.shift(),file=files[0];let data=platform==='win32'?await readFile(join('out/windows-source',relative(file.path))):await download(new URL(file.url,source.manifestUrl).href);if(file.encoding==='gzip'){if(sha(data)!==file.downloadSha256)throw new Error('Compressed checksum mismatch');data=gunzipSync(data,{maxOutputLength:512*1024*1024});}else if(file.encoding!==undefined)throw new Error('Unsupported encoding');if(sha(data)!==hash)throw new Error('Native checksum mismatch');for(const entry of files){const output=join(target,entry.path);await mkdir(dirname(output),{recursive:true});await writeFile(output,data);}}}));
if(platform==='darwin'){
 for(const files of groups.values()){
  const path=join(target,files[0].path);const bytes=await readFile(path);
  if(['cafebabe','bebafeca','cafebabf','bfbafeca'].includes(bytes.subarray(0,4).toString('hex'))){execFileSync('lipo',[path,'-thin',arch==='x64'?'x86_64':'arm64','-output',path+'.thin']);await copyFile(path+'.thin',path);await rm(path+'.thin');for(const file of files.slice(1))await copyFile(path,join(target,file.path));}
  if(['cffaedfe','cefaedfe','feedfacf','feedface'].includes(bytes.subarray(0,4).toString('hex'))||['cafebabe','bebafeca','cafebabf','bfbafeca'].includes(bytes.subarray(0,4).toString('hex'))){const detected=execFileSync('lipo',['-archs',path],{encoding:'utf8'}).trim();if(detected!==(arch==='x64'?'x86_64':'arm64'))throw new Error('Mixed Mach-O architecture');}
 }
}
manifest.arch=arch;manifest.id=`qq-${manifest.version.clientVersion}-${platform}-${arch}`;
for(const file of manifest.files){const data=await readFile(join(target,file.path));file.sha256=sha(data);file.size=data.length;file.url=file.path;delete file.encoding;delete file.downloadSha256;}
const bridgeName=platform==='win32'?'QQNT.dll':'registration-bridge.node';
const bridge=join('sdk/native',`${platform}-${arch}`,bridgeName);
await mkdir(join('out','bridges',`${platform}-${arch}`),{recursive:true});await copyFile(bridge,join('out','bridges',`${platform}-${arch}`,bridgeName));
await copyFile(bridge,join(target,bridgeName));if(!manifest.files.some(f=>f.path===bridgeName))manifest.files.push({path:bridgeName,url:bridgeName,sha256:sha(await readFile(bridge))});
await writeFile(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(join(target,'package.json'),JSON.stringify({name,version:sdk.version,description:`QQ native runtime for ${platform} ${arch}`,os:[platform],cpu:[arch],...(platform==='linux'?{libc:['glibc']}:{}),engines:{node:manifest.nodeVersion?.slice(1)??'>=24'},exports:{'./manifest.json':'./manifest.json'},files:manifest.files.map(f=>f.path).concat('manifest.json','README.md'),repository:{type:'git',url:'git+https://github.com/lc-cn/qq-native-mirror.git'},license:'UNLICENSED'},null,2)+'\n');
await writeFile(join(target,'README.md'),`# ${name}\n\nKernel ${manifest.version.clientVersion}. Built and byte-verified by GitHub Actions. Proprietary vendor binaries.\n`);
execFileSync(npm[0],[...npm[1],'pack','--ignore-scripts','--pack-destination',resolve('out'),'--json'],{cwd:target,stdio:'inherit'});
await writeFile('out/build.json',JSON.stringify({platform,arch,name,sdkVersion:sdk.version,kernelVersion:manifest.version.clientVersion,sourceManifestSha256:sha(body),files:manifest.files.length},null,2));
