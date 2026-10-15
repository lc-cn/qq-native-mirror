import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { NativeManifest } from '../src/contracts/native.ts';
import { prepareNative } from '../src/native/native-package.ts';
import { resolveNativeCatalog } from '../src/native/native-catalog.ts';
import { installVerifiedBundle } from '../src/native/native-bundle-installer.ts';
import { waitWithSignal } from '../src/runtime/abort.ts';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const payload = Buffer.from('controlled native bytes; never loaded');
const manifest: NativeManifest = {
  schemaVersion: 1,
  id: 'cancel-fixture',
  platform: process.platform,
  arch: process.arch,
  version: { clientVersion: '1.0.0', appId: '1', qua: 'fixture' },
  wrapper: 'wrapper.node',
  files: [
    { path: 'wrapper.node', url: 'wrapper.node', sha256: sha(payload), size: payload.length },
  ],
};
const bytes = Buffer.from(JSON.stringify(manifest));

test('pre-aborted native source does not fetch or create directories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-pre-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('unexpected request');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const reason = new Error('already cancelled');
  const options = { dataDir: join(directory, 'data'), cacheDir: join(directory, 'cache') };
  await assert.rejects(
    prepareNative(options, AbortSignal.abort(reason)),
    (error) => error === reason,
  );
  await assert.rejects(
    resolveNativeCatalog(options, AbortSignal.abort(reason)),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('catalog cancellation before headers preserves caller reason and never starts another request', async (t) => {
  const original = globalThis.fetch;
  const started = deferred<void>();
  const never = deferred<Response>();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    started.resolve();
    assert.ok(options?.signal);
    return waitWithSignal(never.promise, options.signal);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const controller = new AbortController();
  const reason = Object.freeze({ cancelled: true });
  const pending = resolveNativeCatalog({ dataDir: '/unused' }, controller.signal);
  const rejected = assert.rejects(pending, (error) => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(calls, 1);
  never.resolve(new Response('{}'));
});

test('manifest body cancellation releases the response without creating a cache', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-manifest-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  const started = deferred<void>();
  let cancels = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          started.resolve();
        },
        cancel() {
          cancels++;
        },
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const controller = new AbortController();
  const reason = new Error('cancel manifest body');
  const pending = prepareNative(
    {
      dataDir: join(directory, 'data'),
      cacheDir: join(directory, 'cache'),
      manifestUrl: 'https://fixture.invalid/manifest.json',
      manifestSha256: sha(bytes),
    },
    controller.signal,
  );
  const rejected = assert.rejects(pending, (error) => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(calls, 1);
  assert.equal(cancels, 1);
  assert.deepEqual(await readdir(directory), []);
});

test('payload cancellation does not fall through to another configured mirror or publish a partial bundle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-payload-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  const started = deferred<void>();
  const requests: string[] = [];
  let cancels = 0;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url) === 'https://fixture.invalid/manifest.json') return new Response(bytes);
    return new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          started.resolve();
        },
        cancel() {
          cancels++;
        },
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const controller = new AbortController();
  const reason = new Error('cancel payload body');
  const cache = join(directory, 'cache');
  const pending = prepareNative(
    {
      dataDir: join(directory, 'data'),
      cacheDir: cache,
      manifestUrl: 'https://fixture.invalid/manifest.json',
      manifestSha256: sha(bytes),
      downloadMirrors: ['https://first.invalid/', 'https://second.invalid/'],
    },
    controller.signal,
  );
  const rejected = assert.rejects(pending, (error) => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejected;
  assert.deepEqual(requests, [
    'https://fixture.invalid/manifest.json',
    'https://first.invalid/https://fixture.invalid/wrapper.node',
  ]);
  assert.equal(cancels, 1);
  assert.deepEqual(await readdir(cache), ['.contents']);
  assert.deepEqual(await readdir(join(cache, '.contents')), []);
});

test('a cancelled installer releases its own work and leaves the next caller able to install', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-install-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const started = deferred<void>();
  const never = deferred<Buffer>();
  let laterDownloads = 0;
  const common = {
    manifestBytes: bytes,
    manifest,
    manifestUrl: 'https://fixture.invalid/manifest.json',
    cacheDir: directory,
    mirrors: [],
  };
  const first = installVerifiedBundle({
    ...common,
    signal: controller.signal,
    download: async () => {
      started.resolve();
      return waitWithSignal(never.promise, controller.signal);
    },
  });
  const reason = new Error('first caller stopped');
  const rejected = assert.rejects(first, (error) => error === reason);
  await started.promise;
  const next = installVerifiedBundle({
    ...common,
    download: async () => {
      laterDownloads++;
      return payload;
    },
  });
  controller.abort(reason);
  await rejected;
  const installed = await next;
  assert.equal(laterDownloads, 1);
  assert.deepEqual(await readFile(join(installed, 'wrapper.node')), payload);
  assert.deepEqual((await readdir(directory)).sort(), ['.contents', sha(bytes)].sort());
  assert.deepEqual(await readdir(join(directory, '.contents')), [sha(payload)]);
  never.resolve(payload);
});

test('payload cancellation keeps its response cleanup failure through installation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-payload-cleanup-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  const started = deferred<void>();
  const cleanup = new Error('response cleanup failed');
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    if (String(url) === 'https://fixture.invalid/manifest.json') return new Response(bytes);
    return new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          started.resolve();
        },
        cancel() {
          throw cleanup;
        },
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const controller = new AbortController();
  const reason = new Error('cancelled with cleanup failure');
  const cache = join(directory, 'cache');
  const pending = prepareNative(
    {
      dataDir: join(directory, 'data'),
      cacheDir: cache,
      manifestUrl: 'https://fixture.invalid/manifest.json',
      manifestSha256: sha(bytes),
      downloadMirrors: ['https://first.invalid/', 'https://second.invalid/'],
    },
    controller.signal,
  );
  const rejected = assert.rejects(pending, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [reason, cleanup]);
    return true;
  });
  await started.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(requests, 2);
  assert.deepEqual(await readdir(cache), ['.contents']);
});

test('a later parallel worker cannot lose its cleanup failure behind the first cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-parallel-cleanup-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  const cleanup = new Error('second response cleanup failed');
  const reason = new Error('cancel parallel downloads');
  const started = deferred<void>();
  let bodies = 0;
  let cancellations = 0;
  const other = Buffer.from('another never-loaded resource');
  const parallelBytes = Buffer.from(
    JSON.stringify({
      ...manifest,
      files: [
        ...manifest.files,
        { path: 'other.dat', url: 'other.dat', sha256: sha(other), size: other.length },
      ],
    }),
  );
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://fixture.invalid/manifest.json') return new Response(parallelBytes);
    return new Response(
      new ReadableStream<Uint8Array>({
        start() {
          if (++bodies === 2) started.resolve();
        },
        cancel() {
          cancellations++;
          if (String(url).endsWith('/other.dat')) throw cleanup;
        },
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const controller = new AbortController();
  const cache = join(directory, 'cache');
  const pending = prepareNative(
    {
      dataDir: join(directory, 'data'),
      cacheDir: cache,
      manifestUrl: 'https://fixture.invalid/manifest.json',
      manifestSha256: sha(parallelBytes),
    },
    controller.signal,
  );
  const rejected = assert.rejects(pending, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], reason);
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.deepEqual(error.errors[1].errors, [reason, cleanup]);
    return true;
  });
  await started.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(cancellations, 2);
  assert.deepEqual(await readdir(cache), ['.contents']);
});
