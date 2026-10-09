import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir,lstat,readlink,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {QQClient} from '../src/index.ts';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve('.local/acceptance/merged-forward-v1'),modules=join(root,'consumer/node_modules');
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const bytes=await readFile(join(root,'plan.json')),planSha256=sha(bytes);
if(planSha256!=='8498f9a5ed742f9e097436a60492b509906c8335bad26d8d5a5c47945f644125')throw Error('Reviewed acceptance plan changed');
const plan=JSON.parse(bytes.toString());
const args=process.argv.slice(2);
if(args.length>1||(args.length===1&&args[0]!=='--execute-approved'))throw Error('Use review mode or --execute-approved after fresh human authorization');
if(plan.schemaVersion!==1||plan.sourceCommit!=='5469440f330541c306d92d1f4414e0074102127c'||plan.sourceRunId!=='37985572940'||plan.method!=='restore'
 ||plan.dataDir!==resolve('.local/pruned-qr-readonly-v1/account')||plan.cacheDir!==join(root,'native-cache')
 ||plan.peer.type!=='private'||plan.peer.userId!=='8596238'||plan.author!=='restored-account-own-uin'||plan.nickname!=='SDK验收'
 ||JSON.stringify(plan.texts)!==JSON.stringify(['qq-native-client merged-forward acceptance v1 / node 1','qq-native-client merged-forward acceptance v1 / node 2'])
 ||plan.recallDelayMs!==30000||plan.maxUploads!==1||plan.maxCardSends!==1||plan.maxRecalls!==1||plan.recallOnlyAfterSuccessfulSend!==true
 ||['retry','qrFallback','readHistory','readForwardContents','signingAuthenticityEstablished'].some(key=>plan[key]!==false))throw Error('Acceptance scope changed');
