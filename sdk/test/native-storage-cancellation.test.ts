import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import type { NativeManifest } from '../src/contracts/native.ts';
import type * as Storage from '../src/native/native-installed-storage.ts';
import type * as Verification from '../src/native/native-directory-verification.ts';
import { acquirePackageLock } from '../src/storage/native-package-lock.ts';

type Hook = (operation: string, path: string, phase: 'before' | 'after') => void | Promise<void>;
interface FileHooks {
  configure(hook: Hook): void;
  calls(): { operation: string; path: string }[];
}
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function queued(signal: AbortSignal) {
  const deadline = Date.now() + 2000;
  while (!getEventListeners(signal, 'abort').length) {
    assert.ok(Date.now() < deadline, 'caller must reach its cancellable queue wait');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Real source and real files; the hook only chooses the exact point at which a
// caller cancels or releases an already-started filesystem operation.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-storage-cancel-')));
  try {
    const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const shim = join(root, 'filesystem.mjs');
    await writeFile(
      shim,
      `import * as fs from 'node:fs/promises';
let hook=()=>{}, records=[];
export function configure(value){hook=value;}
export function calls(){return [...records];}
const wrap=name=>async(path,...args)=>{records.push({operation:name,path:String(path)});await hook(name,String(path),'before');const result=await fs[name](path,...args);await hook(name,String(path),'after');return result;};
export const mkdir=wrap('mkdir'),lstat=wrap('lstat'),readFile=wrap('readFile'),writeFile=wrap('writeFile'),rename=wrap('rename'),rm=wrap('rm'),realpath=wrap('realpath');
`,
    );
    const hooks: FileHooks = await import(pathToFileURL(shim).href);
    const modules = [];
    for (const name of ['native-installed-storage.ts', 'native-directory-verification.ts']) {
      let source = await readFile(join(sourceRoot, 'native', name), 'utf8');
      source = source.replace("'node:fs/promises'", JSON.stringify(pathToFileURL(shim).href));
      source = source.replace(/'((?:\.\.\/|\.\/)[^']+)'/g, (_match, relative: string) =>
        JSON.stringify(new URL(relative, pathToFileURL(join(sourceRoot, 'native', name))).href),
      );
      const copy = join(root, name);
      await writeFile(copy, source);
      modules.push(pathToFileURL(copy).href);
    }
    const storage: typeof Storage = await import(modules[0]);
    const verification: typeof Verification = await import(modules[1]);
    const pkg = join(root, 'pkg');
    const cache = join(root, 'cache');
    await mkdir(join(pkg, 'objects'), { recursive: true });
    const raw = Buffer.from('independent cancellable installation');
    const compressed = gzipSync(raw);
    const object = {
      path: `objects/${sha(raw)}.gz`,
      sha256: sha(raw),
      downloadSha256: sha(compressed),
      size: raw.length,
      downloadSize: compressed.length,
    };
    await writeFile(join(pkg, object.path), compressed);
    const manifest: NativeManifest = {
      schemaVersion: 1,
      id: 'cancelled-fixture',
      platform: process.platform,
      arch: process.arch,
      wrapper: 'wrapper.node',
      version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
      files: [{ path: 'wrapper.node', url: 'wrapper.node', sha256: sha(raw), size: raw.length }],
      npmStorage: { format: 'gzip-objects-v1', objects: [object] },
    };
    const body = Buffer.from(JSON.stringify(manifest));
    const target = join(cache, `npm-${sha(body)}`);
    return {
      root,
      pkg,
      cache,
      target,
      raw,
      manifest,
      hooks,
      restore: (signal?: AbortSignal, lock = acquirePackageLock) =>
        storage.restoreInstalledNativeStorage(pkg, body, manifest, cache, lock, signal),
      verify: (signal?: AbortSignal) =>
        verification.verifyNativeDirectory(target, manifest, 'installed', signal),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('pre-cancelled storage and verification perform no filesystem work', async () => {
  const f = await fixture();
  try {
    const reason = new Error('already cancelled');
    const signal = AbortSignal.abort(reason);
    await assert.rejects(f.restore(signal), (e) => e === reason);
    await assert.rejects(f.verify(signal), (e) => e === reason);
    assert.deepEqual(f.hooks.calls(), []);
    assert.deepEqual(
      (await readdir(f.root)).filter((name) => name === 'cache'),
      [],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a cancelled middle waiter cannot bypass the active owner or poison a successor', async () => {
  const f = await fixture();
  const entered = deferred();
  const resume = deferred();
  const middle = new AbortController();
  const next = new AbortController();
  let acquisitions = 0;
  let releases = 0;
  const lock = async (target: string, signal?: AbortSignal) => {
    acquisitions++;
    const release = await acquirePackageLock(target, signal);
    if (acquisitions === 1) {
      entered.resolve();
      await resume.promise;
    }
    return async () => {
      releases++;
      await release();
    };
  };
  const owner = f.restore(undefined, lock);
  try {
    await entered.promise;
    const waiting = f.restore(middle.signal, lock);
    // Its abort listener is attached only after preflight reaches the queue.
    await queued(middle.signal);
    const reason = new Error('middle caller cancelled');
    const rejected = assert.rejects(waiting, (e) => e === reason);
    middle.abort(reason);
    await rejected;
    const successor = f.restore(next.signal, lock);
    await queued(next.signal);
    assert.equal(acquisitions, 1);
    assert.equal(releases, 0);
    resume.resolve();
    assert.deepEqual(await Promise.all([owner, successor]), [f.target, f.target]);
    assert.equal(acquisitions, 2);
    assert.equal(releases, 2);
    assert.equal(getEventListeners(middle.signal, 'abort').length, 0);
    assert.deepEqual(await readFile(join(f.target, 'wrapper.node')), f.raw);
    assert.deepEqual(await readdir(f.cache), [f.target.slice(f.cache.length + 1)]);
  } finally {
    resume.resolve();
    await owner.catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});

test('cancelling an active hydration cleans its staging before a queued caller succeeds', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const entered = deferred();
  const resume = deferred();
  let first = true;
  const reason = new Error('cancel active hydration');
  f.hooks.configure(async (operation, path, phase) => {
    if (first && operation === 'writeFile' && phase === 'after' && path.endsWith('wrapper.node')) {
      first = false;
      entered.resolve();
      await resume.promise;
    }
  });
  const owner = f.restore(controller.signal);
  const rejected = assert.rejects(owner, (e) => e === reason);
  try {
    await entered.promise;
    const successor = f.restore();
    controller.abort(reason);
    resume.resolve();
    await rejected;
    assert.equal(await successor, f.target);
    const operations = f.hooks.calls();
    const stagingCleanup = operations.findIndex(
      (call) => call.operation === 'rm' && call.path.includes('.npm-'),
    );
    const writes = operations.flatMap((call, index) =>
      call.operation === 'writeFile' ? [index] : [],
    );
    assert.equal(writes.length, 2);
    assert.ok(stagingCleanup > writes[0] && stagingCleanup < writes[1]);
    assert.deepEqual(await readFile(join(f.target, 'wrapper.node')), f.raw);
    assert.deepEqual(await readdir(f.cache), [f.target.slice(f.cache.length + 1)]);
  } finally {
    resume.resolve();
    await rejected;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a lock returned after cancellation is released before the next caller enters', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const next = new AbortController();
  const acquired = deferred();
  const resume = deferred();
  const reason = new Error('cancel before acquired lock returns');
  let acquisitions = 0;
  let releases = 0;
  const lock = async (target: string, signal?: AbortSignal) => {
    assert.equal(releases, acquisitions);
    const first = ++acquisitions === 1;
    const release = await acquirePackageLock(target, signal);
    if (first) {
      acquired.resolve();
      await resume.promise;
    }
    return async () => {
      releases++;
      await release();
    };
  };
  const owner = f.restore(controller.signal, lock);
  const rejected = assert.rejects(owner, (e) => e === reason);
  try {
    await acquired.promise;
    const successor = f.restore(next.signal, lock);
    await queued(next.signal);
    controller.abort(reason);
    resume.resolve();
    await rejected;
    assert.equal(await successor, f.target);
    assert.equal(acquisitions, 2);
    assert.equal(releases, 2);
    assert.equal(f.hooks.calls().filter((call) => call.operation === 'writeFile').length, 1);
    assert.deepEqual(await readdir(f.cache), [f.target.slice(f.cache.length + 1)]);
  } finally {
    resume.resolve();
    await rejected;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a successor validates and repairs a cache changed after its predecessor completed', async () => {
  const f = await fixture();
  let acquisitions = 0;
  const lock = async (target: string, signal?: AbortSignal) => {
    const release = await acquirePackageLock(target, signal);
    const first = ++acquisitions === 1;
    return async () => {
      if (first) await writeFile(join(target, 'wrapper.node'), 'corruption after first validation');
      await release();
    };
  };
  try {
    assert.deepEqual(await Promise.all([f.restore(undefined, lock), f.restore(undefined, lock)]), [
      f.target,
      f.target,
    ]);
    assert.equal(acquisitions, 2);
    assert.equal(f.hooks.calls().filter((call) => call.operation === 'writeFile').length, 2);
    assert.deepEqual(await readFile(join(f.target, 'wrapper.node')), f.raw);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('cancellation during commit rejects but retains the fully published cache', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const reason = new Error('cancel after rename');
  f.hooks.configure((operation, _path, phase) => {
    if (operation === 'rename' && phase === 'after') controller.abort(reason);
  });
  try {
    await assert.rejects(f.restore(controller.signal), (e) => e === reason);
    assert.deepEqual(await readFile(join(f.target, 'wrapper.node')), f.raw);
    assert.deepEqual(await readdir(f.cache), [f.target.slice(f.cache.length + 1)]);
    assert.equal(await f.restore(), f.target);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('cancelling cache verification retains an opaque reason and never removes the valid target', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    await f.restore();
    const offset = f.hooks.calls().length;
    f.hooks.configure((operation, path, phase) => {
      if (operation === 'readFile' && path === join(f.target, 'wrapper.node') && phase === 'after')
        controller.abort(null);
    });
    await assert.rejects(f.restore(controller.signal), (e) => e === null);
    assert.equal(
      f.hooks
        .calls()
        .slice(offset)
        .some((call) => call.operation === 'rm'),
      false,
    );
    assert.deepEqual(await readFile(join(f.target, 'wrapper.node')), f.raw);
    assert.deepEqual(await readdir(f.cache), [f.target.slice(f.cache.length + 1)]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('active cancellation preserves staging and release failures while releasing the real lock', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const reason = Object.freeze({ cancelled: 'write complete' });
  const staging = new Error('staging cleanup failed');
  const releasing = new Error('release cleanup failed');
  let releases = 0;
  f.hooks.configure((operation, path, phase) => {
    if (operation === 'writeFile' && phase === 'after') controller.abort(reason);
    if (operation === 'rm' && path.includes('.npm-') && phase === 'before') throw staging;
  });
  const lock = async (target: string, signal?: AbortSignal) => {
    const release = await acquirePackageLock(target, signal);
    return async () => {
      releases++;
      await release();
      throw releasing;
    };
  };
  const retained = (error: unknown): unknown[] =>
    error instanceof AggregateError ? error.errors.flatMap(retained) : [error];
  try {
    await assert.rejects(f.restore(controller.signal, lock), (error: unknown) => {
      assert.deepEqual(retained(error), [reason, staging, releasing]);
      return true;
    });
    assert.equal(releases, 1);
    assert.equal(
      (await readdir(f.cache)).some((name) => name.endsWith('.lock')),
      false,
    );
    f.hooks.configure(() => {});
    assert.equal(await f.restore(), f.target);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const stage of ['realpath', 'lstat', 'readFile']) {
  test(`directory verification observes cancellation after ${stage} without returning success`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error(`cancel after ${stage}`);
    try {
      await f.restore();
      const offset = f.hooks.calls().length;
      f.hooks.configure((operation, _path, phase) => {
        if (operation === stage && phase === 'after') controller.abort(reason);
      });
      await assert.rejects(f.verify(controller.signal), (e) => e === reason);
      const calls = f.hooks
        .calls()
        .slice(offset)
        .map((call) => call.operation);
      assert.deepEqual(
        calls,
        ['realpath', 'lstat', 'readFile'].slice(
          0,
          ['realpath', 'lstat', 'readFile'].indexOf(stage) + 1,
        ),
      );
      assert.deepEqual(await readFile(join(f.target, 'wrapper.node')), f.raw);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
