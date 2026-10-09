import {readFile,writeFile,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(v,m)=>{if(!v)throw Error(m);};
const key=p=>`${p.platform}/${p.arch}/${p.version?.clientVersion}`;
const devices=['linux/x64','linux/arm64','darwin/x64','darwin/arm64','win32/x64','win32/arm64'];
const safe=p=>typeof p==='string'&&p&&!/[\\\0:\r\n]/.test(p)&&!p.startsWith('/')&&!p.split('/').some(s=>!s||s==='.'||s==='..');
function valid(p){check(p&&devices.includes(`${p.platform}/${p.arch}`)&&p.version&&['clientVersion','appId','qua'].every(k=>typeof p.version[k]==='string'&&p.version[k])&&/^[a-f0-9]{64}$/.test(p.manifestSha256),'Invalid catalog row');const u=new URL(p.manifestUrl);check(u.protocol==='https:'&&!u.username&&!u.password,'Unsafe catalog URL');}
/** Pure replacement; never append another package with the same device/version. */
export function planNativeCatalogPromotion(oldBytes,updates){
 const old=JSON.parse(oldBytes.toString());check(old.schemaVersion===1&&Array.isArray(old.packages)&&old.packages.length===8,'Expected original eight-entry catalog');
 const keys=new Set();for(const p of old.packages){valid(p);check(!keys.has(key(p)),'Duplicate existing catalog key');keys.add(key(p));}
 check(updates?.schemaVersion===1&&Array.isArray(updates.packages)&&updates.packages.length===6,'Six candidate updates required');
 const replacements=new Map(),seenDevices=new Set();for(const p of updates.packages){valid(p);const device=`${p.platform}/${p.arch}`;check(!seenDevices.has(device),'Duplicate candidate device');seenDevices.add(device);check(keys.has(key(p)),'Candidate must replace existing version');const previous=old.packages.find(o=>key(o)===key(p));check(JSON.stringify(previous.version)===JSON.stringify(p.version),'Candidate changes QQ version configuration');replacements.set(key(p),p);}
 const retained=old.packages.filter(p=>!replacements.has(key(p)));check(retained.length===2&&retained.every(p=>p.platform==='linux'&&p.version.clientVersion==='3.2.31-51102'),'Must retain both older Linux versions');
 const catalog={...old,packages:old.packages.map(p=>replacements.get(key(p))??p)};
 return{catalog,backupSha256:sha(oldBytes),backupPath:`catalog-backups/${sha(oldBytes)}.json`,changes:old.packages.filter(p=>replacements.has(key(p))).map(p=>({key:key(p),before:p,after:replacements.get(key(p))})),retained,oldManifestAssetsPreserved:true};
}
export async function prepareNativeCatalogPromotion(catalogPath,stageDir,outDir){
 check((await lstat(catalogPath)).isFile(),'Catalog must be a regular file');const oldBytes=await readFile(catalogPath);
 check((await lstat(stageDir)).isDirectory(),'Stage must be a regular directory');const stage=await realpath(stageDir);
 async function local(path){check(safe(path),'Unsafe stage path');const requested=join(stage,path),actual=await realpath(requested);check(actual.startsWith(stage+sep)&&(await lstat(requested)).isFile(),'Stage file must be contained and regular');return readFile(actual);}
 const planBytes=await local('mirror-plan.json'),plan=JSON.parse(planBytes);check(plan.schemaVersion===1&&plan.repository==='lc-cn/qq-native-mirror'&&plan.packages?.length===6,'Invalid mirror plan');
 for(const p of plan.packages){const bytes=await local(p.manifestPath);check(sha(bytes)===p.manifestSha256,'Candidate manifest digest mismatch');const manifest=JSON.parse(bytes);check(manifest.schemaVersion===1&&manifest.platform===p.platform&&manifest.arch===p.arch&&JSON.stringify(manifest.version)===JSON.stringify(p.version)&&manifest.videoCodec==='video/video-codec.node'&&manifest.files?.some(f=>f.path===manifest.videoCodec),'Candidate codec identity mismatch');const row=plan.catalogUpdates?.packages?.find(r=>key(r)===key(p));check(row&&row.manifestSha256===p.manifestSha256&&row.manifestUrl===`https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/${p.repoPath}`,'Catalog update differs from approved manifest');}
 const promotion=planNativeCatalogPromotion(oldBytes,plan.catalogUpdates);
 const requested=resolve(outDir);await mkdir(requested,{recursive:true});check((await lstat(requested)).isDirectory(),'Output must be a regular directory');const out=await realpath(requested);check(out!==stage&&!out.startsWith(stage+sep)&&!stage.startsWith(out+sep)&&(await readdir(out)).length===0,'Output must be empty and outside stage');
 await mkdir(join(out,'catalog-backups'));await writeFile(join(out,promotion.backupPath),oldBytes,{flag:'wx'});
 const body=Buffer.from(JSON.stringify(promotion.catalog,null,2)+'\n');await writeFile(join(out,'catalog-proposed.json'),body,{flag:'wx'});
 const receipt={schemaVersion:1,sourcePlanSha256:sha(planBytes),backupPath:promotion.backupPath,backupSha256:promotion.backupSha256,proposedCatalogSha256:sha(body),changes:promotion.changes,retained:promotion.retained,oldManifestAssetsPreserved:true,defaultCatalogChanged:false,pushed:false,nativeExecuted:false};await writeFile(join(out,'promotion.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){check(process.argv.length===5,'Usage: node scripts/prepare-native-catalog-promotion.mjs OLD_CATALOG STAGE_DIR OUTPUT_DIR');console.log(JSON.stringify(await prepareNativeCatalogPromotion(...process.argv.slice(2)),null,2));}
