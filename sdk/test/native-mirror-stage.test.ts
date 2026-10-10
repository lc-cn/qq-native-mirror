import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { planCompressedNative } from '../scripts/prepare-npm-native-mirror.mjs';
import {
  verifyStagedAsset,
  verifyStagedManifest,
} from '../scripts/verify-npm-native-mirror-stage.mjs';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const data = new Map([
    ['wrapper.node', Buffer.from('fake wrapper')],
    ['video/video-codec.node', Buffer.from('fake codec')],
    ['video/SOURCE-PROVENANCE.json', Buffer.from('fake provenance')],
    ['empty', Buffer.alloc(0)],
    ['QQNT.dll', Buffer.from('fake bridge')],
    ['NODE-LICENSE.txt', Buffer.from('fake license')],
  ]);
  const original = {
    schemaVersion: 1,
    id: 'original',
    platform: 'win32',
    arch: 'arm64',
    wrapper: 'wrapper.node',
    videoCodec: 'video/video-codec.node',
    nodeVersion: 'v24.20.0',
    nodeConfigSha256: 'b'.repeat(64),
    version: { clientVersion: 'fixture', appId: '1', qua: 'fixed' },
    files: [...data].map(([path, bytes]) => ({
      path,
      url: `https://vendor.invalid/${path}`,
      sha256: sha(bytes),
      size: bytes.length,
    })),
  };
  const identity = {
    version: '0.0.3',
    runId: '123',
    runAttempt: 1,
    tag: 'native-npm-v0.0.3-ci-123-attempt-1',
  };
  const planned = planCompressedNative(
    original,
    'win32-arm64',
    (path: string) => data.get(path),
    identity,
  );
  const assets = new Map<string, any>(planned.assets.map((asset: any) => [asset.name, asset]));
  const row = {
    platform: 'win32',
    arch: 'arm64',
    version: original.version,
    manifestSha256: planned.manifestSha256,
    manifestPath: 'manifests/win32-arm64.json',
    repoPath: planned.repoPath,
  };
  return { original, identity, planned, assets, row };
}
test('staged delivery preserves complete vendor/Node/codec/license contract and supports empty payload', () => {
  const f = fixture();
  const union = verifyStagedManifest(f.original, f.planned.manifest, f.row, f.assets, f.identity);
  assert.equal(new Set(union).size, f.assets.size);
  for (const asset of f.planned.assets) verifyStagedAsset(asset, asset.bytes);
  const empty = f.assets.get(sha(Buffer.alloc(0)) + '.gz');
  assert.equal(verifyStagedAsset(empty, empty.bytes).length, 0);
});
test('staged contract changes cannot hide behind rehashed manifest or canonical filename', () => {
  for (const change of [
    'vendor',
    'node',
    'codec',
    'license',
    'url',
    'encoding',
    'downloadhash',
    'id',
    'path',
    'version',
  ]) {
    const f = fixture(),
      staged = structuredClone(f.planned.manifest),
      row = structuredClone(f.row);
    if (change === 'vendor') staged.version.qua = 'changed';
    if (change === 'node') staged.nodeVersion = 'v24.19.0';
    if (change === 'codec') delete staged.videoCodec;
    if (change === 'license')
      staged.files = staged.files.filter((file: any) => file.path !== 'NODE-LICENSE.txt');
    if (change === 'url') staged.files[0].url = 'https://vendor.invalid/changed';
    if (change === 'encoding') staged.files[0].encoding = undefined;
    if (change === 'downloadhash') staged.files[0].downloadSha256 = '0'.repeat(64);
    if (change === 'id') staged.id = 'other';
    if (change === 'path') row.repoPath = '../manifest.json';
    if (change === 'version') row.version.appId = 'other';
    assert.throws(
      () => verifyStagedManifest(f.original, staged, row, f.assets, f.identity),
      change,
    );
  }
});
test('compressed SHA, raw SHA, declared raw size and unsafe names are independently verified', () => {
  const f = fixture(),
    asset = f.planned.assets[0];
  for (const change of [
    { sha256: '0'.repeat(64) },
    { rawSize: asset.rawSize + 1 },
    { size: asset.size + 1 },
    { name: '../unsafe.gz' },
  ])
    assert.throws(() => verifyStagedAsset({ ...asset, ...change }, asset.bytes));
  const modified = gzipSync(Buffer.from('modified'));
  assert.throws(
    () => verifyStagedAsset({ ...asset, size: modified.length, sha256: sha(modified) }, modified),
    /raw SHA/,
  );
  const truncated = asset.bytes.subarray(0, asset.bytes.length - 1);
  assert.throws(() =>
    verifyStagedAsset({ ...asset, size: truncated.length, sha256: sha(truncated) }, truncated),
  );
});
test('missing asset or inconsistent source raw size cannot preserve a native manifest', () => {
  const f = fixture();
  f.assets.delete(f.planned.assets[0].name);
  assert.throws(
    () => verifyStagedManifest(f.original, f.planned.manifest, f.row, f.assets, f.identity),
    /Missing/,
  );
  const g = fixture(),
    first = g.assets.get(g.planned.assets[0].name);
  first.rawSize++;
  assert.throws(
    () => verifyStagedManifest(g.original, g.planned.manifest, g.row, g.assets, g.identity),
    /payload/,
  );
});
