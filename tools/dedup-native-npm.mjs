import {readFile,writeFile,mkdir,lstat,mkdtemp,rm,copyFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {validateRelease} from '../sdk/scripts/local-first-publish.mjs';
import {npm} from '../ci/npm.mjs';
import {readNativeTarFiles} from '../sdk/scripts/native-tar-files.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),workspace=resolve(repo,'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const safe=p=>typeof p==='string'&&p&&!/[\\\0:\r\n]/.test(p)&&!p.startsWith('/')&&!p.split('/').some(s=>!s||s==='.'||s==='..');
/** sourceMap includes every regular tar member (relative to package/), not an inferred filesystem scan. */
export async function stageDeduplicatedPackage(sourceMap,destination){
 const {metadata,manifest,files}=sourceMap;
 check(manifest?.schemaVersion===1&&['darwin'].includes(manifest.platform)&&['arm64','x64'].includes(manifest.arch)&&manifest.npmStorage===undefined,'Unsupported source manifest');
 check(metadata?.name===`qq-native-client-${manifest.platform}-${manifest.arch}`&&metadata.version==='0.0.2'&&JSON.stringify(metadata.os)===JSON.stringify([manifest.platform])&&JSON.stringify(metadata.cpu)===JSON.stringify([manifest.arch]),'Source npm identity mismatch');
 check(!metadata.scripts||Object.keys(metadata.scripts).length===0,'Source scripts are not permitted');
 check(manifest.version&&['clientVersion','appId','qua'].every(k=>typeof manifest.version[k]==='string'&&manifest.version[k]),'Missing vendor version');
 check(files instanceof Map&&Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=4096,'Missing complete source map');
 const names=new Set();for(const file of manifest.files){check(file&&safe(file.path)&&!['manifest.json','package.json','README.md'].includes(file.path)&&!names.has(file.path)&&/^[a-f0-9]{64}$/.test(file.sha256),'Invalid inventory path/digest');names.add(file.path);}
 for(const name of names){const parts=name.split('/');for(let i=1;i<parts.length;i++)check(!names.has(parts.slice(0,i).join('/')),'Native file path collision');}
 const expected=new Set([...names,'manifest.json','package.json','README.md']);check(files.size===expected.size&&[...files.keys()].every(p=>expected.has(p)),'Tar member inventory is not closed');
 check(JSON.stringify(JSON.parse(files.get('manifest.json')))==JSON.stringify(manifest)&&JSON.stringify(JSON.parse(files.get('package.json')))==JSON.stringify(metadata),'Tar metadata differs from source map');
 check(safe(manifest.wrapper)&&names.has(manifest.wrapper)&&safe(manifest.videoCodec)&&names.has(manifest.videoCodec)&&names.has('video/SOURCE-PROVENANCE.json'),'Required wrapper/video provenance missing');
 const objects=new Map(),inventory=[];let originalBytes=0;
 for(const file of manifest.files){check(file.encoding===undefined&&file.downloadSha256===undefined,'Source compressed delivery semantics are unsupported');const bytes=files.get(file.path);check(Buffer.isBuffer(bytes)&&bytes.length<=512*1024*1024&&sha(bytes)===file.sha256&&(file.size===undefined||file.size===bytes.length),'Source byte hash/size mismatch');originalBytes+=bytes.length;check(originalBytes<=2*1024**3,'Source total runtime bytes exceed bound');inventory.push({...file,size:bytes.length,url:file.path});if(!objects.has(file.sha256)){const gzip=gzipSync(bytes,{level:6,mtime:0});check(gzip.length<=512*1024**2,'Compressed object exceeds bound');objects.set(file.sha256,{path:`objects/${file.sha256}.gz`,sha256:file.sha256,downloadSha256:sha(gzip),size:bytes.length,downloadSize:gzip.length,bytes:gzip});}else check(bytes.equals(gunzipSync(objects.get(file.sha256).bytes,{maxOutputLength:512*1024**2})),'Raw SHA object collision');}
 check(objects.size<=4096,'Object count exceeds bound');
 const sorted=[...objects.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256));
 await mkdir(destination);await mkdir(join(destination,'objects'));for(const object of sorted)await writeFile(join(destination,object.path),object.bytes,{flag:'wx'});
 const output={...manifest,files:inventory,npmStorage:{format:'gzip-objects-v1',objects:sorted.map(({bytes,...o})=>o)}};
 const pkg={...metadata,description:'Experimental full-inventory gzip-object storage; cache hydration requires compatible SDK',files:[...sorted.map(o=>o.path),'manifest.json','README.md']};delete pkg.scripts;
 await writeFile(join(destination,'manifest.json'),JSON.stringify(output,null,2)+'\n');await writeFile(join(destination,'package.json'),JSON.stringify(pkg,null,2)+'\n');await writeFile(join(destination,'README.md'),'# Experimental deduplicated full native inventory\n\nAll original runtime paths, CodeResources and bytes are retained in SHA-bound gzip objects. Requires an SDK supporting gzip-objects-v1 cache hydration. QQ vendor licensing is unchanged; decoded video license/notices/provenance and permanent source/relink references remain in the full restored inventory. No account, business, signing-authenticity or production acceptance is established.\n');
 return{manifest:output,nativeManifestSha256:sha(await readFile(join(destination,'manifest.json'))),originalPaths:names.size,uniqueObjects:sorted.length,originalBytes,uniqueRawBytes:sorted.reduce((s,o)=>s+o.size,0),gzipObjectBytes:sorted.reduce((s,o)=>s+o.downloadSize,0)};
}
async function sourceFiles(tar){const original=await readNativeTarFiles(tar,{maxArchiveBytes:2*1024**3,maxFileBytes:512*1024**2,maxMembers:10000}),files=new Map();for(const [path,bytes] of original){check(path.startsWith('package/')&&safe(path.slice(8)),'Tar file must be inside package');files.set(path.slice(8),bytes);}return files;}
async function sourceTar(tar){const files=await sourceFiles(tar);return{metadata:JSON.parse(files.get('package.json')),manifest:JSON.parse(files.get('manifest.json')),files};}
export async function buildCandidate(device,outputDirectory,sourceDirectory=join(workspace,'.local/releases/npm-0.0.2-ci-37962268125')){
 check(['darwin-arm64','darwin-x64'].includes(device),'Unsupported candidate device');
 const validated=await validateRelease(sourceDirectory),release=validated.manifest;
 check(release.schemaVersion===2&&release.commit==='6cae1ec0a5e1bfb03cb7871083915b3d03272347'&&release.runId==='37962268125'&&release.runAttempt===1&&release.version==='0.0.2'&&validated.videoMaterials?.pending===false,'Source complete release/materials identity mismatch');
 const releaseBytes=await readFile(join(sourceDirectory,'release-manifest.json'));check(sha(releaseBytes)==='9a362f3c4abada4c8cfc397039c20835bcb5393e0ae356873cccb518be9c8e1a','Source release bytes mismatch');
 const row=release.packages.find(p=>p.name==='qq-native-client-'+device),expected=device==='darwin-arm64'?'a3c633ad5fc13082b5b8ffa7aa3e09b9a9d37708300bf5df3ea66bd0daa729df':'b69b9c0709c2afe10a4857d96aa3a0d88e599b53fbd7f19304a40e1077fcfbfd';check(row.manifestSha256===expected,'Native source manifest mismatch');
 const source=await sourceTar(join(sourceDirectory,row.tarball));check(source.manifest.files.length===1168,'Source full inventory mismatch');const scratch=await mkdtemp(join(tmpdir(),'qq-dedup-pack-'));
 try{const directory=join(scratch,'package');const staged=await stageDeduplicatedPackage(source,directory);await mkdir(outputDirectory);const packed=JSON.parse(execFileSync(npm[0],[...npm[1],'pack','--ignore-scripts','--offline','--cache',join(scratch,'npm-cache'),'--pack-destination',resolve(outputDirectory),'--json'],{cwd:directory,encoding:'utf8',maxBuffer:32*1024*1024}))[0];check(packed.filename===row.tarball&&packed.files.length===staged.uniqueObjects+3,'Packed member count mismatch');
  // Pack list/hash verification is followed by independent packed-object restore below.
  const packedFiles=await sourceFiles(join(outputDirectory,packed.filename));check(packedFiles.size===staged.uniqueObjects+3&&sha(packedFiles.get('manifest.json'))===staged.nativeManifestSha256,'Packed manifest or inventory changed');
  for(const object of staged.manifest.npmStorage.objects){const bytes=packedFiles.get(object.path);check(sha(bytes)===object.downloadSha256&&bytes.length===object.downloadSize,'Packed gzip differs');const restored=gunzipSync(bytes,{maxOutputLength:512*1024*1024});check(sha(restored)===object.sha256&&restored.length===object.size,'Packed restore differs');for(const file of staged.manifest.files.filter(f=>f.sha256===object.sha256))check(restored.equals(source.files.get(file.path)),'Original path byte mismatch');}
  const tarBytes=await readFile(join(outputDirectory,packed.filename));const {manifest,...measured}=staged;const receipt={schemaVersion:1,experimental:true,device,sourceRelease:{repository:release.repository,commit:release.commit,runId:release.runId,runAttempt:release.runAttempt,releaseManifestSha256:sha(releaseBytes)},sourceTarballSha256:row.sha256,sourceTarballBytes:row.size,sourceNativeManifestSha256:expected,...measured,tarball:packed.filename,tarballSha256:sha(tarBytes),tarballBytes:tarBytes.length,packedPaths:packed.files.length,allOriginalBytesRestored:true,videoMaterials:release.videoMaterials,accountAcceptanceEstablished:false,signingAuthenticityEstablished:false,installedHydrationVerified:false,nativeExecuted:false,published:false,defaultsChanged:false};receipt.source={...receipt.sourceRelease,auxiliary:{tarball:row.tarball,sha256:row.sha256,size:row.size,nativeManifestSha256:expected}};receipt.candidate={tarball:packed.filename,sha256:sha(tarBytes),size:tarBytes.length,nativeManifestSha256:staged.nativeManifestSha256,nativePaths:staged.originalPaths,objectCount:staged.uniqueObjects};await writeFile(join(outputDirectory,'source-native-manifest.json'),source.files.get('manifest.json'));await writeFile(join(outputDirectory,'source-release-manifest.json'),releaseBytes);await writeFile(join(outputDirectory,'dedup-build.json'),JSON.stringify(receipt,null,2)+'\n');await copyFile(join(directory,'manifest.json'),join(outputDirectory,'native-manifest.json'));return receipt;
 }finally{await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),options={};check(args.length%2===0,'Usage: node tools/dedup-native-npm.mjs --device darwin-arm64|darwin-x64 [--source DIR --out DIR]');for(let i=0;i<args.length;i+=2){check(['--device','--source','--out'].includes(args[i])&&options[args[i]]===undefined,'Invalid/duplicate argument');options[args[i]]=args[i+1];}check(options['--device'],'Device required');const out=options['--out']??join(workspace,`.local/releases/dedup-full-${options['--device']}-local-v1`);console.log(JSON.stringify(await buildCandidate(options['--device'],out,options['--source']),null,2));
}
