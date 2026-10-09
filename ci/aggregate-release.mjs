import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {npm} from './npm.mjs';
const sha=(data,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(data).digest(encoding);
const devices=['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'];
const sdk=JSON.parse(await readFile('sdk/package.json','utf8'));
const release=resolve('release');await mkdir(join(release,'evidence'),{recursive:true});
const packages=[];
for(const device of devices){
 const [platform,arch]=device.split('-'),name=`qq-native-client-${device}`;
 const input=resolve('artifacts',`npm-${device}`),tarball=`${name}-${sdk.version}.tgz`;
 const bytes=await readFile(join(input,tarball));
 const pkg=JSON.parse(execFileSync('tar',['-xOf',join(input,tarball),'package/package.json']));
 const nativeBytes=execFileSync('tar',['-xOf',join(input,tarball),'package/manifest.json'],{maxBuffer:8*1024*1024});
 const native=JSON.parse(nativeBytes);
 if(pkg.name!==name||pkg.version!==sdk.version||pkg.os?.[0]!==platform||pkg.cpu?.[0]!==arch||native.platform!==platform||native.arch!==arch||sdk.optionalDependencies[name]!==sdk.version)throw Error(`Package identity mismatch: ${device}`);
 const receiptBytes=await readFile(join(input,'consumer.json')),receipt=JSON.parse(receiptBytes);
 if(receipt.platform!==platform||receipt.arch!==arch||receipt.exports<80||!receipt.installedMainOnly||!receipt.automaticPlatformSelection||!receipt.prepared||!receipt.closed||receipt.loginAttempted!==false)throw Error(`Consumer failed: ${device}`);
 if(native.videoCodec!=='video/video-codec.node'||receipt.automaticVideoCodec!==true||receipt.installedVideoDecoder!==true||receipt.installedVideoFakeCache!==true||receipt.installedVideo?.noQQ!==true||receipt.installedVideo?.noAccount!==true||receipt.installedVideo?.nativeSendAttempted!==false||receipt.installedVideo?.inputs?.length!==3)throw Error(`Automatic installed codec failed: ${device}`);
 const codecFile=native.files.find(f=>f.path===native.videoCodec);
 if(!codecFile||codecFile.sha256!==receipt.installedVideo.binary?.sha256)throw Error(`Installed video binary receipt mismatch: ${device}`);
 const bridgeName=platform==='win32'?'QQNT.dll':'registration-bridge.node';
 const bridge=await readFile(join(input,'bridges',device,bridgeName));
 if(native.files.find(f=>f.path===bridgeName)?.sha256!==sha(bridge))throw Error(`Bridge mismatch: ${device}`);
 await mkdir(join('sdk/native',device),{recursive:true});await writeFile(join('sdk/native',device,bridgeName),bridge);
 if(platform==='win32'){
  const license=await readFile(join(input,'bridges',device,'NODE-LICENSE.txt'));
  if(native.files.find(f=>f.path==='NODE-LICENSE.txt')?.sha256!==sha(license))throw Error(`License mismatch: ${device}`);
  await writeFile(join('sdk/native',device,'NODE-LICENSE.txt'),license);
 }
 await copyFile(join(input,tarball),join(release,tarball));
 const receiptPath=`evidence/${device}.consumer.json`;await writeFile(join(release,receiptPath),receiptBytes);
 packages.push({name,version:sdk.version,tarball,size:bytes.length,sha256:sha(bytes),integrity:'sha512-'+sha(bytes,'sha512','base64'),manifestSha256:sha(nativeBytes),receipt:receiptPath,receiptSha256:sha(receiptBytes)});
}
// The main package is compiled and packed by this CI job after all six bridges are present.
execFileSync(npm[0],[...npm[1],'exec','tsc'],{cwd:resolve('sdk'),stdio:'inherit'});
execFileSync(npm[0],[...npm[1],'pack','--ignore-scripts','--pack-destination',release],{cwd:resolve('sdk'),stdio:'inherit'});
const tarball=`${sdk.name}-${sdk.version}.tgz`,bytes=await readFile(join(release,tarball));
packages.push({name:sdk.name,version:sdk.version,tarball,size:bytes.length,sha256:sha(bytes),integrity:'sha512-'+sha(bytes,'sha512','base64')});
const {GITHUB_REPOSITORY:repository,GITHUB_SHA:commit,GITHUB_RUN_ID:runId,GITHUB_RUN_ATTEMPT:attempt}=process.env;
if(repository!=='lc-cn/qq-native-mirror'||! /^[a-f0-9]{40}$/.test(commit??'')||!/^\d+$/.test(runId??'')||!/^\d+$/.test(attempt??''))throw Error('GitHub release identity missing');
// The producer materials have already been archived before any platform package
// was built. Retain their exact binding/report bytes with the seven-package set.
const bindingBytes=await readFile('out/video-materials/video-materials-binding.json');
const reportBytes=await readFile('out/video-materials/video-materials.json');
const binding=JSON.parse(bindingBytes);
if(binding.repository!==repository||binding.commit!==commit||binding.runId!==runId||binding.runAttempt!==Number(attempt)||binding.version!==sdk.version)throw Error('Video materials differ from this package run');
await mkdir(join(release,'video-materials'),{recursive:true});
await writeFile(join(release,'video-materials/video-materials-binding.json'),bindingBytes);
await writeFile(join(release,'video-materials/video-materials.json'),reportBytes);
const videoMaterials={binding:{path:'video-materials/video-materials-binding.json',sha256:sha(bindingBytes)},report:{path:'video-materials/video-materials.json',sha256:sha(reportBytes)}};
await writeFile(join(release,'release-manifest.json'),JSON.stringify({schemaVersion:1,repository,commit,runId,runAttempt:Number(attempt),version:sdk.version,packages,videoMaterials},null,2)+'\n');
