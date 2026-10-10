import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  rm,
  symlink,
  realpath,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

test('installed platform bundle integrity and explicit source precedence', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-installed-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [
    'native/native-installed-storage.ts',
    'native/native-package.ts',
    'native/native-catalog.ts',
    'storage/process-lock.ts',
    'types.ts',
  ]) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(new URL('../src/' + name, import.meta.url), target);
  }
  const pkg = join(root, 'node_modules', `qq-native-client-${process.platform}-${process.arch}`);
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: `qq-native-client-${process.platform}-${process.arch}`,
      exports: { './manifest.json': './manifest.json' },
    }),
  );
  const bytes = Buffer.from('native fixture; never execute'),
    sha = createHash('sha256').update(bytes).digest('hex');
  const version = { clientVersion: '7.0.2-53644', appId: 'test', qua: 'test' };
  const manifest = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    version,
    wrapper: 'wrapper.node',
    files: [{ path: 'wrapper.node', url: 'wrapper.node', sha256: sha }],
  };
  const save = async (value: unknown) =>
    writeFile(join(pkg, 'manifest.json'), JSON.stringify(value));
  await writeFile(join(pkg, 'wrapper.node'), bytes);
  await save(manifest);
  const { prepareNative } = await import(
    pathToFileURL(join(root, 'native/native-package.ts')).href
  );
  const fetchBefore = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetchBefore;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('explicit mirror selected');
  };
  const result = await prepareNative({ dataDir: root });
  assert.equal(result.wrapperPath, join(pkg, 'wrapper.node'));
  assert.deepEqual(result.version, version);
  assert.equal(calls, 0);
  await assert.rejects(
    prepareNative({ dataDir: root, catalogUrl: 'https://example.com/catalog.json' }),
    /explicit mirror selected/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    prepareNative({ dataDir: root, version: { ...version, clientVersion: 'another' } }),
    /explicit mirror selected/,
  );
  assert.equal(calls, 2);
  const local = join(root, 'explicit.node');
  await writeFile(local, bytes);
  assert.equal(
    (await prepareNative({ dataDir: root, wrapperPath: local, version })).wrapperPath,
    local,
  );
  assert.equal(calls, 2);
  await writeFile(join(pkg, 'wrapper.node'), 'corrupted');
  await assert.rejects(prepareNative({ dataDir: root }), /failed verification/);
  assert.equal(calls, 2, 'corruption does not silently download a replacement');
  await rm(join(pkg, 'wrapper.node'));
  await t.test('symlink rejection when platform permits creating links', async (sub) => {
    try {
      await symlink(local, join(pkg, 'wrapper.node'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        sub.skip('Host denies symlink creation');
        return;
      }
      throw error;
    }
    await assert.rejects(prepareNative({ dataDir: root }), /failed verification/);
  });
  await rm(join(pkg, 'wrapper.node'), { force: true });
  await writeFile(join(pkg, 'wrapper.node'), bytes);
  await save({
    ...manifest,
    nodeVersion: process.version,
    nodeConfigSha256: createHash('sha256').update(JSON.stringify(process.config)).digest('hex'),
  });
  assert.equal((await prepareNative({ dataDir: root })).wrapperPath, join(pkg, 'wrapper.node'));
  await save({ ...manifest, nodeVersion: 'v0.0.1', nodeConfigSha256: '0'.repeat(64) });
  await assert.rejects(prepareNative({ dataDir: root }), /requires matching Node/);
  assert.equal(calls, 2);
  await save({ ...manifest, nodeVersion: process.version });
  await assert.rejects(prepareNative({ dataDir: root }), /Invalid native Node runtime constraint/);
  await save({ ...manifest, arch: 'incorrect' });
  await assert.rejects(prepareNative({ dataDir: root }), /does not match device/);
  await save({ ...manifest, files: [...manifest.files, ...manifest.files] });
  await assert.rejects(prepareNative({ dataDir: root }), /Invalid installed native manifest/);
  await save({ ...manifest, files: [] });
  await assert.rejects(prepareNative({ dataDir: root }), /wrapper is missing/);
});

