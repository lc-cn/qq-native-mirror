import {verify} from './consumer.mjs';
import {validateSource,validateAsset} from './acquire-main.mjs';
import {mkdtemp,writeFile,mkdir,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const directory=await mkdtemp(join(tmpdir(),'qq-version-fixture-'));const sha=b=>createHash('sha256').update(b).digest('hex');
try{
 const payload=Buffer.from('actual-fixture-bytes'),manifest={version:{clientVersion:'3.2.32-52194'},files:[{path:'wrapper.node',sha256:sha(payload)}]},body=Buffer.from(JSON.stringify(manifest));
 process.env.TARGET_VERSION='3.2.32-52194';process.env.SOURCE_FILE=join(directory,'source.json');process.env.CATALOG_FILE=join(directory,'catalog.json');process.env.RECEIPT_FILE=join(directory,'receipt.json');
 await writeFile(process.env.SOURCE_FILE,JSON.stringify({runId:'fixed-source',main:{sha256:'fixture'}}));await writeFile(process.env.CATALOG_FILE,JSON.stringify({packages:[{platform:process.platform,arch:process.arch,version:manifest.version,manifestSha256:sha(body)}]}));
 for(const secondPayload of [false,true]){
  let calls=0,networkCalls=0;
  globalThis.fetch=async url=>{networkCalls++;return new Response(url.endsWith('manifest.json')?body:payload);};
  const sdk={async createClient(options){calls++;await fetch('http://localhost/manifest.json');if(calls===1||secondPayload)await fetch('http://localhost/wrapper.node');const path=join(options.cacheDir,sha(body));await mkdir(path,{recursive:true});await writeFile(join(path,'wrapper.node'),payload);return{nativeExports:Array(98),state:'ready',async close(){this.state='closed';}};}};
  if(secondPayload){await assert.rejects(verify(sdk),/Second preparation/);assert.equal(networkCalls,3);}else{await verify(sdk);assert.equal(JSON.parse(await readFile(process.env.RECEIPT_FILE)).success,true);}
 }
 console.log('Full fake consumer success and pre-fetch second-payload rejection passed');
}finally{await rm(directory,{recursive:true,force:true});}

const commit='6af4b3c4bb4309f14753d6bc6c3ab67503bd2d59',runId='37886708952',tag='npm-v0.0.1-ci-'+runId;
const sourceMain={name:'qq-native-client',version:'0.0.1',tarball:'qq-native-client-0.0.1.tgz',size:230041,sha256:'0e51e6dee2a99503c8bd0849483394e5979961b01d29826cdcfd08302affd556'};
const release={tag_name:tag,draft:false,prerelease:true,target_commitish:commit};
const run={id:Number(runId),repository:{full_name:'lc-cn/qq-native-mirror'},status:'completed',conclusion:'success',head_sha:commit,run_attempt:1,path:'.github/workflows/native-first-main.yml'};
const manifest={schemaVersion:1,repository:'lc-cn/qq-native-mirror',commit,runId,runAttempt:1,version:'0.0.1',packages:[sourceMain,...['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'].map(target=>({name:'qq-native-client-'+target,version:'0.0.1'}))]};
assert.equal(validateSource(release,run,manifest),sourceMain);
assert.throws(()=>validateSource(release,{...run,head_sha:'f'.repeat(40)},manifest),/identity/);
assert.throws(()=>validateSource(release,{...run,conclusion:'failure'},manifest),/identity/);
const altered=structuredClone(manifest);altered.packages[0].sha256='f'.repeat(64);assert.throws(()=>validateSource(release,run,altered),/corrected main/);
const content=Buffer.from('bounded-manifest-fixture'),name='release-manifest.json';
const asset={name,browser_download_url:`https://github.com/lc-cn/qq-native-mirror/releases/download/${tag}/${name}`,size:content.length,digest:'sha256:'+sha(content)};
validateAsset(asset,content,name);assert.throws(()=>validateAsset(asset,Buffer.from('altered'),name),/hash/);
assert.throws(()=>validateAsset({...asset,browser_download_url:'https://example.invalid/manifest.json'},content,name),/hash/);
console.log('Source CI identity and asset digest/URL rejection passed; no network/native/login');
