import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { planCompressedNative } from '../scripts/prepare-npm-native-mirror.mjs';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const data = new Map([
    ['wrapper.node', Buffer.from('vendor')],
    ['alias.node', Buffer.from('vendor')],
    ['video/video-codec.node', Buffer.from('codec')],
    ['video/SOURCE-PROVENANCE.json', Buffer.from('{"materials":"preserved"}')],
  ]);
  const manifest = {
    schemaVersion: 1,
    id: 'old',
    platform: 'linux',
    arch: 'arm64',
    wrapper: 'wrapper.node',
    videoCodec: 'video/video-codec.node',
    version: { clientVersion: '3.2.32-52194', appId: '123', qua: 'original' },
    files: [...data].map(([path, b]) => ({ path, url: path, sha256: sha(b), size: b.length })),
  };
  return { data, manifest };
}
const options = {
  version: '0.0.3',
  runId: '123',
  runAttempt: 1,
  tag: 'native-npm-v0.0.3-ci-123-attempt-1',
};
test('codec mirror preserves runtime/provenance and deterministically deduplicates raw content', () => {
  const { data, manifest } = fixture();
  const run = () =>
    planCompressedNative(manifest, 'linux-arm64', (p: string) => data.get(p), options);
  const a = run(),
    b = run();
  assert.deepEqual(a, b);
  assert.equal(a.assets.length, 3);
  assert.deepEqual(a.manifest.version, manifest.version);
  assert.equal(a.manifest.videoCodec, manifest.videoCodec);
  assert.deepEqual(manifest.id, 'old');
  for (const f of a.manifest.files) {
    const asset = a.assets.find((x: any) => x.rawSha256 === f.sha256);
    assert.deepEqual(gunzipSync(asset.bytes), data.get(f.path));
    assert.equal(f.size, data.get(f.path)?.length);
    assert.equal(f.downloadSha256, sha(asset.bytes));
    assert.equal(f.encoding, 'gzip');
  }
  assert.match(
    a.repoPath,
    /npm-0.0.3-ci-123-attempt-1-linux-arm64-codec-gzip-v1\/[a-f0-9]{64}\/manifest.json/,
  );
});
test('rejects corrupt bytes, missing codec, collision and traversal before staging', () => {
  for (const mutate of [
    (m: any) => (m.files[0].sha256 = '0'.repeat(64)),
    (m: any) => (m.videoCodec = 'missing.node'),
    (m: any) => m.files.push({ ...m.files[0], path: 'video' }),
    (m: any) => (m.files[0].path = '../wrapper.node'),
    (m: any) => m.files.push(m.files[0]),
  ]) {
    const { data, manifest } = fixture();
    mutate(manifest);
    assert.throws(() =>
      planCompressedNative(manifest, 'linux-arm64', (p: string) => data.get(p), options),
    );
  }
});
test('Windows adapter exact ABI and license remain mandatory', () => {
  const { data, manifest } = fixture();
  Object.assign(manifest, { platform: 'win32', arch: 'x64' });
  assert.throws(
    () => planCompressedNative(manifest, 'win32-x64', (p: string) => data.get(p), options),
    /Windows/,
  );
  for (const name of ['QQNT.dll', 'NODE-LICENSE.txt']) {
    const b = Buffer.from(name);
    data.set(name, b);
    manifest.files.push({ path: name, url: name, sha256: sha(b), size: b.length });
  }
  Object.assign(manifest, { nodeVersion: 'v24.20.0', nodeConfigSha256: 'a'.repeat(64) });
  const result = planCompressedNative(manifest, 'win32-x64', (p: string) => data.get(p), options);
  assert.equal(result.manifest.nodeVersion, 'v24.20.0');
  assert.equal(result.manifest.nodeConfigSha256, 'a'.repeat(64));
});
test('prepare rejects nested and nonempty output before release validation or online access', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { prepareNpmNativeMirror } = await import('../scripts/prepare-npm-native-mirror.mjs');
  const base = await mkdtemp(join(tmpdir(), 'mirror-plan-test-'));
  let online = 0;
  try {
    const input = join(base, 'input');
    await mkdir(input);
    await assert.rejects(
      prepareNpmNativeMirror(input, join(input, 'out'), {
        verifyOnline: async () => {
          online++;
        },
      }),
      /contain/,
    );
    const out = join(base, 'out');
    await mkdir(out);
    await writeFile(join(out, 'owned'), 'preserve');
    await assert.rejects(
      prepareNpmNativeMirror(input, out, {
        verifyOnline: async () => {
          online++;
        },
      }),
      /empty/,
    );
    assert.equal(online, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
