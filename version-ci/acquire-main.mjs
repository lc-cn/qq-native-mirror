import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const repo='lc-cn/qq-native-mirror',tag='npm-v0.0.1-ci-37886708952',runId='37886708952',commit='6af4b3c4bb4309f14753d6bc6c3ab67503bd2d59';
const sha=(b,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(b).digest(encoding);
export function validateSource(release,run,manifest){
 if(release.tag_name!==tag||release.draft!==false||!release.prerelease||release.target_commitish!==commit||String(run.id)!==runId||run.repository?.full_name!==repo||run.status!=='completed'||run.conclusion!=='success'||run.head_sha!==commit||run.run_attempt!==1||run.path!=='.github/workflows/native-first-main.yml'||manifest.schemaVersion!==1||manifest.repository!==repo||manifest.commit!==commit||manifest.runId!==runId||manifest.runAttempt!==1||manifest.version!=='0.0.1')throw Error('Source identity mismatch');
 const names=new Set(['qq-native-client',...['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'].map(p=>'qq-native-client-'+p)]);
 if(manifest.packages?.length!==7||new Set(manifest.packages.map(p=>p.name)).size!==7||manifest.packages.some(p=>!names.has(p.name)||p.version!=='0.0.1'))throw Error('Source package set mismatch');
 const main=manifest.packages.find(p=>p.name==='qq-native-client');
 if(main.tarball!=='qq-native-client-0.0.1.tgz'||main.size!==230041||main.sha256!=='0e51e6dee2a99503c8bd0849483394e5979961b01d29826cdcfd08302affd556')throw Error('Unexpected corrected main');return main;
}
export function validateAsset(asset,bytes,name){if(!asset||asset.name!==name||asset.browser_download_url!==`https://github.com/${repo}/releases/download/${tag}/${name}`||!/^sha256:[a-f0-9]{64}$/.test(asset.digest??'')||asset.size!==bytes.length||asset.digest!=='sha256:'+sha(bytes))throw Error('Source asset hash mismatch');}
async function main(){
 const api=p=>JSON.parse(execFileSync('gh',['api',`repos/${repo}/${p}`],{maxBuffer:8*1024*1024}));
 const release=api(`releases/tags/${tag}`),run=api(`actions/runs/${runId}`);await mkdir('out',{recursive:true});
 const download=async name=>{const matches=release.assets.filter(a=>a.name===name);if(matches.length!==1)throw Error('Duplicate/missing asset');const a=matches[0];if(!Number.isInteger(a.size)||a.size<=0||a.size>(name==='release-manifest.json'?8*1024*1024:230041)||!/^sha256:[a-f0-9]{64}$/.test(a.digest??'')||a.browser_download_url!==`https://github.com/${repo}/releases/download/${tag}/${name}`)throw Error('Unsafe source asset');execFileSync('gh',['release','download',tag,'--repo',repo,'--pattern',name,'--dir','out','--clobber'],{stdio:'inherit'});const bytes=await readFile('out/'+name);validateAsset(release.assets.find(a=>a.name===name),bytes,name);return bytes;};
 const manifestBody=await download('release-manifest.json'),manifest=JSON.parse(manifestBody),pkg=validateSource(release,run,manifest),bytes=await download(pkg.tarball);
 if(sha(bytes)!==pkg.sha256||'sha512-'+sha(bytes,'sha512','base64')!==pkg.integrity)throw Error('Main integrity mismatch');
 await writeFile('out/main-source.json',JSON.stringify({repository:repo,tag,commit,runId,runAttempt:1,manifestSha256:sha(manifestBody),main:pkg},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await main();}catch(error){await mkdir('out',{recursive:true});await writeFile('out/version-consumer.json',JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,currentRun:process.env.GITHUB_RUN_ID,stage:'acquire-main',success:false,loginAttempted:false,errorCode:'SOURCE_VALIDATION_FAILED'},null,2));throw error;}}
