import {npm} from '../ci/npm.mjs';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const repository='lc-cn/qq-native-mirror';
let stage='candidate';
const devices=['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'];
const names=[...devices.map(device=>'qq-native-client-'+device),'qq-native-client'];
const check=(condition,message)=>{if(!condition)throw Error(message);};
async function boundedJson(url,token){
 const parsed=new URL(url);check(parsed.protocol==='https:','HTTPS required');
 const headers=token?{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'}:{};
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(30000)});check(response.ok,'Public metadata request failed');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;check(size<=8*1024*1024,'Metadata size exceeded');chunks.push(chunk);}return {bytes:Buffer.concat(chunks),json:JSON.parse(Buffer.concat(chunks))};
}
export function validateMetadata(manifest,metadata,version){
 check(manifest.schemaVersion===1&&manifest.version===version&&manifest.repository===repository&&manifest.packages?.length===7,'Candidate manifest identity mismatch');
 for(const name of names){const rows=manifest.packages.filter(row=>row.name===name);check(rows.length===1,'Candidate package missing/duplicate');const row=rows[0],pkg=metadata.get(name);check(row.version===version&&pkg?.name===name&&pkg.version===version&&pkg.dist?.integrity===row.integrity,'Public npm package identity/integrity mismatch');
 if(name==='qq-native-client')check(names.slice(0,6).every(dep=>pkg.optionalDependencies?.[dep]===version),'Main optional dependencies mismatch');
 else{const [os,cpu]=name.slice('qq-native-client-'.length).split('-');check(JSON.stringify(pkg.os)===JSON.stringify([os])&&JSON.stringify(pkg.cpu)===JSON.stringify([cpu]),'Public npm OS/CPU mismatch');if(os==='linux')check(JSON.stringify(pkg.libc)===JSON.stringify(['glibc']),'Public npm libc mismatch');if(os==='win32')check(pkg.engines?.node==='24.20.0','Public npm Windows Node engine mismatch');}}
}
export function validateLock(lock,manifest,platform,arch){
 for(const name of ['qq-native-client',`qq-native-client-${platform}-${arch}`]){const row=manifest.packages.find(row=>row.name===name),pkg=lock.packages?.[`node_modules/${name}`];check(pkg?.version===manifest.version&&pkg.integrity===row.integrity,'Installed lock integrity mismatch');check(new URL(pkg.resolved).origin==='https://registry.npmjs.org','Installed package did not resolve from official registry');}
}
async function main(){
 const [version,tag,mirrorFlag,...extra]=process.argv.slice(2);check(!extra.length&&(!mirrorFlag||mirrorFlag==='--mirror'),'Invalid mirror flag');check(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version??''),'Invalid version');const match=new RegExp(`^npm-v${version.replaceAll('.','\\.')}-ci-(\\d+)$`).exec(tag??'');check(match,'Invalid candidate tag');
 const runId=match[1];const api=path=>boundedJson(`https://api.github.com/repos/${repository}/${path}`,process.env.GH_TOKEN);
 const release=(await api(`releases/tags/${tag}`)).json,run=(await api(`actions/runs/${runId}`)).json;
 check(release.tag_name===tag&&release.prerelease===true&&release.draft===false&&run.status==='completed'&&run.conclusion==='success'&&['.github/workflows/native-npm.yml','.github/workflows/native-first-main.yml'].includes(run.path)&&String(run.id)===runId&&run.repository?.full_name===repository&&/^[a-f0-9]{40}$/.test(run.head_sha)&&release.target_commitish===run.head_sha,'Candidate release/CI mismatch');
 const assets=release.assets.filter(asset=>asset.name==='release-manifest.json');check(assets.length===1&&/^sha256:[a-f0-9]{64}$/.test(assets[0].digest),'Candidate manifest asset missing digest');
 const expected=`https://github.com/${repository}/releases/download/${tag}/release-manifest.json`;check(assets[0].browser_download_url===expected,'Unexpected manifest asset URL');
 const downloaded=await boundedJson(expected);check(downloaded.bytes.length===assets[0].size&&createHash('sha256').update(downloaded.bytes).digest('hex')===assets[0].digest.slice(7),'Candidate manifest asset digest mismatch');const manifest=downloaded.json;
 check(manifest.runId===runId&&manifest.commit===run.head_sha&&manifest.runAttempt===run.run_attempt,'Manifest CI provenance mismatch');
 stage='registry';const metadata=new Map();for(const name of names)metadata.set(name,(await boundedJson(`https://registry.npmjs.org/${name}/${version}`)).json);validateMetadata(manifest,metadata,version);
 const temp=await mkdtemp(join(tmpdir(),'qq-public-consumer-'));try{
 await writeFile(join(temp,'package.json'),JSON.stringify({name:'qq-public-consumer',private:true,type:'module'}));
 const env={...process.env};delete env.GH_TOKEN;delete env.GITHUB_TOKEN;delete env.NODE_AUTH_TOKEN;delete env.NPM_TOKEN;
 stage='install';execFileSync(npm[0],[...npm[1],'install',`qq-native-client@${version}`,'--registry=https://registry.npmjs.org/','--cache',join(temp,'fresh-cache'),'--ignore-scripts','--no-audit','--no-fund'],{cwd:temp,env,stdio:'inherit',timeout:240000});
 stage='lock';validateLock(JSON.parse(await readFile(join(temp,'package-lock.json'))),manifest,process.platform,process.arch);
 for(const device of devices){if(device===`${process.platform}-${process.arch}`)continue;let installed=true;try{await access(join(temp,'node_modules','qq-native-client-'+device));}catch(error){if(error.code!=='ENOENT')throw error;installed=false;}check(!installed,'Foreign platform package installed');}
 const nativeManifest=JSON.parse(await readFile(join(temp,'node_modules',`qq-native-client-${process.platform}-${process.arch}`,'manifest.json')));
 if(process.platform==='win32')check(nativeManifest.nodeVersion==='v24.20.0'&&process.version===nativeManifest.nodeVersion,'Installed Windows native Node version mismatch');
 stage='native';const consumer=`import {writeFile} from 'node:fs/promises';globalThis.fetch=()=>{throw Error('Mirror fallback forbidden');};const {createClient}=await import('qq-native-client');let client;try{client=await createClient({dataDir:${JSON.stringify(join(temp,'empty-account'))},autoReconnect:false,timeoutMs:30000});const exports=client.nativeExports.length;if(exports<80)throw Error('Native exports missing');await client.close();if(client.state!=='closed')throw Error('Client did not close');await writeFile('result.json',JSON.stringify({exports,prepared:true,closed:true,loginAttempted:false}));}finally{await client?.close();}`;
 await writeFile(join(temp,'consumer.mjs'),consumer);execFileSync(process.execPath,['consumer.mjs'],{cwd:temp,env,stdio:'inherit',timeout:120000});
 stage='cli';const help=execFileSync(process.execPath,['node_modules/qq-native-client/dist/cli.js','--help'],{cwd:temp,env,encoding:'utf8',timeout:30000});check(help.includes('group-kick')&&help.includes('--message-file'),'CLI help is missing expected commands');
 stage='receipt';const result=JSON.parse(await readFile(join(temp,'result.json')));await mkdir('public-out',{recursive:true});await writeFile('public-out/consumer.json',JSON.stringify({version,tag,runId,commit:manifest.commit,platform:process.platform,arch:process.arch,node:process.version,registry:'https://registry.npmjs.org/',publicMetadataMatched:true,packageLockIntegrityMatched:true,freshCache:true,installedMainOnly:true,automaticPlatformSelection:true,foreignPackagesAbsent:true,mirrorFallbackForbidden:true,cliHelp:true,...result},null,2));
 if(mirrorFlag==='--mirror'){
  stage='mirror';await mkdir('public-out',{recursive:true});
  await copyFile(new URL('./mirror-consumer.mjs',import.meta.url),join(temp,'mirror-consumer.mjs'));
  const mirrorOutput=resolve('public-out/mirror-consumer.json');
  const denyPath=resolve('first-ci/deny-symlink.cjs');
  execFileSync(process.execPath,['mirror-consumer.mjs',mirrorOutput],{cwd:temp,env:{...env,NODE_OPTIONS:`--require ${JSON.stringify(denyPath)}`},stdio:'inherit',timeout:1200000});
  const mirror=JSON.parse(await readFile(mirrorOutput));
  check(mirror.completed===true&&mirror.prepared===true&&mirror.closed===true&&mirror.device===`${process.platform}-${process.arch}`&&mirror.node===process.version&&mirror.noLogin===true&&mirror.freshCold===true&&mirror.symlinkCreationDenied===true&&mirror.hashValidatedLoader===true&&mirror.cacheFilesIndependentlyHashVerified===true&&mirror.nativeExports>=80&&mirror.first?.payloadRequests>0&&mirror.first.payloadBytes>0&&mirror.second?.payloadRequests===0&&mirror.second.payloadBytes===0,'Public mirror acceptance failed');
 }

 }finally{await rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(async()=>{console.error(`Public npm consumer validation failed at stage=${stage}; no login or publish performed.`);process.exitCode=1;await mkdir('public-out',{recursive:true});const output='public-out/consumer.json';try{await access(output);}catch{await writeFile(output,JSON.stringify({completed:false,prepared:false,closed:false,loginAttempted:false,failureStage:stage,platform:process.platform,arch:process.arch,node:process.version},null,2));}});
