import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const devices=['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'];
const manifest=JSON.parse(await readFile('release/release-manifest.json','utf8'));
manifest.auxiliarySources=[];
for(const device of devices){
 const source=JSON.parse(await readFile(`artifacts/npm-${device}/source-provenance.json`,'utf8'));
 const auxiliary=manifest.packages.find(p=>p.name===`qq-native-client-${device}`);
 if(auxiliary.sha256!==source.package.sha256||auxiliary.integrity!==source.package.integrity||auxiliary.size!==source.package.size)throw Error('Auxiliary bytes changed');
 for(const name of ['installed-no-symlink.consumer.json','cache-no-symlink.consumer.json']){
  const body=await readFile(`artifacts/npm-${device}/${name}`),receipt=JSON.parse(body);
  if(!receipt.prepared||!receipt.closed||!receipt.symlinkCreationDenied||receipt.loginAttempted!==false||receipt.currentRun!==process.env.GITHUB_RUN_ID)throw Error('Missing fresh no-symlink acceptance');
  if(name==='cache-no-symlink.consumer.json'&&(!receipt.cacheReused||receipt.firstFileRequests<=0||receipt.cachedFileRequests!==0))throw Error('Native cache file reuse not verified');
  await writeFile(`release/evidence/${device}.${name}`,body);
 }
 await copyFile(`artifacts/npm-${device}/source-provenance.json`,`release/evidence/${device}.source-provenance.json`);
 manifest.auxiliarySources.push(source);
}
const aggregate=JSON.parse(await readFile('out/consumer.json','utf8'));
if(!aggregate.prepared||!aggregate.closed||!aggregate.installedMainOnly)throw Error('Aggregate consumer failed');
await copyFile('out/consumer.json','release/evidence/aggregated-main.consumer.json');
manifest.acceptanceEvidence=[];
for(const device of devices)for(const name of ['installed-no-symlink.consumer.json','cache-no-symlink.consumer.json','source-provenance.json']){const path=`evidence/${device}.${name}`;manifest.acceptanceEvidence.push({path,sha256:sha(await readFile('release/'+path))});}
await writeFile('release/release-manifest.json',JSON.stringify(manifest,null,2)+'\n');
