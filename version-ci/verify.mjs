import {mkdtemp,writeFile,copyFile,readdir,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {npm} from '../ci/npm.mjs';
const temporary=await mkdtemp(join(tmpdir(),'qq-version-installed-'));
try{
 await writeFile(join(temporary,'package.json'),JSON.stringify({private:true,type:'module'}));
 execFileSync(npm[0],[...npm[1],'install',resolve('out/qq-native-client-0.0.1.tgz'),'--omit=optional','--ignore-scripts','--no-audit','--no-fund','--cache',join(temporary,'npm-cache')],{cwd:temporary,stdio:'inherit'});
 for(const name of await readdir(join(temporary,'node_modules')))if(name.startsWith('qq-native-client-'))throw Error('Native auxiliary installed');
 await copyFile('version-ci/consumer.mjs',join(temporary,'consumer.mjs'));
 const env={...process.env,SOURCE_FILE:resolve('out/main-source.json'),CATALOG_FILE:resolve('catalog.json'),RECEIPT_FILE:resolve('out/version-consumer.json')};
 for(const name of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name))delete env[name];
 execFileSync(process.execPath,[join(temporary,'consumer.mjs')],{cwd:temporary,env,stdio:'inherit'});
}catch(error){const failure={platform:process.platform,arch:process.arch,node:process.version,clientVersion:process.env.TARGET_VERSION,currentRun:process.env.GITHUB_RUN_ID,stage:'install-or-runtime',success:false,loginAttempted:false,errorCode:typeof error.code==='string'?error.code:'DRIVER_FAILED'};await writeFile('out/version-consumer-driver-error.json',JSON.stringify(failure));try{await access('out/version-consumer.json');}catch{await writeFile('out/version-consumer.json',JSON.stringify(failure));}throw error;}finally{await rm(temporary,{recursive:true,force:true});}
