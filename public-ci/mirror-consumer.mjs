/** Copy this script into a fresh npm consumer containing installed qq-native-client,
 * then run it there. Explicit public mirror preparation only; never login/send.
 * This file has not been executed against native/network.
 */
import {mkdtemp,readFile,realpath,lstat,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const catalogUrl='https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog-gzip-v1.json';
const downloadMirrors=['https://gh-proxy.com/'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(condition,message)=>{if(!condition)throw Error(message);};
const output=resolve(process.argv[2]??'public-mirror-consumer.json');
const root=await mkdtemp(join(tmpdir(),'qq-public-mirror-cold-')),cacheDir=join(root,'cache');
const originalFetch=globalThis.fetch;let client,phase=0,stage='import',selected,manifest,manifestSha;
const stats=[{requests:0,payloadRequests:0,bytes:0,payloadBytes:0},{requests:0,payloadRequests:0,bytes:0,payloadBytes:0}];
const receipt={device:`${process.platform}-${process.arch}`,node:process.version,noLogin:true,freshCold:true,catalog:'catalog-gzip-v1.json',proxyConfigured:true,completed:false};
try {
 let denied=false;try{await symlink('nonexistent-fixture',join(root,'deny-probe'));}catch(error){denied=error.code==='EPERM';}check(denied,'Symlink denial policy missing');receipt.symlinkCreationDenied=true;
 const {createClient}=await import('qq-native-client');
 globalThis.fetch=async(input,init)=>{
  const url=String(input);const parsed=new URL(url);check(parsed.protocol==='https:','HTTPS required');
  const metadata=parsed.pathname.endsWith('.json');const stat=stats[phase];stat.requests++;if(!metadata)stat.payloadRequests++;
  if(phase===1&&!metadata)throw Error('Cached preparation attempted native payload network');
  const response=await originalFetch(input,init);
  if(metadata&&response.ok){
   check(response.body,'Metadata body missing');const chunks=[];let size=0;
   for await(const chunk of response.body){size+=chunk.length;check(size<=1024*1024,'Metadata too large');chunks.push(Buffer.from(chunk));}
   const bytes=Buffer.concat(chunks);stat.bytes+=bytes.length;const data=JSON.parse(bytes);
   if(url===catalogUrl){
    const matches=data.packages?.filter(item=>item.platform===process.platform&&item.arch===process.arch);check(data.schemaVersion===1&&matches?.length===1,'Ambiguous device catalog selection');selected=matches[0];
   }else{
    check(selected&&url===selected.manifestUrl&&hash(bytes)===selected.manifestSha256,'Manifest digest/selection mismatch');manifest=data;manifestSha=hash(bytes);
    check(manifest.platform===process.platform&&manifest.arch===process.arch,'Manifest device mismatch');
   }
   return new Response(bytes,{status:response.status,headers:response.headers});
  }
  if(!response.body)return response;
  const reader=response.body.getReader();const stream=new ReadableStream({async pull(controller){try{const result=await reader.read();if(result.done){controller.close();return;}stat.bytes+=result.value.length;if(!metadata)stat.payloadBytes+=result.value.length;controller.enqueue(result.value);}catch(error){controller.error(error);}},cancel(reason){return reader.cancel(reason);}});
  return new Response(stream,{status:response.status,headers:response.headers});
 };
 for(phase=0;phase<2;phase++){
  stage=phase===0?'cold-prepare':'cached-prepare';client=await createClient({catalogUrl,downloadMirrors,cacheDir,dataDir:join(root,`empty-account-${phase}`),autoReconnect:false,timeoutMs:30000});
  const count=client.nativeExports.length;check(count>=80,'Unexpected native export count');await client.close();check(client.state==='closed','Client did not close');client=undefined;
  if(phase===0)receipt.nativeExports=count;
 }
 stage='cache-integrity';check(manifest&&selected&&stats[0].payloadRequests>0,'Cold preparation did not download native payloads');
 const target=await realpath(join(cacheDir,manifestSha));
 for(const file of manifest.files){check(typeof file.path==='string'&&!file.path.split(/[\\/]/).includes('..'),'Invalid manifest path');const path=await realpath(join(target,file.path));check(path.startsWith(target+sep)&&(await lstat(path)).isFile()&&hash(await readFile(path))===file.sha256.toLowerCase(),'Cached native file integrity mismatch');}
 check(stats[1].payloadRequests===0&&stats[1].payloadBytes===0,'Cached preparation repeated payload download');
 Object.assign(receipt,{manifestId:manifest.id,version:manifest.version,manifestSha256:manifestSha,hashValidatedLoader:true,cacheFilesIndependentlyHashVerified:true,first:stats[0],second:stats[1],prepared:true,closed:true,completed:true});
}catch{receipt.failureStage=stage;process.exitCode=1;}
finally{globalThis.fetch=originalFetch;try{await client?.close();}catch{receipt.completed=false;receipt.failureStage='close';process.exitCode=1;}await writeFile(output,JSON.stringify(receipt,null,2)+'\n');await rm(root,{recursive:true,force:true});}
