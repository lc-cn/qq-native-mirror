import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { stageDeduplicatedPackage } from './dedup-native-npm.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(platform = 'linux') {
  const files = new Map([
    ['wrapper.node', Buffer.from('native')],
    ['video/video-codec.node', Buffer.from('codec')],
    ['video/SOURCE-PROVENANCE.json', Buffer.from('provenance')],
    ['LICENSE.txt', Buffer.from('license')],
  ]);
  if (platform === 'win32')
    for (const path of ['QQNT.dll', 'NODE-LICENSE.txt']) files.set(path, Buffer.from(path));
  const metadata = {
    name: `qq-native-client-${platform}-arm64`,
    version: '0.0.2',
    os: [platform],
    cpu: ['arm64'],
    license: 'UNLICENSED',
    custom: { provenance: ['original'] },
    ...(platform === 'linux' ? { libc: ['glibc'] } : {}),
  };
  const manifest = {
    schemaVersion: 1,
    platform,
    arch: 'arm64',
    wrapper: 'wrapper.node',
    videoCodec: 'video/video-codec.node',
    version: { clientVersion: 'fixed-version', appId: '123', qua: 'fixed-qua' },
    files: [...files].map(([path, bytes]) => ({
      path,
      url: path,
      sha256: sha(bytes),
      size: bytes.length,
      provenance: { source: 'original' },
    })),
    ...(platform === 'win32' ? { nodeVersion: 'v24.20.0', nodeConfigSha256: 'a'.repeat(64) } : {}),
  };
  const source = { metadata, manifest, files };
  sync(source);
  return source;
}
function sync(source) {
  source.files.set('manifest.json', Buffer.from(JSON.stringify(source.manifest)));
  source.files.set('package.json', Buffer.from(JSON.stringify(source.metadata)));
  source.files.set('README.md', Buffer.from('source README'));
}
for (const [label, mutate] of [
  [
    'vendor version',
    (source) => {
      source.manifest.version.clientVersion = 'changed';
    },
  ],
  [
    'nested package metadata',
    (source) => {
      source.metadata.os[0] = 'changed';
      source.metadata.cpu[0] = 'changed';
      source.metadata.libc[0] = 'changed';
      source.metadata.custom.provenance[0] = 'changed';
    },
  ],
  [
    'nested file metadata',
    (source) => {
      source.manifest.files[0].provenance.source = 'changed';
      source.manifest.files[0].path = 'changed.node';
    },
  ],
])
  test(`stage captures validated ${label} before its first await`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'storage-snapshot-'));
    try {
      const source = fixture();
      const original = JSON.parse(source.files.get('manifest.json'));
      const originalPackage = JSON.parse(source.files.get('package.json'));
      const destination = join(root, 'candidate');
      const pending = stageDeduplicatedPackage(source, destination);
      mutate(source);
      const staged = await pending;
      const manifest = JSON.parse(await readFile(join(destination, 'manifest.json')));
      const metadata = JSON.parse(await readFile(join(destination, 'package.json')));
      assert.deepEqual(staged.manifest, manifest);
      assert.deepEqual(manifest.version, original.version);
      assert.deepEqual(manifest.files, original.files);
      for (const key of ['os', 'cpu', 'libc', 'custom', 'license'])
        assert.deepEqual(metadata[key], originalPackage[key]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
test('invalid closure, bytes, path collisions and Windows ABI create no destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-invalid-'));
  try {
    const changes = [
      (source) => source.files.set('unlisted', Buffer.from('extra')),
      (source) => source.files.set('wrapper.node', Buffer.from('corrupt')),
      (source) => {
        const bytes = Buffer.from('nested');
        source.files.set('wrapper.node/child', bytes);
        source.manifest.files.push({
          path: 'wrapper.node/child',
          url: 'wrapper.node/child',
          sha256: sha(bytes),
          size: bytes.length,
        });
        sync(source);
      },
      (source) => {
        source.manifest.nodeConfigSha256 = 'invalid';
        sync(source);
      },
    ];
    for (const [index, change] of changes.entries()) {
      const source = fixture('win32');
      change(source);
      const destination = join(root, `invalid-${index}`);
      await assert.rejects(stageDeduplicatedPackage(source, destination));
      await assert.rejects(access(destination), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('valid Linux libc and Windows ABI and license inventories remain intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-platform-'));
  try {
    for (const platform of ['linux', 'win32']) {
      const source = fixture(platform),
        destination = join(root, platform);
      await stageDeduplicatedPackage(source, destination);
      const manifest = JSON.parse(await readFile(join(destination, 'manifest.json')));
      const metadata = JSON.parse(await readFile(join(destination, 'package.json')));
      assert.equal(metadata.license, 'UNLICENSED');
      assert.ok(manifest.files.some((file) => file.path === 'LICENSE.txt'));
      if (platform === 'linux') assert.deepEqual(metadata.libc, ['glibc']);
      else {
        assert.equal(manifest.nodeVersion, 'v24.20.0');
        assert.equal(manifest.nodeConfigSha256, 'a'.repeat(64));
        assert.ok(manifest.files.some((file) => file.path === 'NODE-LICENSE.txt'));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stage owns compressed bytes before caller mutates buffers and clears its map', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-buffer-'));
  try {
    const source = fixture(),
      destination = join(root, 'candidate');
    const original = Buffer.from(source.files.get('wrapper.node'));
    const digest = sha(original);
    const pending = stageDeduplicatedPackage(source, destination);
    source.files.get('wrapper.node').fill(0);
    source.files.clear();
    const staged = await pending;
    const object = staged.manifest.npmStorage.objects.find((item) => item.sha256 === digest);
    assert.ok(object);
    assert.deepEqual(gunzipSync(await readFile(join(destination, object.path))), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
