import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, validateMainSource, readMainArtifact } from './main-artifact.mjs';
const bytes=Buffer.from('synthetic main archive');
const environment={SDK_SOURCE_MODE:'current-source',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2'};
const current=()=>({schemaVersion:2,mode:'current-source',repository:'lc-cn/qq-native-mirror',commit:environment.GITHUB_SHA,runId:environment.GITHUB_RUN_ID,runAttempt:2,sdkVersion:'0.0.2',main:{name:'qq-native-client',version:'0.0.2',tarball:'qq-native-client-0.0.2.tgz',size:bytes.length,sha256:digest(bytes),integrity:`sha512-${digest(bytes,'sha512','base64')}`}});
test('current source requires exact workflow, attempt, mode and package identity',()=>{
  assert.equal(validateMainSource(current(),environment).version,'0.0.2');
  for(const change of [s=>s.commit='b'.repeat(40),s=>s.runId='124',s=>s.runAttempt=1,s=>s.schemaVersion=1,s=>s.sdkVersion='0.0.1',s=>s.main.version='0.0.1',s=>s.main.tarball='../main.tgz',s=>s.main.integrity='bad',s=>s.main.sha256='bad']){
    const value=current();change(value);assert.throws(()=>validateMainSource(value,environment));
  }
  assert.throws(()=>validateMainSource(current(),{...environment,SDK_SOURCE_MODE:'published-baseline'}));
});
test('published baseline retains exact old artifact and cannot stand for the current run',()=>{
  const source={repository:'lc-cn/qq-native-mirror',tag:'npm-v0.0.1-ci-37890893656',commit:'9237a3a50329e5ce8d247c3f153003501cb7c349',runId:'37890893656',runAttempt:1,manifestSha256:'c'.repeat(64),main:{...current().main,version:'0.0.1',tarball:'qq-native-client-0.0.1.tgz',size:236137,sha256:'346bfee5895de2e0ef236cfb25d97654c8b773a5ec5adc67568b79e81301b11a'}};
  assert.equal(validateMainSource(source,{SDK_SOURCE_MODE:'published-baseline'}).version,'0.0.1');
  assert.throws(()=>validateMainSource(source,environment));
  assert.throws(()=>validateMainSource({...source,runId:'1'},{SDK_SOURCE_MODE:'published-baseline'}));
});
test('artifact bytes are bound by size and both SHA256/SHA512 before installation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-version-source-test-'));
  try{
    const source=current();await writeFile(join(root,'main-source.json'),JSON.stringify(source));await writeFile(join(root,source.main.tarball),bytes);
    assert.equal((await readMainArtifact(root,environment)).row.tarball,source.main.tarball);
    await writeFile(join(root,source.main.tarball),'changed');await assert.rejects(readMainArtifact(root,environment),/bytes changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
