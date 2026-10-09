import {gzipSync} from 'node:zlib';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink, stat, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { prepareNative, safeRelative } from '../src/native-package.ts';
import type { NativeManifest } from '../src/types.ts';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('native cache installation needs no symlink creation privilege',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-cache-no-symlink-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const denied=()=>{throw Object.assign(new Error('symlink privilege denied'),{code:'EPERM'});};
 const originalSync=fs.symlinkSync,originalAsync=fsPromises.symlink;
 fs.symlinkSync=denied;fsPromises.symlink=async()=>denied();syncBuiltinESMExports();
 t.after(()=>{fs.symlinkSync=originalSync;fsPromises.symlink=originalAsync;syncBuiltinESMExports();});
 const bytes=Buffer.from('no symlink native fixture');
 const body=JSON.stringify({schemaVersion:1,id:'no-symlink',platform:process.platform,arch:process.arch,wrapper:'wrapper.node',version:{clientVersion:'test',appId:'1',qua:'fixture'},files:[{path:'wrapper.node',url:'./wrapper',sha256:sha(bytes)}]});
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async input=>new Response(String(input).endsWith('/manifest.json')?body:bytes);
 const result=await prepareNative({dataDir:dir,cacheDir:dir,manifestUrl:'https://fixture.example/manifest.json',manifestSha256:sha(body)});
 assert.deepEqual(await readFile(result.wrapperPath),bytes);
 assert.equal((await readdir(dir)).some(name=>name.endsWith('.lock')||name.includes('.owner-')),false);
});

test('native mirror validates, downloads nested dependencies, caches and repairs corruption', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'qq-package-test-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const wrapper = Buffer.from('fake wrapper; never execute');
  const dependency = Buffer.from('fake dependency');
  const manifest: NativeManifest = {
    schemaVersion: 1, id: 'fixture', platform: process.platform, arch: process.arch,
    wrapper: 'native/wrapper.node', version: { clientVersion: 'test', appId: 'test', qua: 'test' },
    files: [
      { path: 'native/wrapper.node', url: './files/wrapper', sha256: sha(wrapper) },
      { path: 'native/lib/dependency.dylib', url: './files/dependency', sha256: sha(dependency) },
    ],
  };
  let body = JSON.stringify(manifest);
  let fileRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/mirror/manifest.json') return void res.end(body);
    if (req.url === '/mirror/files/wrapper') { fileRequests++; return void res.end(wrapper); }
    if (req.url === '/mirror/files/dependency') { fileRequests++; return void res.end(dependency); }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const options = () => ({ manifestUrl: `http://127.0.0.1:${address.port}/mirror/manifest.json`, manifestSha256: sha(body), cacheDir, dataDir: cacheDir });
  for (const field of ['clientVersion', 'appId', 'qua'] as const) {
    await assert.rejects(prepareNative({ ...options(), version: { ...manifest.version, [field]: 'different' } }), /does not match/);
  }
  assert.equal(fileRequests, 0, 'version mismatch rejects before fetching native payloads');
  const result = await prepareNative(options());
  assert.deepEqual((await prepareNative({ ...options(), version: { ...manifest.version } })).version, manifest.version);
  assert.deepEqual(await readFile(result.wrapperPath), wrapper);
  assert.deepEqual(await readFile(join(dirname(result.wrapperPath), 'lib/dependency.dylib')), dependency);
  assert.equal(fileRequests, 2);
  await prepareNative(options());
  assert.equal(fileRequests, 2, 'validated cache avoids file downloads');
  await writeFile(result.wrapperPath, 'corrupted');
  const clients = await Promise.all(Array.from({ length: 5 }, () => prepareNative(options())));
  assert.ok(clients.every(client => client.wrapperPath === result.wrapperPath));
  assert.deepEqual(await readFile(result.wrapperPath), wrapper);
  assert.equal(fileRequests, 2, 'concurrent clients share one repaired installation');
  await rm(result.wrapperPath);
  const outside = join(cacheDir, 'outside');
  await writeFile(outside, wrapper);
  await symlink(outside, result.wrapperPath);
  await prepareNative(options());
  assert.equal(fileRequests, 2, 'cache symlinks outside package are replaced');
  await writeFile(result.wrapperPath, 'corrupted again');
  const moduleUrl = new URL('../src/native-package.ts', import.meta.url).href;
  const runChild = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { prepareNative } from ${JSON.stringify(moduleUrl)}; await prepareNative(${JSON.stringify(options())});`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Child exited ${code}: ${stderr}`)));
  });
  await Promise.all(Array.from({ length: 4 }, runChild));
  assert.equal(fileRequests, 2, 'separate processes share one repaired installation');
  assert.deepEqual(await readFile(result.wrapperPath), wrapper);
  const crashed = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = crashed.pid!;
  await new Promise<void>(resolve => crashed.on('exit', () => resolve()));
  await writeFile(result.wrapperPath, 'crash recovery corruption');
  const packageRoot = dirname(dirname(result.wrapperPath));
  await symlink(`${deadPid}-crashed-owner`, `${packageRoot}.lock`);
  await runChild();
  assert.equal(fileRequests, 2, 'dead owner lock is recovered');
  await writeFile(join(cacheDir,'.contents',sha(wrapper)),'corrupted content cache');
  await writeFile(result.wrapperPath,'force installed cache repair');
  await prepareNative(options());
  assert.equal(fileRequests,3,'corrupt content is downloaded again; intact dependency content is reused');
  assert.deepEqual(await readFile(result.wrapperPath),wrapper);
  await assert.rejects(prepareNative({ ...options(), manifestSha256: '0'.repeat(64) }), /manifest SHA-256 mismatch/);
  manifest.arch = 'unsupported'; body = JSON.stringify(manifest);
  await assert.rejects(prepareNative(options()), /platform or architecture/);
  manifest.arch = process.arch;
  manifest.files[0]!.path = '../escape'; body = JSON.stringify(manifest);
  await assert.rejects(prepareNative(options()), /Unsafe native package path/);
  manifest.files[0]!.path = manifest.wrapper;
  manifest.files[0]!.sha256 = '0'.repeat(64); body = JSON.stringify(manifest);
  await assert.rejects(prepareNative(options()), /Native file SHA-256 mismatch/);
});

