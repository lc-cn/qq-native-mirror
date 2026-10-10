import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  restoreInstalledNativeStorage,
  installedStorageDirectoryParts,
} from '../src/native/native-installed-storage.ts';
import type { NativeManifest } from '../src/types.ts';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-objects-'))),
    pkg = join(root, 'pkg'),
    cache = join(root, 'cache');
  await mkdir(join(pkg, 'objects'), { recursive: true });
  const raw = Buffer.from('one object two independent files'),
    gzip = gzipSync(raw),
    empty = Buffer.alloc(0),
    emptyGzip = gzipSync(empty);
  const objects = [raw, empty].map((b, i) => ({
    path: `objects/${sha(b)}.gz`,
    sha256: sha(b),
    downloadSha256: sha(i === 0 ? gzip : emptyGzip),
    size: b.length,
    downloadSize: (i === 0 ? gzip : emptyGzip).length,
  }));
  await writeFile(join(pkg, objects[0].path), gzip);
  await writeFile(join(pkg, objects[1].path), emptyGzip);
  const manifest: NativeManifest = {
    schemaVersion: 1,
    id: 'fixture',
    platform: process.platform,
    arch: process.arch,
    wrapper: 'wrapper.node',
    version: { clientVersion: '1', appId: '1', qua: '1' },
    npmStorage: { format: 'gzip-objects-v1', objects },
    files: [
      { path: 'wrapper.node', url: 'wrapper.node', sha256: sha(raw), size: raw.length },
      { path: 'nested/copy.node', url: 'nested/copy.node', sha256: sha(raw), size: raw.length },
      { path: 'empty', url: 'empty', sha256: sha(empty), size: 0 },
    ],
  };
  let locks = 0;
  const lock = async () => {
    locks++;
    return async () => {};
  };
  return {
    root,
    pkg,
    cache,
    manifest,
    raw,
    lock,
    locks: () => locks,
    run: () =>
      restoreInstalledNativeStorage(
        pkg,
        Buffer.from(JSON.stringify(manifest)),
        manifest,
        cache,
        lock,
      ),
  };
}
test('concurrent hydration preserves all files, zero bytes, independent inodes and repairs corrupt hit', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([f.run(), f.run()]);
    assert.equal(a, b);
    assert.equal(f.locks(), 1);
    assert.deepEqual(await readFile(join(a, 'wrapper.node')), f.raw);
    assert.equal((await readFile(join(a, 'empty'))).length, 0);
    if (process.platform !== 'win32')
      assert.notEqual(
        (await stat(join(a, 'wrapper.node'))).ino,
        (await stat(join(a, 'nested/copy.node'))).ino,
      );
    await writeFile(join(a, 'wrapper.node'), 'corrupt');
    assert.deepEqual(await readFile(join(a, 'nested/copy.node')), f.raw);
    assert.equal(await f.run(), a);
    assert.deepEqual(await readFile(join(a, 'wrapper.node')), f.raw);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('strict inventory rejects traversal, conflicts, unused object, missing size, invalid bounds and hashes', async () => {
  for (const mutate of [
    (m: NativeManifest) => (m.files[1].path = '../escape'),
    (m: NativeManifest) => (m.files[1].path = 'wrapper.node/child'),
    (m: NativeManifest) => delete m.files[0].size,
    (m: NativeManifest) => (m.npmStorage!.objects[0].path = 'other.gz'),
    (m: NativeManifest) => (m.npmStorage!.objects[0].size = NaN),
    (m: NativeManifest) => (m.npmStorage!.objects[0].size = 512 * 1024 * 1024 + 1),
    (m: NativeManifest) => (m.files = m.files.slice(0, 2)),
    (m: NativeManifest) => (m.npmStorage!.objects[0].downloadSha256 = '0'.repeat(64)),
  ]) {
    const f = await fixture();
    try {
      mutate(f.manifest);
      await assert.rejects(f.run());
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
test('compressed hash, declared decompression upper bound and raw checksum reject before commit', async () => {
  for (const mode of ['compressed', 'bomb', 'raw']) {
    const f = await fixture();
    try {
      const object = f.manifest.npmStorage!.objects[0];
      if (mode === 'compressed') await writeFile(join(f.pkg, object.path), 'corrupt');
      else if (mode === 'bomb') {
        object.size = 1;
        for (const file of f.manifest.files.filter((v) => v.sha256 === object.sha256))
          file.size = 1;
      } else {
        const bad = gzipSync(Buffer.alloc(f.raw.length));
        object.downloadSha256 = sha(bad);
        object.downloadSize = bad.length;
        await writeFile(join(f.pkg, object.path), bad);
      }
      await assert.rejects(f.run());
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
test('object, intermediate cache directory and target symlinks reject without deleting outside data', async (t) => {
  for (const mode of ['object', 'cache-parent', 'target']) {
    const f = await fixture();
    try {
      const outside = join(f.root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'marker'), 'preserve');
      if (mode === 'object') {
        const path = join(f.pkg, f.manifest.npmStorage!.objects[0].path);
        await rm(path);
        await symlink(join(outside, 'marker'), path);
      } else if (mode === 'cache-parent') {
        await symlink(outside, f.cache);
      } else {
        await mkdir(f.cache);
        await symlink(
          outside,
          join(f.cache, 'npm-' + sha(Buffer.from(JSON.stringify(f.manifest)))),
        );
      }
      await assert.rejects(f.run());
      assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'preserve');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Host denies symlink creation; regular hydration tested separately');
        return;
      }
      throw error;
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('Windows directory traversal checks every parent, including UNC roots', () => {
  assert.deepEqual(installedStorageDirectoryParts('C:\\cache\\nested\\object', 'C:\\'), [
    'cache',
    'nested',
    'object',
  ]);
  assert.deepEqual(
    installedStorageDirectoryParts('\\\\server\\share\\cache\\nested', '\\\\server\\share\\'),
    ['cache', 'nested'],
  );
});
