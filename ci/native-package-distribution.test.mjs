import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { packNativeDistribution } from './native-package-distribution.mjs';
import { readNativeTarFiles } from '../sdk/scripts/native-tar-files.mjs';
import { inspectNativeObjectMembers } from '../sdk/scripts/native-object-members.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(root) {
  const directory = join(root, 'source');
  await mkdir(directory);
  const raw = new Map([
    ['wrapper.node', Buffer.from('not executable')],
    ['video/video-codec.node', Buffer.from('codec fixture')],
    ['video/SOURCE-PROVENANCE.json', Buffer.from('provenance')],
    ['_CodeSignature/CodeResources', Buffer.from('original seal')],
    ['LICENSE.txt', Buffer.from('original license')],
    ['alias.node', Buffer.from('not executable')],
  ]);
  const manifest = {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    wrapper: 'wrapper.node',
    videoCodec: 'video/video-codec.node',
    version: { clientVersion: 'fixed', appId: '1', qua: 'fixed' },
    files: [...raw].map(([path, bytes]) => ({
      path,
      url: path,
      sha256: sha(bytes),
      size: bytes.length,
    })),
  };
  const metadata = {
    name: 'qq-native-client-linux-x64',
    version: '0.0.2',
    os: ['linux'],
    cpu: ['x64'],
    libc: ['glibc'],
    license: 'UNLICENSED',
    files: [...raw.keys(), 'manifest.json', 'README.md'],
  };
  for (const [path, bytes] of [
    ...raw,
    ['manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['package.json', Buffer.from(JSON.stringify(metadata))],
    ['README.md', Buffer.from('fixture README')],
  ]) {
    const parts = path.split('/');
    await mkdir(join(directory, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(directory, path), bytes);
  }
  return { directory, raw, manifest };
}
for (const storage of ['plain', 'gzip-objects-v1'])
  test(`offline distribution packs ${storage} with complete original bytes`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'distribution-good-'));
    try {
      const f = await fixture(root),
        output = join(root, 'output');
      const result = await packNativeDistribution(f.directory, output, { storage });
      assert.equal(result.storage, storage);
      assert.equal(result.originalPaths, f.raw.size);
      const bytes = await readFile(join(output, result.tarball));
      assert.equal(result.sha256, sha(bytes));
      assert.equal(result.size, bytes.length);
      const members = await readNativeTarFiles(join(output, result.tarball));
      const manifest = JSON.parse(members.get('package/manifest.json'));
      assert.equal(result.manifestSha256, sha(members.get('package/manifest.json')));
      if (storage === 'plain') {
        for (const [path, raw] of f.raw) assert.deepEqual(members.get(`package/${path}`), raw);
        assert.equal(result.fullNativeFallback, undefined);
      } else {
        assert.equal(result.objectCount, 5);
        const restored = inspectNativeObjectMembers(members, manifest, [...f.raw.keys()]);
        for (const [path, raw] of f.raw) assert.deepEqual(restored.get(`package/${path}`), raw);
        assert.ok(result.fullNativeFallback);
        assert.equal(result.fullNativeFallback.path, `full-native/${result.tarball}`);
        const fallbackBytes = await readFile(join(output, result.fullNativeFallback.path));
        assert.equal(result.fullNativeFallback.sha256, sha(fallbackBytes));
        assert.equal(result.fullNativeFallback.size, fallbackBytes.length);
        const fallback = await readNativeTarFiles(join(output, result.fullNativeFallback.path));
        assert.equal(
          result.fullNativeFallback.manifestSha256,
          sha(fallback.get('package/manifest.json')),
        );
        for (const [path, raw] of f.raw) assert.deepEqual(fallback.get(`package/${path}`), raw);
        assert.deepEqual(JSON.parse(fallback.get('package/manifest.json')), f.manifest);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
test('distribution rejects unsupported mode and invalid source before producing a candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'distribution-invalid-'));
  try {
    for (const mode of ['mode', 'closure', 'corrupt']) {
      const caseRoot = join(root, mode);
      await mkdir(caseRoot);
      const f = await fixture(caseRoot),
        output = join(caseRoot, 'output');
      if (mode === 'closure') await writeFile(join(f.directory, 'unlisted.txt'), 'unlisted');
      if (mode === 'corrupt') await writeFile(join(f.directory, 'wrapper.node'), 'corrupt');
      await assert.rejects(
        packNativeDistribution(f.directory, output, {
          storage: mode === 'mode' ? 'unsupported' : 'gzip-objects-v1',
        }),
      );
      await assert.rejects(access(output), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('distribution refuses an existing destination without replacing user files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'distribution-existing-'));
  try {
    const f = await fixture(root),
      output = join(root, 'output');
    await mkdir(output);
    await writeFile(join(output, 'keep.txt'), 'keep');
    await assert.rejects(
      packNativeDistribution(f.directory, output, { storage: 'gzip-objects-v1' }),
    );
    assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