test('package paths reject traversal, absolute paths, windows paths and NULs', () => {
  for (const value of ['../x', '/x', 'a/../x', 'a/./x', 'a//x', 'C:/x', 'a\\x', 'a\0x', '']) {
    assert.throws(() => safeRelative(value), /Unsafe native package path/);
  }
  assert.equal(safeRelative('native/lib/x.node'), 'native/lib/x.node');
});

test('local wrapper reads matching adjacent version manifest when version is omitted',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-local-manifest-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const wrapperPath=join(dir,'wrapper.node');await writeFile(wrapperPath,'fixture-not-executed');
 const version={clientVersion:'7.0.2-53644',appId:'1',qua:'fixture'};
 const manifest={schemaVersion:1,platform:process.platform,arch:process.arch,wrapper:'wrapper.node',version};
 await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
 assert.deepEqual((await prepareNative({wrapperPath,dataDir:dir})).version,version);
 await writeFile(join(dir,'manifest.json'),JSON.stringify({...manifest,arch:'wrong'}));
 await assert.rejects(prepareNative({wrapperPath,dataDir:dir}),/does not match/);
});

test('mirror downloads identical contents once while preserving every manifest path',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-dedup-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('fixture identical content');let requests=0;
 const manifest={schemaVersion:1,id:'dedup',platform:process.platform,arch:process.arch,wrapper:'wrapper.node',version:{clientVersion:'test',appId:'1',qua:'test'},files:[{path:'wrapper.node',url:'./first',sha256:sha(bytes)},{path:'lib/copy.node',url:'./second',sha256:sha(bytes)}]};const body=JSON.stringify(manifest);
 const server=createServer((req,res)=>{if(req.url==='/manifest.json')res.end(body);else{requests++;res.end(bytes);}});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const port=(server.address() as {port:number}).port;
 const result=await prepareNative({dataDir:dir,cacheDir:dir,manifestUrl:`http://127.0.0.1:${port}/manifest.json`,manifestSha256:sha(body)});
 assert.equal(requests,1);assert.deepEqual(await readFile(result.wrapperPath),bytes);assert.deepEqual(await readFile(join(dirname(result.wrapperPath),'lib/copy.node')),bytes);
});

