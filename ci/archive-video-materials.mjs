import {readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const directory=resolve(process.argv[2]??'video-materials');
const env=process.env,repository=env.GITHUB_REPOSITORY,commit=env.GITHUB_SHA,runId=env.GITHUB_RUN_ID,runAttempt=Number(env.GITHUB_RUN_ATTEMPT);
if(!/^[\w.-]+\/[\w.-]+$/.test(repository??'')||!/^[a-f0-9]{40}$/.test(commit??'')||!/^\d+$/.test(runId??'')||!Number.isSafeInteger(runAttempt)||runAttempt<1)throw Error('Invalid CI identity');
const {version}=JSON.parse(await readFile('sdk/package.json'));if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))throw Error('Unsafe version');
if(!(await lstat(directory)).isDirectory()||!(await lstat(join(directory,'video-materials.json'))).isFile())throw Error('Materials must be regular files');
const reportBytes=await readFile(join(directory,'video-materials.json')),report=JSON.parse(reportBytes);
if(report.schemaVersion!==1||report.archiveExtractionInventoryVerified!==true||report.nativeExecuted!==false||report.accountUsed!==false||report.assets?.length!==11||report.platforms?.length!==6)throw Error('Invalid materials receipt');
const sha=b=>createHash('sha256').update(b).digest('hex');
const assets=[];for(const asset of [...report.assets,{path:'video-materials.json',size:reportBytes.length,sha256:sha(reportBytes)}]){
 if(typeof asset.path!=='string'||!/^[\w.-]+$/.test(asset.path)||assets.some(a=>a.name===asset.path))throw Error('Unsafe or duplicate material asset');
 if(!(await lstat(join(directory,asset.path))).isFile())throw Error('Material asset must be a regular file');
 const bytes=await readFile(join(directory,asset.path));if(bytes.length!==asset.size||sha(bytes)!==asset.sha256)throw Error('Material asset differs from inventory');assets.push({name:asset.path,size:bytes.length,sha256:sha(bytes)});
}
const tag=`video-npm-v${version}-ci-${runId}-attempt-${runAttempt}`;
const gh=(args)=>execFileSync('gh',args,{encoding:'utf8',maxBuffer:8*1024*1024});
// One create attempt only. An uncertain failure requires manual reconciliation; never edit/retry a release.
gh(['release','create',tag,...assets.map(a=>join(directory,a.name)),'--repo',repository,'--target',commit,'--prerelease','--latest=false','--title',tag,'--notes','Immutable corresponding video source and six-platform relink materials. No npm publication.']);
const release=JSON.parse(gh(['api',`repos/${repository}/releases/tags/${tag}`]));
if(release.tag_name!==tag||release.target_commitish!==commit||release.draft!==false||release.prerelease!==true||!Number.isSafeInteger(release.id)||release.assets.length!==12)throw Error('Created release identity mismatch');
for(const asset of assets){const remote=release.assets.find(a=>a.name===asset.name);if(!remote||remote.size!==asset.size||remote.digest!==`sha256:${asset.sha256}`||remote.browser_download_url!==`https://github.com/${repository}/releases/download/${tag}/${asset.name}`)throw Error('Remote release asset binding mismatch');asset.url=remote.browser_download_url;}
const remoteReport=release.assets.find(a=>a.name==='video-materials.json');
const downloaded=execFileSync('gh',['api',`repos/${repository}/releases/assets/${remoteReport.id}`,'-H','Accept: application/octet-stream'],{maxBuffer:8*1024*1024});
if(sha(downloaded)!==sha(reportBytes))throw Error('Remote materials report readback mismatch');
const binding={schemaVersion:1,repository,commit,runId,runAttempt,tag,releaseId:release.id,version,assets};
await writeFile(join(directory,'video-materials-binding.json'),JSON.stringify(binding,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({tag,releaseId:release.id,assets:assets.length,npmPublished:false}));
