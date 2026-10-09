import {npm} from '../ci/npm.mjs';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,copyFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
const check=(condition,message)=>{if(!condition)throw Error(message);};
export function validateInstalled(lock,source,receipt){
 const main=source.main;
 check(source.repository==='lc-cn/qq-native-mirror'&&source.runId==='37890893656'&&source.tag==='npm-v0.0.1-ci-37890893656'&&source.commit==='9237a3a50329e5ce8d247c3f153003501cb7c349'&&main?.name==='qq-native-client'&&main.version==='0.0.1'&&main.size===236137&&main.sha256==='346bfee5895de2e0ef236cfb25d97654c8b773a5ec5adc67568b79e81301b11a','Corrected main source mismatch');
 check(lock.packages?.['node_modules/qq-native-client']?.integrity===main.integrity&&lock.packages['node_modules/qq-native-client'].version===main.version,'Installed main lock integrity mismatch');
 if(receipt)check(receipt.completed===true&&receipt.prepared===true&&receipt.closed===true&&receipt.device===`${process.platform}-${process.arch}`&&receipt.node===process.version&&receipt.noLogin===true&&receipt.freshCold===true&&receipt.symlinkCreationDenied===true&&receipt.hashValidatedLoader===true&&receipt.cacheFilesIndependentlyHashVerified===true&&receipt.nativeExports>=80&&receipt.first?.payloadRequests>0&&receipt.first.payloadBytes>0&&receipt.second?.payloadRequests===0&&receipt.second.payloadBytes===0,'Mirror cold/cache receipt failed');
}
async function main(){let stage='source',temp;const output=resolve('out/mirror-consumer.json');await mkdir('out',{recursive:true});
 try{
 const source=JSON.parse(await readFile('out/main-source.json'));const tarball=resolve('out',source.main.tarball);const bytes=await readFile(tarball);
 check(bytes.length===source.main.size&&createHash('sha256').update(bytes).digest('hex')===source.main.sha256&&'sha512-'+createHash('sha512').update(bytes).digest('base64')===source.main.integrity,'Main tarball bytes mismatch');
 temp=await mkdtemp(join(tmpdir(),'qq-mirror-consumer-'));await writeFile(join(temp,'package.json'),JSON.stringify({name:'mirror-cold-consumer',private:true,type:'module'}));
 const env={...process.env};for(const key of ['GH_TOKEN','GITHUB_TOKEN','NODE_AUTH_TOKEN','NPM_TOKEN','NODE_OPTIONS'])delete env[key];
 stage='install';execFileSync(npm[0],[...npm[1],'install',tarball,'--omit=optional','--ignore-scripts','--no-audit','--no-fund','--cache',join(temp,'fresh-cache'),'--registry=https://registry.npmjs.org/'],{cwd:temp,env,stdio:'inherit',timeout:240000});
 const lock=JSON.parse(await readFile(join(temp,'package-lock.json')));validateInstalled(lock,source);
 for(const name of ['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64']){let present=true;try{await access(join(temp,'node_modules',`qq-native-client-${name}`));}catch(error){if(error.code!=='ENOENT')throw error;present=false;}check(!present,'Auxiliary package installed');}
 stage='mirror';const defaultMode=process.env.QQ_MIRROR_MODE==='default';const catalog=JSON.parse(await readFile(defaultMode?'catalog.json':'catalog-gzip-v1.json'));const matches=catalog.packages.filter(p=>p.platform===process.platform&&p.arch===process.arch);matches.sort((a,b)=>b.version.clientVersion.localeCompare(a.version.clientVersion,'en',{numeric:true}));check(matches.length>0&&!matches.some((p,i)=>i>0&&p.version.clientVersion===matches[0].version.clientVersion),'Ambiguous expected mirror');const selected=matches[0];await copyFile('public-ci/mirror-consumer.mjs',join(temp,'mirror-consumer.mjs'));const deny=resolve('first-ci/deny-symlink.cjs');
 execFileSync(process.execPath,['mirror-consumer.mjs',output],{cwd:temp,env:{...env,QQ_EXPECTED_NATIVE_MANIFEST_SHA256:selected.manifestSha256,NODE_OPTIONS:`--require ${JSON.stringify(deny)}`},stdio:'inherit',timeout:1200000});
 const receipt=JSON.parse(await readFile(output));validateInstalled(lock,source,receipt);check(receipt.defaultCatalogMode===defaultMode&&receipt.catalog===(defaultMode?'catalog.json':'catalog-gzip-v1.json')&&receipt.expectedManifestPinned===true&&receipt.manifestSha256===selected.manifestSha256&&['clientVersion','appId','qua'].every(k=>receipt.version?.[k]===selected.version[k]),'Selected mirror identity mismatch');Object.assign(receipt,{success:true,currentRun:process.env.GITHUB_RUN_ID,sourceRun:source.runId,sourceCommit:source.commit,mainSha256:source.main.sha256,mainIntegrity:source.main.integrity,installedMainOnly:true,auxiliaryPackagesAbsent:true});await writeFile(output,JSON.stringify(receipt,null,2)+'\n');
 }catch{let existing={};try{existing=JSON.parse(await readFile(output));}catch{}await writeFile(output,JSON.stringify({...existing,success:false,currentRun:process.env.GITHUB_RUN_ID,failureStage:stage,noLogin:true},null,2)+'\n');process.exitCode=1;}
 finally{if(temp)await rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
