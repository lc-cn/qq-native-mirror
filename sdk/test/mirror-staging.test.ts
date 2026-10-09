import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {stageMirror} from '../scripts/stage-native-mirror.ts';
test('mirror staging preserves inventory hashes and immutable version/platform/arch identity', async () => {
 const root=await mkdtemp(join(tmpdir(),'qq-mirror-'));
 try {
  const bytes=Buffer.from('native-fixture');
  const manifest={schemaVersion:1,id:'fixture',platform:'linux',arch:'arm64',wrapper:'wrapper.node',version:{clientVersion:'3.2.32-52194',appId:'1',qua:'fixture'},files:[{path:'wrapper.node',url:'old',sha256:createHash('sha256').update(bytes).digest('hex')}]};
  await writeFile(join(root,'wrapper.node'),bytes);
  await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
  const result=await stageMirror(root,join(root,'mirror'));
  assert.match(result.packagePath,/^3\.2\.32-52194\/linux\/arm64\/[a-f0-9]{64}$/);
  const body=await readFile(join(root,'mirror',result.packagePath,'manifest.json'));
  assert.equal(createHash('sha256').update(body).digest('hex'),result.manifestSha256);
  assert.equal(JSON.parse(body.toString()).files[0].url,'wrapper.node');
  await assert.rejects(stageMirror(root,join(root,'mirror')),/EEXIST/);
  await writeFile(join(root,'wrapper.node'),'tampered');
  await assert.rejects(stageMirror(root,join(root,'mirror2')),/hash mismatch/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('mirror staging stores identical bytes once without linking back to mutable source', async t => {
 const root=await mkdtemp(join(tmpdir(),'qq-stage-dedup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=Buffer.from('identical native fixture');const sha256=createHash('sha256').update(bytes).digest('hex');
 await writeFile(join(root,'wrapper.node'),bytes);await writeFile(join(root,'copy.node'),bytes);
 await writeFile(join(root,'manifest.json'),JSON.stringify({schemaVersion:1,platform:'linux',arch:'x64',wrapper:'wrapper.node',version:{clientVersion:'1',appId:'1',qua:'fixture'},files:[{path:'wrapper.node',url:'old',sha256},{path:'copy.node',url:'old',sha256}]}));
 const result=await stageMirror(root,join(root,'mirror'));const destination=join(root,'mirror',result.packagePath);assert.equal(result.files,2);assert.equal(result.uniqueContents,1);
 assert.equal((await stat(join(destination,'wrapper.node'))).ino,(await stat(join(destination,'copy.node'))).ino);
 await writeFile(join(root,'wrapper.node'),'source changed');assert.deepEqual(await readFile(join(destination,'wrapper.node')),bytes);
});
