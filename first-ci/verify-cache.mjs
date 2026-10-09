import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createClient} from '../sdk/dist/index.js';
import {symlink} from 'node:fs/promises';
await symlink('unused','unused').then(()=>{throw Error('Symlink denial preload missing');},error=>{if(error.code!=='EPERM')throw error;});
const root=resolve('out/source-native'),manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const files=new Map();for(const file of manifest.files){const data=await readFile(join(root,file.path));if(createHash('sha256').update(data).digest('hex')!==file.sha256)throw Error('Native fixture mismatch');files.set('/'+file.path,data);file.url='./'+file.path;}
const body=Buffer.from(JSON.stringify(manifest));files.set('/manifest.json',body);
let requests=0,fileRequests=0;const server=createServer((req,res)=>{const data=files.get(decodeURIComponent(req.url));if(!data)return void res.writeHead(404).end();requests++;if(req.url!=='/manifest.json')fileRequests++;res.end(data);});
const directory=await mkdtemp(join(tmpdir(),'qq-cache-no-symlink-'));let client;
try{
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 const options={manifestUrl:`http://127.0.0.1:${server.address().port}/manifest.json`,manifestSha256:createHash('sha256').update(body).digest('hex'),cacheDir:join(directory,'cache'),dataDir:join(directory,'account'),autoReconnect:false,timeoutMs:60000};
 client=await createClient(options);const exports=client.nativeExports.length;if(exports<80)throw Error('Native exports missing');await client.close();if(client.state!=='closed')throw Error('Client close failed');client=undefined;
 const first=requests,firstFileRequests=fileRequests;if(firstFileRequests===0)throw Error('Native fixture did not download files');client=await createClient(options);await client.close();if(client.state!=='closed')throw Error('Cached client close failed');client=undefined;
 // A manifest request is permitted, but cache reuse must not re-fetch any file.
 if(fileRequests-firstFileRequests!==0)throw Error('Native cache fetched files again');
 await writeFile('out/cache-no-symlink.consumer.json',JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,exports,prepared:true,closed:true,cacheReused:true,firstRequests:first,cachedRequests:requests-first,firstFileRequests,cachedFileRequests:fileRequests-firstFileRequests,symlinkCreationDenied:true,loginAttempted:false,currentRun:process.env.GITHUB_RUN_ID},null,2));
}catch(error){throw error;}finally{await client?.close();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});}
