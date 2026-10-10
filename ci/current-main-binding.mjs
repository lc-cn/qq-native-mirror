import assert from 'node:assert/strict';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {validateRelease} from '../sdk/scripts/local-first-publish.mjs';
export const CURRENT_MAIN=Object.freeze({repository:'lc-cn/qq-native-mirror',commit:'7ec1a309da4137c5eef190482c731889f6341392',runId:'38005239931',runAttempt:1,version:'0.0.2',releaseManifestSha256:'a155c39781f49f645bf5b4af260c6d7b62ea784ed4794872c946927669682c11',tarball:'qq-native-client-0.0.2.tgz',sha256:'685803fcaf965cdf827fffb2d79c08885182a3a718dc59b27670af07672f6988',size:452930,integrity:'sha512-PL4aqvSLKruciMCeleD02hi5Bqps92+Va5C7Esk8nSzSYxj3otqZZa6W/SRuYRAqQ53HqGy+HKpUrPml2O+1NQ=='});
const sha=b=>createHash('sha256').update(b).digest('hex');
export function validateCurrentMainMetadata(manifest) {
 for(const key of ['repository','commit','runId','runAttempt','version'])assert.equal(manifest[key],CURRENT_MAIN[key]);
 assert.equal(manifest.schemaVersion,2);assert.equal(manifest.packages.length,7);
 assert.equal(new Set(manifest.packages.map(p=>p.name)).size,7);
 assert.equal(manifest.aggregateReceipt.path,'evidence/aggregated-main.consumer.json');
 assert.match(manifest.aggregateReceipt.sha256,/^[a-f0-9]{64}$/);
 const rows=manifest.packages.filter(p=>p.name==='qq-native-client');assert.equal(rows.length,1);const main=rows[0];
 for(const key of ['version','tarball','sha256','size','integrity'])assert.equal(main[key],CURRENT_MAIN[key]);
 return main;
}
export function validateCurrentMainAcquisition(binding) {
 assert.equal(binding.schemaVersion,1);
 for(const key of ['repository','commit','runId','runAttempt','releaseManifestSha256'])assert.equal(binding[key],CURRENT_MAIN[key]);
 assert.equal(binding.workflowPath,'.github/workflows/native-npm.yml');
 assert.deepEqual(binding.artifact,{id:11650703913,name:'npm-release',size:388134440,sha256:'0bfdfe0cf747f9c33fa777749605b9451da1d5c4cd9712caff647f3cd550d7cc'});
 for(const key of ['name','version','tarball','size','sha256','integrity'])assert.equal(binding.main[key],key==='name'?'qq-native-client':CURRENT_MAIN[key]);
 assert.equal(binding.offlineValidated,true);assert.equal(binding.nativeExecuted,false);assert.equal(binding.accountUsed,false);assert.equal(binding.published,false);
 return binding;
}
export async function loadCurrentMain(directory,{validate=validateRelease}={}) {
 const root=await realpath(resolve(directory));
 // Full original seven-package, receipt and permanent-material gate always precedes selection.
 const checked=await validate(root);assert.equal(checked.videoMaterialsPending,false);assert.ok(checked.videoMaterials);assert.notEqual(checked.videoMaterials.pending,true);
 const main=validateCurrentMainMetadata(checked.manifest);
 for(const name of ['release-manifest.json','acquisition-binding.json',main.tarball])assert.ok((await lstat(join(root,name))).isFile(),'Regular source file required');
 const manifestBytes=await readFile(join(root,'release-manifest.json'));assert.equal(sha(manifestBytes),CURRENT_MAIN.releaseManifestSha256);assert.deepEqual(JSON.parse(manifestBytes),checked.manifest);
 const bytes=await readFile(join(root,main.tarball));assert.equal(bytes.length,CURRENT_MAIN.size);assert.equal(sha(bytes),CURRENT_MAIN.sha256);assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),CURRENT_MAIN.integrity);
 const acquisitionBytes=await readFile(join(root,'acquisition-binding.json'));validateCurrentMainAcquisition(JSON.parse(acquisitionBytes));
 return {main,bytes,sdkSource:{...CURRENT_MAIN,acquisitionBindingSha256:sha(acquisitionBytes),artifactId:11650703913,artifactSha256:'0bfdfe0cf747f9c33fa777749605b9451da1d5c4cd9712caff647f3cd550d7cc',sourceKind:'production-artifact',sourceDirectory:'out/current-main-source'}};
}
