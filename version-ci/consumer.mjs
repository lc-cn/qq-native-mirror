import {readFile,writeFile,mkdtemp,mkdir,rm,readdir,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {validateMainSource} from './main-artifact.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
export function validateCounts(first,second){if(!Number.isInteger(first)||first<1||second!==0)throw Error('Native payload cache verification failed');}
export async function verify(sdkOverride){
 let stage='sentinel',client,temporary;
 const receipt={platform:process.platform,arch:process.arch,clientVersion:process.env.TARGET_VERSION,node:process.version,currentRun:process.env.GITHUB_RUN_ID,loginAttempted:false,success:false};
 const originalFetch=globalThis.fetch;let nativePayloadRequests=0,manifestBody,manifest,selected;
 try{
  await symlink('unused','unused').then(()=>{throw Error('Symlink denial missing');},e=>{if(e.code!=='EPERM')throw e;});receipt.symlinkCreationDenied=true;
  const source=JSON.parse(await readFile(process.env.SOURCE_FILE,'utf8'));validateMainSource(source);receipt.mainSha256=source.main.sha256;receipt.sourceRun=source.runId;receipt.sourceCommit=source.commit;receipt.sourceMode=source.mode??'published-baseline';receipt.sdkVersion=source.main.version;
  temporary=await mkdtemp(join(tmpdir(),'qq-version-runtime-'));
  const sdk=sdkOverride??await import('qq-native-client');
  const catalog=JSON.parse(await readFile(process.env.CATALOG_FILE,'utf8'));selected=catalog.packages.find(p=>p.platform===process.platform&&p.arch===process.arch&&p.version.clientVersion===process.env.TARGET_VERSION);if(!selected)throw Error('Target version missing');
  const options={dataDir:join(temporary,'account'),cacheDir:join(temporary,'native-cache'),autoReconnect:false,timeoutMs:120000,...(process.env.TARGET_VERSION==='3.2.31-51102'?{version:selected.version}:{})};
  globalThis.fetch=async(input,init)=>{
   const url=String(input);if(stage==='prepare-second'&&!url.endsWith('/manifest.json')&&!url.endsWith('/catalog.json'))throw Error('Second preparation attempted native payload download');const response=await originalFetch(input,init);
   if(url.endsWith('/catalog.json')){/* SDK selects the public default catalog, no catalogUrl override. */}
   else if(url.endsWith('/manifest.json')){manifestBody=Buffer.from(await response.clone().arrayBuffer());manifest=JSON.parse(manifestBody);if(sha(manifestBody)!==selected.manifestSha256)throw Error('Unexpected public native manifest');}
   else {if(stage==='prepare-second')throw Error('Second preparation attempted native payload download');nativePayloadRequests++;}
   return response;
  };
  stage='prepare-first';client=await sdk.createClient(options);receipt.exports=client.nativeExports.length;if(receipt.exports!==(process.env.TARGET_VERSION==='3.2.31-51102'?92:98))throw Error('Unexpected export count');await client.close();if(client.state!=='closed')throw Error('Client did not close');client=undefined;
  if(manifest.version.clientVersion!==process.env.TARGET_VERSION)throw Error('Wrong selected native version');
  stage='file-integrity';for(const file of manifest.files){const path=join(options.cacheDir,sha(manifestBody),file.path);if(sha(await readFile(path))!==file.sha256)throw Error('Cached native file hash mismatch');}receipt.verifiedFiles=manifest.files.length;
  const first=nativePayloadRequests;stage='prepare-second';client=await sdk.createClient(options);await client.close();if(client.state!=='closed')throw Error('Cached client did not close');client=undefined;
  validateCounts(first,nativePayloadRequests-first);receipt.firstNativePayloadRequests=first;receipt.secondNativePayloadRequests=nativePayloadRequests-first;receipt.automaticLatest=process.env.TARGET_VERSION==='3.2.32-52194';receipt.prepared=true;receipt.closed=true;receipt.success=true;stage='complete';
 }catch(error){receipt.errorCode=typeof error?.code==='string'?error.code:'VALIDATION_FAILED';throw error;}finally{
  receipt.stage=stage;globalThis.fetch=originalFetch;try{await client?.close();}catch{receipt.success=false;receipt.stage='cleanup-close';receipt.errorCode='CLOSE_FAILED';}await writeFile(process.env.RECEIPT_FILE,JSON.stringify(receipt,null,2));if(temporary)await rm(temporary,{recursive:true,force:true});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await verify();
