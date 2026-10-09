import {readFile,writeFile,mkdir,readdir,lstat,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {validateRelease} from './local-first-publish.mjs';
import {verifyVideoMaterialsOnline,videoTargets} from './video-materials.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),maxFile=512*1024*1024;
const check=(ok,message)=>{if(!ok)throw Error(message);};
const safe=p=>typeof p==='string'&&p.length>0&&!/[\\\0:\r\n\t]/.test(p)&&!p.startsWith('/')&&!p.split('/').some(s=>!s||s==='.'||s==='..');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Pure planner: all original runtime bytes remain intact; only delivery encoding changes. */
export function planCompressedNative(manifest,device,bytesFor,{tag,version,runId,runAttempt}){
 check(videoTargets.includes(device)&&manifest?.schemaVersion===1&&`${manifest.platform}-${manifest.arch}`===device,'Native device/schema mismatch');
 check(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.version&&['clientVersion','appId','qua'].every(k=>typeof manifest.version[k]==='string'&&manifest.version[k]),'Invalid native inventory/version');
 check(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)&&/^\d+$/.test(runId)&&Number.isSafeInteger(runAttempt)&&runAttempt>0&&tag===`native-npm-v${version}-ci-${runId}-attempt-${runAttempt}`,'Invalid mirror identity');
 const names=new Set();for(const f of manifest.files){check(f&&safe(f.path)&&f.path!=='manifest.json'&&!names.has(f.path)&&digest(f.sha256),'Unsafe/duplicate native file');names.add(f.path);}
 for(const name of names){const parts=name.split('/');for(let i=1;i<parts.length;i++)check(!names.has(parts.slice(0,i).join('/')),'Native file/directory collision');}
 check(safe(manifest.wrapper)&&names.has(manifest.wrapper)&&safe(manifest.videoCodec)&&names.has(manifest.videoCodec)&&names.has('video/SOURCE-PROVENANCE.json'),'Missing wrapper/codec/provenance');
 if(manifest.platform==='win32')check(manifest.nodeVersion==='v24.20.0'&&digest(manifest.nodeConfigSha256)&&names.has('QQNT.dll')&&names.has('NODE-LICENSE.txt'),'Missing Windows internal ABI constraint/license');
 const assets=new Map(),files=[];
 for(const file of manifest.files){const bytes=bytesFor(file.path);check(Buffer.isBuffer(bytes)&&bytes.length<=maxFile&&sha(bytes)===file.sha256&&(file.size===undefined||file.size===bytes.length),'Native file digest/size mismatch');
  let asset=assets.get(file.sha256);if(!asset){const compressed=gzipSync(bytes,{level:6,mtime:0});asset={name:file.sha256+'.gz',size:compressed.length,sha256:sha(compressed),rawSha256:file.sha256,rawSize:bytes.length,bytes:compressed};assets.set(file.sha256,asset);}
  files.push({...file,size:bytes.length,url:`https://github.com/lc-cn/qq-native-mirror/releases/download/${tag}/${asset.name}`,encoding:'gzip',downloadSha256:asset.sha256});
 }
 const identity=`npm-${version}-ci-${runId}-attempt-${runAttempt}-${device}-codec-gzip-v1`;
 const output={...manifest,id:identity,files};const body=Buffer.from(JSON.stringify(output,null,2)+'\n'),manifestSha256=sha(body),repoPath=`packages/${identity}/${manifestSha256}/manifest.json`;
 return {manifest:output,body,manifestSha256,repoPath,assets:[...assets.values()]};
}
async function regular(path){check((await lstat(path)).isFile(),'Regular file required');return readFile(path);}
export async function prepareNpmNativeMirror(releaseDir,outDir,{verifyOnline=verifyVideoMaterialsOnline}={}){
 const requested=resolve(releaseDir);check((await lstat(requested)).isDirectory(),'Release must be a regular directory');const input=await realpath(requested);
 const output=resolve(outDir);check(output!==input&&!output.startsWith(input+sep)&&!input.startsWith(output+sep),'Input/output may not contain each other');
 await mkdir(output,{recursive:true});check((await lstat(output)).isDirectory(),'Output must be a regular directory');const out=await realpath(output);
 check(out!==input&&!out.startsWith(input+sep)&&!input.startsWith(out+sep),'Input/output may not contain each other');check((await readdir(out)).length===0,'Output must be empty');
 const validated=await validateRelease(input),release=validated.manifest;
 check(validated.videoMaterials&&!validated.videoMaterialsPending&&validated.videoMaterials.pending===false,'Complete codec materials closure required');await verifyOnline(validated.videoMaterials);check(validated.videoMaterials.onlineVerified===true,'Online materials verification required');
 check(release.repository==='lc-cn/qq-native-mirror'&&release.packages.length===7,'Complete seven-package release required');
 const tag=`native-npm-v${release.version}-ci-${release.runId}-attempt-${release.runAttempt}`,packages=[],assets=new Map();
 // Build the full plan in memory before writing any candidate payload.
 for(const device of videoTargets){const row=release.packages.find(p=>p.name==='qq-native-client-'+device);check(row,'Missing native package');
  check(safe(row.tarball),'Unsafe source tarball');const tar=join(input,row.tarball);await regular(tar);
  const listed=execFileSync('tar',['-tf',tar],{maxBuffer:32*1024*1024}).toString().trimEnd().split('\n');
  const verbose=execFileSync('tar',['-tvf',tar],{maxBuffer:32*1024*1024}).toString().trimEnd().split('\n');
  check(listed.length===verbose.length,'Ambiguous tar member listing');const members=new Map();
  for(let i=0;i<listed.length;i++){const name=listed[i].replace(/\/$/,'');check(safe(name)&&(name==='package'||name.startsWith('package/'))&&!members.has(name)&&['-','d'].includes(verbose[i][0]),'Unsafe/duplicate/nonregular tar member');members.set(name,verbose[i][0]);}
  check(members.get('package/manifest.json')==='-','Native manifest must be a regular tar member');
  const manifestBytes=execFileSync('tar',['-xOf',tar,'package/manifest.json'],{maxBuffer:32*1024*1024});check(sha(manifestBytes)===row.manifestSha256,'Source manifest mismatch');
  const manifest=JSON.parse(manifestBytes),plan=planCompressedNative(manifest,device,path=>{check(members.get(`package/${path}`)==='-','Native inventory member must be regular');return execFileSync('tar',['-xOf',tar,`package/${path}`],{maxBuffer:maxFile});},{tag,version:release.version,runId:release.runId,runAttempt:release.runAttempt});
  for(const asset of plan.assets){const old=assets.get(asset.name);check(!old||old.sha256===asset.sha256,'Compressed asset collision');assets.set(asset.name,asset);}
  packages.push({platform:manifest.platform,arch:manifest.arch,version:manifest.version,sourceTarballSha256:row.sha256,sourceManifestSha256:row.manifestSha256,manifestPath:`manifests/${device}.json`,repoPath:plan.repoPath,manifestSha256:plan.manifestSha256,body:plan.body});
 }
 await mkdir(join(out,'assets'));await mkdir(join(out,'manifests'));
 for(const asset of assets.values())await writeFile(join(out,'assets',asset.name),asset.bytes,{flag:'wx'});
 for(const p of packages)await writeFile(join(out,p.manifestPath),p.body,{flag:'wx'});
 const plan={schemaVersion:1,repository:release.repository,sourceRelease:{commit:release.commit,runId:release.runId,runAttempt:release.runAttempt,version:release.version,releaseManifestSha256:sha(await regular(join(input,'release-manifest.json')))},tag,assets:[...assets.values()].map(({bytes,...a})=>a),packages:packages.map(({body,...p})=>p),catalogUpdates:{schemaVersion:1,packages:packages.map(p=>({platform:p.platform,arch:p.arch,version:p.version,manifestUrl:`https://raw.githubusercontent.com/${release.repository}/main/${p.repoPath}`,manifestSha256:p.manifestSha256}))},uploaded:false,catalogChanged:false,nativeExecuted:false};
 await writeFile(join(out,'mirror-plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});return plan;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){check(process.argv.length===4,'Usage: node scripts/prepare-npm-native-mirror.mjs RELEASE_DIR OUT_DIR');const p=await prepareNpmNativeMirror(process.argv[2],process.argv[3]);console.log(JSON.stringify({tag:p.tag,packages:p.packages.length,assets:p.assets.length,uploaded:false}));}