if(process.platform!==plan.platform||process.arch!==plan.arch||process.version!==plan.nodeVersion||sha(Buffer.from(JSON.stringify(process.config)))!==plan.nodeConfigSha256)throw Error('Reviewed runtime changed');
for(const[name,expected]of Object.entries(plan.tarballs)){
 if(!['qq-native-client-0.0.2.tgz','qq-native-client-darwin-arm64-0.0.2.tgz'].includes(name)||sha(await readFile(join(root,name)))!==expected)throw Error('Reviewed tarball changed');
}
const files:Record<string,string>={},links:Record<string,string>={};
async function inventory(relative=''){
 for(const name of(await readdir(join(modules,relative))).sort()){
  const path=relative?relative+'/'+name:name,info=await lstat(join(modules,path));
  if(info.isDirectory())await inventory(path);else if(info.isFile())files[path]=sha(await readFile(join(modules,path)));
  else if(info.isSymbolicLink()){links[path]=await readlink(join(modules,path));if(!(await realpath(join(modules,path))).startsWith(modules+sep))throw Error('Installed link escapes reviewed directory');}
  else throw Error('Unexpected installed entry');
 }
}
await inventory();
if(JSON.stringify(files)!==JSON.stringify(plan.installedFiles)||JSON.stringify(links)!==JSON.stringify(plan.installedLinks))throw Error('Installed files changed');
for(const[name,expected]of Object.entries(plan.consumerFiles)){
 if(!['package.json','package-lock.json','entry.mjs'].includes(name)||sha(await readFile(join(root,'consumer',name)))!==expected)throw Error('Reviewed consumer entry changed');
}
if(files['qq-native-client-darwin-arm64/manifest.json']!==plan.nativeManifestSha256)throw Error('Native manifest changed');
const manifest=JSON.parse(await readFile(join(modules,'qq-native-client-darwin-arm64/manifest.json'),'utf8'));
if(manifest.npmStorage?.format!=='gzip-objects-v1'||manifest.files.length!==1168||plan.nativeFiles!==1168)throw Error('Native closure changed');
// Default review stops before importing the SDK entry, native loading, or account access.
if(!args.length){console.log(JSON.stringify({planSha256,sourceCommit:plan.sourceCommit,sourceRunId:plan.sourceRunId,installedFiles:Object.keys(files).length,nativeFiles:plan.nativeFiles,peer:plan.peer,maxUploads:1,maxCardSends:1,maxRecalls:1,accountUsed:false,nativeExecuted:false}));process.exit(0);}
// This switch is not authorization. Reserve permanently only after fresh human approval.
await writeFile(join(root,'attempt-once.lock'),JSON.stringify({planSha256,reservedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
const receipt={startedAt:new Date().toISOString(),planSha256,sourceCommit:plan.sourceCommit,sourceRunId:plan.sourceRunId,stage:'initialize',restoreAttempted:false,restored:false,uploadAndCardAttempted:false,sent:false,sentMessageId:'',resourceIdSha256:'',recallAttempted:false,recalled:false,closed:false,interrupted:false,errorCategory:'',errorCode:'',uploadCompletion:'not-dispatched',cardCompletion:'not-dispatched',signingAuthenticityEstablished:false};
const save=()=>writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
let client:QQClient|undefined;
const stopSignal=new AbortController();
const stop=()=>{receipt.interrupted=true;stopSignal.abort();process.exitCode=130;void client?.close().catch(()=>{});};
const check=()=>{if(receipt.interrupted)throw Error('Interrupted');};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 check();const{createClient}=await import(pathToFileURL(join(root,'consumer/entry.mjs')).href);
 check();client=await createClient({dataDir:plan.dataDir,cacheDir:plan.cacheDir,timeoutMs:30000,autoReconnect:false});if(!client)throw Error('No client');
 check();receipt.stage='restore';receipt.restoreAttempted=true;await save();check();
 const account=await client.login({method:'restore'});receipt.restored=true;
 const author=account.uin;if(typeof author!=='string'||!/^[1-9]\d{0,9}$/.test(author)||Number(author)>0xffffffff)throw Error('Restored author outside text-forward contract');
 const nodes=plan.texts.map((text:string)=>({userId:author,nickname:plan.nickname,time:plan.time,text}));
 check();receipt.stage='send';receipt.uploadAndCardAttempted=true;await save();check();
 const sent=await client.sendMergedForward(plan.peer,nodes,plan.options);
 receipt.sent=true;receipt.sentMessageId=sent.messageId;receipt.resourceIdSha256=sha(Buffer.from(sent.resourceId));receipt.uploadCompletion='resource-received';receipt.cardCompletion='receipt-received';
 check();receipt.stage='observation-window';await save();check();
 await delay(plan.recallDelayMs,undefined,{signal:stopSignal.signal});
 check();receipt.stage='recall';receipt.recallAttempted=true;await save();check();
 await client.recallMessage(plan.peer,sent.messageId);receipt.recalled=true;receipt.stage='complete';
}catch(error){
 const e=error as {code?:unknown;mergedForward?:{uploadCompletion?:string;cardCompletion?:string;resourceId?:string}};
 if(typeof e.code==='number'&&Number.isFinite(e.code))receipt.errorCode=String(e.code);else if(typeof e.code==='string'&&/^[\w.:-]{1,64}$/.test(e.code))receipt.errorCode=e.code;
 if(e.mergedForward){receipt.uploadCompletion=e.mergedForward.uploadCompletion??'unknown';receipt.cardCompletion=e.mergedForward.cardCompletion??'unknown';if(e.mergedForward.resourceId)receipt.resourceIdSha256=sha(Buffer.from(e.mergedForward.resourceId));}
 receipt.errorCategory=receipt.interrupted?'interrupted':/timed? ?out/i.test(error instanceof Error?error.message:'')?'timeout':'operation-failed';process.exitCode=receipt.interrupted?130:1;
}finally{
 try{await client?.close();receipt.closed=client?.state==='closed';}catch{receipt.errorCategory='shutdown-failed';process.exitCode=1;}
 process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 if(receipt.interrupted){receipt.errorCategory='interrupted';process.exitCode=130;}
 await save();
}
