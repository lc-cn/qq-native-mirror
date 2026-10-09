import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const temp=await mkdtemp(join(tmpdir(),'qq-ci-consumer-'));
const {version}=JSON.parse(await readFile('sdk/package.json','utf8'));
let client;
try {
 await writeFile(join(temp,'package.json'),JSON.stringify({name:'qq-ci-consumer',private:true,type:'module'}));
 execFileSync('npm',['install','--ignore-scripts','--omit=optional','--no-audit','--no-fund',resolve(`out/qq-native-client-${version}.tgz`),resolve(`out/qq-native-client-${process.platform}-${process.arch}-${version}.tgz`)],{cwd:temp,stdio:'inherit'});
 const {pathToFileURL}=await import('node:url');
 const sdk=await import(pathToFileURL(join(temp,'node_modules/qq-native-client/dist/index.js')).href);
 // Native resolution must use the installed optional bundle, with no mirror traffic.
 globalThis.fetch=()=>{throw new Error('Unexpected mirror request with installed platform package');};
 client=await sdk.createClient({dataDir:join(temp,'unused-account'),autoReconnect:false,timeoutMs:30000});
 const exports=client.nativeExports.length;if(exports<80)throw new Error('Unexpected native export inventory');
 await client.close();if(client.state!=='closed')throw new Error('Client did not close');
 await writeFile('out/consumer.json',JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,exports,installedImport:true,prepared:true,closed:true,loginAttempted:false},null,2));
 console.log(await readFile('out/consumer.json','utf8'));
}finally{await client?.close();await rm(temp,{recursive:true,force:true});}
