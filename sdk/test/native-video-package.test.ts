import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { prepareNative } from '../src/native/native-package.ts';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const version = { clientVersion: 'fixture', appId: '1', qua: 'fixture' };
const payloads = new Map([
  ['wrapper.node', Buffer.from('fake wrapper never loaded')],
  ['video/codec.node', Buffer.from('fake codec never loaded')],
  ['lib/dependency.bin', Buffer.from('dependency')],
]);
function manifest(): any {
  return {
    schemaVersion: 1,
    id: 'video-fixture',
    platform: process.platform,
    arch: process.arch,
    wrapper: 'wrapper.node',
    videoCodec: 'video/codec.node',
    version,
    files: [...payloads].map(([path, bytes]) => ({
      path,
      url: `./${path}`,
      sha256: hash(bytes),
      size: bytes.length,
    })),
  };
}
async function writeBundle(base: string, value: any) {
  await mkdir(base, { recursive: true });
  for (const [path, bytes] of payloads) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), bytes);
  }
  await writeFile(join(base, 'manifest.json'), JSON.stringify(value));
}
async function installedFixture(t: any, value = manifest()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-installed-video-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  for (const name of [
    'native/native-installed-storage.ts',
    'native/native-package.ts',
    'native/native-catalog.ts',
    'storage/process-lock.ts',
    'types.ts',
  ]) {
    const target = join(root, 'src', name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(new URL(`../src/${name}`, import.meta.url), target);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const base = join(root, 'node_modules', `qq-native-client-${process.platform}-${process.arch}`);
  await writeBundle(base, value);
  await writeFile(
    join(base, 'package.json'),
    JSON.stringify({
      name: `qq-native-client-${process.platform}-${process.arch}`,
      version: '0.0.0',
      exports: { './manifest.json': './manifest.json' },
    }),
  );
  const module = await import(pathToFileURL(join(root, 'src/native/native-package.ts')).href);
  return { root, base, prepare: module.prepareNative };
}
for (const entry of ['installed', 'local'] as const) {
  test(`${entry} bundle discovers listed codec and old manifest remains compatible`, async (t) => {
    const f = await installedFixture(t);
    const options =
      entry === 'local'
        ? { wrapperPath: join(f.base, 'wrapper.node'), dataDir: f.root }
        : { dataDir: f.root };
    const result = await f.prepare(options);
    assert.equal(result.videoCodecPath, join(f.base, 'video/codec.node'));
    const old = manifest();
    delete old.videoCodec;
    await writeFile(join(f.base, 'manifest.json'), JSON.stringify(old));
    assert.equal((await f.prepare(options)).videoCodecPath, undefined);
  });
  for (const invalid of ['../outside.node', '/outside.node', 'video\\codec.node', 'missing.node']) {
    test(`${entry} rejects codec path ${JSON.stringify(invalid)} before discovery`, async (t) => {
      const value = manifest();
      value.videoCodec = invalid;
      const f = await installedFixture(t, value);
      const options =
        entry === 'local'
          ? { wrapperPath: join(f.base, 'wrapper.node'), dataDir: f.root }
          : { dataDir: f.root };
      await assert.rejects(f.prepare(options), /path|codec|manifest|listed|missing/i);
    });
  }
  test(`${entry} codec discovery verifies all files and rejects symlink escape`, async (t) => {
    const f = await installedFixture(t);
    const options =
      entry === 'local'
        ? { wrapperPath: join(f.base, 'wrapper.node'), dataDir: f.root }
        : { dataDir: f.root };
    for (const path of ['video/codec.node', 'lib/dependency.bin']) {
      await writeFile(join(f.base, path), 'corrupt');
      await assert.rejects(f.prepare(options), /verification|hash|digest|file/i);
      await writeFile(join(f.base, path), payloads.get(path)!);
    }
    const codec = join(f.base, 'video/codec.node'),
      outside = join(f.root, 'outside.node');
    await writeFile(outside, payloads.get('video/codec.node')!);
    await rm(codec);
    await symlink(outside, codec);
    await assert.rejects(f.prepare(options), /verification|path|file|escape/i);
  });
}

test('explicit wrapper rejects mismatched version and legacy adjacent manifest without files/codec still works', async (t) => {
  const f = await installedFixture(t),
    wrapperPath = join(f.base, 'wrapper.node');
  await assert.rejects(
    f.prepare({ wrapperPath, dataDir: f.root, version: { ...version, qua: 'different' } }),
    /does not match|mismatch/i,
  );
  const old = manifest();
  delete old.files;
  delete old.videoCodec;
  await writeFile(join(f.base, 'manifest.json'), JSON.stringify(old));
  const result = await f.prepare({ wrapperPath, dataDir: f.root });
  assert.deepEqual(result.version, version);
  assert.equal(result.videoCodecPath, undefined);
});

test('trusted mirror discovers codec, repairs corrupted and escaped cache, and validates codec declaration', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-mirror-video-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let value = manifest(),
    requests = 0;
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/manifest.json') return new Response(JSON.stringify(value));
    requests++;
    const bytes = payloads.get(path.slice(1));
    return bytes ? new Response(bytes) : new Response('', { status: 404 });
  };
  const options = () => ({
    dataDir: root,
    cacheDir: join(root, 'cache'),
    manifestUrl: 'https://offline.fixture/manifest.json',
    manifestSha256: hash(JSON.stringify(value)),
  });
  const result: any = await prepareNative(options());
  assert.equal(result.videoCodecPath, join(dirname(result.wrapperPath), 'video/codec.node'));
  assert.equal(requests, 3);
  await writeFile(result.videoCodecPath, 'corrupt');
  assert.equal(((await prepareNative(options())) as any).videoCodecPath, result.videoCodecPath);
  assert.deepEqual(await readFile(result.videoCodecPath), payloads.get('video/codec.node'));
  const outside = join(root, 'outside.node');
  await writeFile(outside, payloads.get('video/codec.node')!);
  await rm(result.videoCodecPath);
  await symlink(outside, result.videoCodecPath);
  await prepareNative(options());
  assert.deepEqual(await readFile(result.videoCodecPath), payloads.get('video/codec.node'));
  assert.equal(requests, 3, 'validated content cache avoids refetch');
  for (const invalid of ['../escape.node', 'missing.node']) {
    value = { ...manifest(), videoCodec: invalid };
    await assert.rejects(prepareNative(options()), /path|codec|listed|missing|manifest/i);
  }
  value = manifest();
  delete value.videoCodec;
  assert.equal(((await prepareNative(options())) as any).videoCodecPath, undefined);
});
