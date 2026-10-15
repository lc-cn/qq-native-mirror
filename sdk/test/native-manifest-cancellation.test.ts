import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createClient } from '../src/client/create-client.ts';
import type * as NativePackage from '../src/native/native-package.ts';
import { copyNativePackageSource } from './helpers/native-package-fixture.ts';

const version = { clientVersion: '1.0.0', appId: '1', qua: 'manifest-cancellation-fixture' };
const manifest = JSON.stringify({
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  version,
  wrapper: 'wrapper.node',
  files: [],
});
// Keep an actual file read in progress; no filesystem, loader or timer substitution.
const manifestBytes = manifest.padEnd(4 * 1024 * 1024, ' ');

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-manifest-cancellation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const download = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Manifest cancellation must not fall back to a network source');
  });
  return { directory, download };
}

async function assertUntouchedDirectories(directory: string): Promise<void> {
  for (const name of ['data', 'cache']) {
    await assert.rejects(access(join(directory, name)), { code: 'ENOENT' });
  }
  assert.ok(
    (await readdir(directory, { recursive: true })).every((file) => !file.endsWith('.node')),
    'The fixture never creates a loadable native file',
  );
}

test('createClient preserves the caller reason when an adjacent manifest read is cancelled', async (t) => {
  const { directory, download } = await fixture(t);
  await writeFile(join(directory, 'manifest.json'), manifestBytes);
  const controller = new AbortController();
  const reason = Object.freeze({ source: 'adjacent-manifest-caller' });
  const creating = createClient(
    {
      dataDir: join(directory, 'data'),
      cacheDir: join(directory, 'cache'),
      wrapperPath: join(directory, 'wrapper.node'),
      version,
    },
    { signal: controller.signal },
  );
  queueMicrotask(() => controller.abort(reason));

  await assert.rejects(creating, (error: unknown) => error === reason);
  await assertUntouchedDirectories(directory);
  assert.equal(download.mock.callCount(), 0);
});

test('installed platform manifest cancellation preserves the caller reason without fallback', async (t) => {
  const { directory, download } = await fixture(t);
  await copyNativePackageSource(directory);
  const name = `qq-native-client-${process.platform}-${process.arch}`;
  const packageDirectory = join(directory, 'node_modules', name);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name, exports: { './manifest.json': './manifest.json' } }),
  );
  await writeFile(join(packageDirectory, 'manifest.json'), manifestBytes);
  const { prepareNative } = (await import(
    pathToFileURL(join(directory, 'native/native-package.ts')).href
  )) as typeof NativePackage;
  const controller = new AbortController();
  const reason = Object.freeze({ source: 'installed-manifest-caller' });
  const preparing = prepareNative(
    { dataDir: join(directory, 'data'), cacheDir: join(directory, 'cache'), version },
    controller.signal,
  );
  queueMicrotask(() => controller.abort(reason));

  await assert.rejects(preparing, (error: unknown) => error === reason);
  await assertUntouchedDirectories(directory);
  assert.equal(download.mock.callCount(), 0);
});