test('accelerators reject bad bytes and fall back to the verified origin', async t => {
 const dir=await mkdtemp(join(tmpdir(),'qq-accelerator-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('verified wrapper');const origin='https://github.com/example/native/releases/download/v1/wrapper.node';
 const manifest={schemaVersion:1,id:'accelerator',platform:process.platform,arch:process.arch,wrapper:'wrapper.node',version:{clientVersion:'test',appId:'1',qua:'test'},files:[{path:'wrapper.node',url:origin,sha256:sha(bytes)}]};const body=JSON.stringify(manifest);const calls:string[]=[];
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
 globalThis.fetch=async input=>{const url=String(input);calls.push(url);if(url.endsWith('/manifest.json'))return new Response(body);if(url.startsWith('https://bad.example/'))return new Response('incorrect bytes');if(url.startsWith('https://failed.example/'))return new Response('',{status:502});return new Response(bytes);};
 const options={dataDir:dir,cacheDir:dir,manifestUrl:'https://catalog.example/manifest.json',manifestSha256:sha(body),downloadMirrors:['https://bad.example/','https://failed.example/']};
 const result=await prepareNative(options);assert.deepEqual(await readFile(result.wrapperPath),bytes);
 assert.deepEqual(calls,[options.manifestUrl,'https://bad.example/'+origin,'https://failed.example/'+origin,origin]);
 await assert.rejects(prepareNative({...options,downloadMirrors:['http://unsafe.example/']}),/HTTPS/);
});

test('successful accelerator avoids an origin file request', async t => {
 const dir=await mkdtemp(join(tmpdir(),'qq-accelerator-success-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('verified proxy content');const origin='https://github.com/example/native/releases/download/v1/wrapper.node';
 const body=JSON.stringify({schemaVersion:1,id:'accelerator-success',platform:process.platform,arch:process.arch,wrapper:'wrapper.node',version:{clientVersion:'test',appId:'1',qua:'test'},files:[{path:'wrapper.node',url:origin,sha256:sha(bytes)}]});const calls:string[]=[];
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
 globalThis.fetch=async input=>{const url=String(input);calls.push(url);if(url.endsWith('/manifest.json'))return new Response(body);assert.equal(url,'https://gh-proxy.com/'+origin);return new Response(bytes);};
 const result=await prepareNative({dataDir:dir,cacheDir:dir,manifestUrl:'https://catalog.example/manifest.json',manifestSha256:sha(body),downloadMirrors:['https://gh-proxy.com/']});
 assert.deepEqual(await readFile(result.wrapperPath),bytes);assert.equal(calls.length,2);
});

test('gzip mirror checks both transport and original bytes and caches decoded contents', async t => {
 const dir=await mkdtemp(join(tmpdir(),'qq-gzip-mirror-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('native gzip fixture'.repeat(100));const compressed=gzipSync(bytes);let payloads=0;
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
 let transport=compressed;
 const manifest={schemaVersion:1,id:'gzip',platform:process.platform,arch:process.arch,wrapper:'wrapper.node',version:{clientVersion:'test',appId:'1',qua:'fixture'},files:[{path:'wrapper.node',url:'./wrapper.gz',sha256:sha(bytes),encoding:'gzip',downloadSha256:sha(compressed)}]};
 const body=JSON.stringify(manifest);const options={dataDir:dir,cacheDir:dir,manifestUrl:'https://fixture.example/manifest.json',manifestSha256:sha(body)};
 globalThis.fetch=async input=>{if(String(input).endsWith('/manifest.json'))return new Response(body);payloads++;return new Response(transport);};
 transport=Buffer.from('bad compressed content');await assert.rejects(prepareNative(options),/Compressed native SHA-256 mismatch/);
 transport=compressed;const prepared=await prepareNative(options);assert.deepEqual(await readFile(prepared.wrapperPath),bytes);const downloaded=payloads;await prepareNative(options);assert.equal(payloads,downloaded);
 const wrong={...manifest,files:[{...manifest.files[0],sha256:sha(Buffer.from('different original'))}]};const wrongBody=JSON.stringify(wrong);
 globalThis.fetch=async input=>new Response(String(input).endsWith('/manifest.json')?wrongBody:compressed);
 await assert.rejects(prepareNative({...options,manifestSha256:sha(wrongBody)}),/Native file SHA-256 mismatch/);
});

test('cached contents are not rewritten and installation mutations remain independent',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-cache-copy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('native cache copy fixture');const body=JSON.stringify({schemaVersion:1,id:'copy',platform:process.platform,arch:process.arch,wrapper:'wrapper.node',version:{clientVersion:'test',appId:'1',qua:'fixture'},files:[{path:'wrapper.node',url:'./wrapper',sha256:sha(bytes)}]});
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let downloads=0;
 globalThis.fetch=async input=>{if(String(input).endsWith('/manifest.json'))return new Response(body);downloads++;return new Response(bytes);};
 const options={cacheDir:dir,dataDir:dir,manifestUrl:'https://fixture.example/manifest.json',manifestSha256:sha(body)};const prepared=await prepareNative(options);
 const content=join(dir,'.contents',sha(bytes));const timestamp=new Date('2000-01-01T00:00:00Z');await utimes(content,timestamp,timestamp);
 assert.notEqual((await stat(content)).ino,(await stat(prepared.wrapperPath)).ino);await writeFile(prepared.wrapperPath,'broken installed file');assert.deepEqual(await readFile(content),bytes);
 await prepareNative(options);assert.deepEqual(await readFile(prepared.wrapperPath),bytes);assert.equal((await stat(content)).mtimeMs,timestamp.getTime());assert.equal(downloads,1);
});

test('content cache directory cannot redirect installation writes outside the cache root',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-cache-directory-'));t.after(()=>rm(dir,{recursive:true,force:true}));const outside=await mkdtemp(join(tmpdir(),'qq-cache-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 await symlink(outside,join(dir,'.contents'));const bytes=Buffer.from('never downloaded');const body=JSON.stringify({schemaVersion:1,id:'symlink',platform:process.platform,arch:process.arch,wrapper:'wrapper.node',version:{clientVersion:'test',appId:'1',qua:'fixture'},files:[{path:'wrapper.node',url:'./wrapper',sha256:sha(bytes)}]});
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let payloads=0;globalThis.fetch=async input=>{if(String(input).endsWith('/manifest.json'))return new Response(body);payloads++;return new Response(bytes);};
 await assert.rejects(prepareNative({cacheDir:dir,dataDir:dir,manifestUrl:'https://fixture.example/manifest.json',manifestSha256:sha(body)}),/inside cache root/);assert.equal(payloads,0);assert.deepEqual(await readdir(outside),[]);
});