const execute = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function objectFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-installed-object-')));
  for (const name of [
    'native/native-installed-storage.ts',
    'native/native-package.ts',
    'native/native-catalog.ts',
    'storage/process-lock.ts',
    'types.ts',
  ]) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(new URL('../src/' + name, import.meta.url), target);
  }
  const pkg = join(root, 'node_modules', `qq-native-client-${process.platform}-${process.arch}`);
  await mkdir(join(pkg, 'objects'), { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: `qq-native-client-${process.platform}-${process.arch}`,
      exports: { './manifest.json': './manifest.json' },
    }),
  );
  const raw = Buffer.alloc(1024 * 1024, 42),
    compressed = gzipSync(raw),
    object = {
      path: `objects/${hash(raw)}.gz`,
      sha256: hash(raw),
      downloadSha256: hash(compressed),
      size: raw.length,
      downloadSize: compressed.length,
    };
  await writeFile(join(pkg, object.path), compressed);
  const manifest = {
    schemaVersion: 1,
    id: 'object-fixture',
    platform: process.platform,
    arch: process.arch,
    version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
    wrapper: 'wrapper.node',
    npmStorage: { format: 'gzip-objects-v1', objects: [object] },
    files: ['wrapper.node', 'nested/duplicate.node'].map((path) => ({
      path,
      url: path,
      sha256: hash(raw),
      size: raw.length,
    })),
  };
  await writeFile(join(pkg, 'manifest.json'), JSON.stringify(manifest));
  return { root, pkg, raw, object, manifest, cache: join(root, 'cache') };
}
test('installed gzip storage coordinates independent processes through real lock without symlinks or native execution', async (t) => {
  const f = await objectFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(
    join(f.root, 'deny-links.cjs'),
    `const fs=require('node:fs');const denied=()=>{const e=new Error('Fixture symlink denial');e.code='EPERM';throw e;};fs.symlink=denied;fs.symlinkSync=denied;fs.promises.symlink=async()=>denied();require('node:module').syncBuiltinESMExports();`,
  );
  await writeFile(
    join(f.root, 'run.mjs'),
    `import{prepareNative}from'./native/native-package.ts';globalThis.fetch=()=>{throw Error('Network forbidden')};try{await(await import('node:fs/promises')).symlink('missing','deny-probe');throw Error('Symlinks were not denied');}catch(e){if(e.code!=='EPERM')throw e;}const native=await prepareNative({cacheDir:process.argv[2]});console.log(JSON.stringify(native));`,
  );
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      execute(
        process.execPath,
        ['--require', join(f.root, 'deny-links.cjs'), join(f.root, 'run.mjs'), f.cache],
        { env, timeout: 20000, maxBuffer: 65536 },
      ),
    ),
  );
  const paths = results.map((r) => JSON.parse(r.stdout).wrapperPath);
  assert.equal(new Set(paths).size, 1);
  assert.deepEqual(await readFile(paths[0]), f.raw);
  assert.deepEqual(await readFile(join(paths[0], '..', 'nested', 'duplicate.node')), f.raw);
  const names = await readdir(f.cache);
  assert.deepEqual(names, ['npm-' + hash(Buffer.from(JSON.stringify(f.manifest)))]);
  assert.deepEqual((await readdir(join(f.cache, names[0]))).sort(), ['nested', 'wrapper.node']);
});
test('installed storage corruption never falls back; explicit version selects catalog and network storage manifests reject', async (t) => {
  const f = await objectFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const { prepareNative } = await import(
    pathToFileURL(join(f.root, 'native/native-package.ts')).href
  );
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error('Forbidden network fallback');
  };
  await assert.rejects(
    prepareNative({
      cacheDir: f.cache,
      version: { ...f.manifest.version, clientVersion: 'wrong' },
    }),
    /Forbidden network fallback/,
  );
  assert.equal(
    calls,
    1,
    'Explicit different version selects its catalog rather than treating installed object as corrupt',
  );
  calls = 0;
  await writeFile(join(f.pkg, f.object.path), 'corrupt');
  await assert.rejects(
    prepareNative({ cacheDir: f.cache }),
    /Invalid installed storage regular file|compressed checksum mismatch/,
  );
  assert.equal(calls, 0);
  const bytes = Buffer.from(JSON.stringify(f.manifest));
  globalThis.fetch = async () => {
    calls++;
    return new Response(bytes);
  };
  await assert.rejects(
    prepareNative({
      cacheDir: f.cache,
      manifestUrl: 'https://example.invalid/manifest.json',
      manifestSha256: hash(bytes),
    }),
    /only supported for installed native packages/,
  );
  assert.equal(calls, 1);
});
