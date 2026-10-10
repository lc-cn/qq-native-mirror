import {createHash,randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {constants} from 'node:fs';
import {mkdir,lstat,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {resolve,join,dirname,parse} from 'node:path';
import type {NativeManifest} from '../types.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const hash=/^[a-f0-9]{64}$/;
const limit=512*1024*1024,totalLimit=2*1024*1024*1024;
const pending=new Map<string,Promise<string>>();
function check(ok:unknown,message:string):asserts ok{if(!ok)throw Error(message);}
function path(value:string){check(typeof value==='string'&&value&&!/[\\\0:\r\n]/.test(value)&&!value.startsWith('/')&&!value.split('/').some(p=>!p||p==='.'||p==='..'),'Unsafe installed storage path');return value;}
function size(value:unknown){check(Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=limit,'Invalid installed storage size');return Number(value);}
export function installedStorageDirectoryParts(absolute:string,root:string):string[]{return absolute.slice(root.length).split(/[\\/]/).filter(Boolean);}
async function directory(value:string,create=false){const absolute=resolve(value);let current=parse(absolute).root;for(const part of installedStorageDirectoryParts(absolute,current)){current=join(current,part);if(create)try{await mkdir(current);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}const stat=await lstat(current);check(stat.isDirectory()&&!stat.isSymbolicLink(),'Installed storage directory must not be a symlink');}return absolute;}
async function regular(root:string,name:string,max:number){const full=join(root,path(name));await directory(dirname(full));const stat=await lstat(full);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=max,'Invalid installed storage regular file');const body=await readFile(full,{flag:constants.O_RDONLY|constants.O_NOFOLLOW});check(body.length===stat.size&&body.length<=max,'Installed storage file size changed');return body;}
/** Only installed packages may declare this format. No network or native execution. */
export async function restoreInstalledNativeStorage(packageRoot:string,manifestBytes:Uint8Array,manifest:NativeManifest,cacheDir:string,acquireLock:(target:string)=>Promise<()=>Promise<void>>):Promise<string>{
 const storage=manifest.npmStorage;check(storage?.format==='gzip-objects-v1'&&Array.isArray(storage.objects)&&storage.objects.length>0&&storage.objects.length<=4096,'Invalid installed npm storage');
 check(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=4096,'Invalid installed storage inventory');
 const objects=new Map<string,NonNullable<NativeManifest['npmStorage']>['objects'][number]>();let rawTotal=0,compressedTotal=0;
 for(const object of storage.objects){check(object&&typeof object.sha256==='string'&&typeof object.downloadSha256==='string'&&hash.test(object.sha256)&&hash.test(object.downloadSha256)&&object.path===`objects/${object.sha256}.gz`&&!objects.has(object.sha256),'Invalid or duplicate installed storage object');size(object.size);compressedTotal+=size(object.downloadSize);check(compressedTotal<=totalLimit,'Installed storage total limit');objects.set(object.sha256,object);}
 const names=new Set<string>(),used=new Set<string>();for(const file of manifest.files){path(file.path);check(!names.has(file.path)&&typeof file.sha256==='string'&&hash.test(file.sha256),'Invalid installed storage file');names.add(file.path);const object=objects.get(file.sha256);check(object&&size(file.size)===object.size,'Installed storage object/file mismatch');used.add(file.sha256);rawTotal+=size(file.size);check(rawTotal<=totalLimit,'Installed storage total limit');}
 check(used.size===objects.size,'Extra installed storage objects');for(const name of names){const parts=name.split('/');for(let i=1;i<parts.length;i++)check(!names.has(parts.slice(0,i).join('/')),'Conflicting installed storage paths');}
 check(names.has(path(manifest.wrapper))&&(!manifest.videoCodec||names.has(path(manifest.videoCodec))),'Installed storage entry missing');
 const root=await directory(packageRoot),base=await directory(cacheDir,true),target=join(base,'npm-'+sha(manifestBytes));
 async function valid(){try{await directory(target);for(const file of manifest.files){const body=await regular(target,file.path,size(file.size));if(body.length!==file.size||sha(body)!==file.sha256)return false;}return true;}catch{return false;}}
 const prior=pending.get(target);if(prior)return prior;
 const work=(async()=>{const release=await acquireLock(target);try{
  // A symlink at the cache root is rejected, never recursively removed.
  try{const stat=await lstat(target);check(stat.isDirectory()&&!stat.isSymbolicLink(),'Unsafe installed storage cache target');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  for(const object of objects.values()){const body=await regular(root,object.path,object.downloadSize);check(body.length===object.downloadSize&&sha(body)===object.downloadSha256,'Installed storage compressed checksum mismatch');}
  if(await valid())return target;
  const temporary=join(base,'.npm-'+randomUUID());await mkdir(temporary);try{
   for(const object of objects.values()){const compressed=await regular(root,object.path,object.downloadSize);check(compressed.length===object.downloadSize&&sha(compressed)===object.downloadSha256,'Installed storage compressed checksum mismatch');const raw=gunzipSync(compressed,{maxOutputLength:Math.max(1,object.size)});check(raw.length===object.size&&sha(raw)===object.sha256,'Installed storage raw checksum mismatch');for(const file of manifest.files.filter(f=>f.sha256===object.sha256)){const output=join(temporary,file.path);await directory(dirname(output),true);await writeFile(output,raw,{flag:'wx'});}}
   if(!await valid()){await rm(target,{recursive:true,force:true});await rename(temporary,target);}check(await valid(),'Installed storage hydration failed');return target;
  }finally{await rm(temporary,{recursive:true,force:true});}
 }finally{await release();}})();pending.set(target,work);try{return await work;}finally{if(pending.get(target)===work)pending.delete(target);}
}
