import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { inspectNativeFallbackPair } from '../scripts/native-fallbacks.mjs';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const raw = new Map([
    ['wrapper.node', Buffer.from('wrapper')],
    ['video/video-codec.node', Buffer.from('codec')],
    ['video/SOURCE-PROVENANCE.json', Buffer.from('provenance')],
    ['_CodeSignature/CodeResources', Buffer.from('sealed')],
    ['NODE-LICENSE.txt', Buffer.from('license')],
  ]);
  const original = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'arm64',
    wrapper: 'wrapper.node',
    videoCodec: 'video/video-codec.node',
    nodeVersion: 'v24.20.0',
    nodeConfigSha256: 'a'.repeat(64),
    files: [...raw].map(([path, bytes]) => ({
      path,
      url: path,
      size: bytes.length,
      sha256: sha(bytes),
    })),
  };
  const objects = [...raw.values()].map((bytes) => {
    const compressed = gzipSync(bytes);
    return {
      path: `objects/${sha(bytes)}.gz`,
      sha256: sha(bytes),
      size: bytes.length,
      downloadSha256: sha(compressed),
      downloadSize: compressed.length,
    };
  });
  const metadata = {
    name: 'qq-native-client-win32-arm64',
    version: '0.0.3',
    os: ['win32'],
    cpu: ['arm64'],
    license: 'UNLICENSED',
  };
  const full = new Map<string, Buffer>([
    ['package/package.json', Buffer.from(JSON.stringify(metadata))],
    ['package/manifest.json', Buffer.from(JSON.stringify(original))],
    ['package/README.md', Buffer.from('original')],
    ...[...raw].map(([path, bytes]): [string, Buffer] => [`package/${path}`, bytes]),
  ]);
  const selected = new Map<string, Buffer>([
    [
      'package/package.json',
      Buffer.from(JSON.stringify({ ...metadata, description: 'delivery', files: ['objects'] })),
    ],
    [
      'package/manifest.json',
      Buffer.from(
        JSON.stringify({ ...original, npmStorage: { format: 'gzip-objects-v1', objects } }),
      ),
    ],
    ['package/README.md', Buffer.from('delivery')],
    ...objects.map((o, i): [string, Buffer] => [
      `package/${o.path}`,
      gzipSync([...raw.values()][i]!),
    ]),
  ]);
  return { full, selected };
}
test('fallback pair preserves every original runtime, seal, license and ABI byte', () => {
  const f = fixture();
  assert.deepEqual(inspectNativeFallbackPair(f.selected, f.full), {
    originalPaths: 5,
    allOriginalBytesEqual: true,
  });
});
test('fallback pair rejects missing, extra and corrupted original resources', () => {
  for (const mode of ['missing', 'extra', 'seal', 'license', 'wrapper']) {
    const f = fixture();
    if (mode === 'missing') f.full.delete('package/wrapper.node');
    else if (mode === 'extra') f.full.set('package/extra', Buffer.from('extra'));
    else
      f.full.set(
        `package/${mode === 'seal' ? '_CodeSignature/CodeResources' : mode === 'license' ? 'NODE-LICENSE.txt' : 'wrapper.node'}`,
        Buffer.from('changed'),
      );
    assert.throws(() => inspectNativeFallbackPair(f.selected, f.full));
  }
});
test('fallback pair rejects runtime ABI and npm identity drift', () => {
  for (const mode of ['abi', 'name', 'version']) {
    const f = fixture(),
      path = mode === 'abi' ? 'package/manifest.json' : 'package/package.json';
    const value = JSON.parse(f.full.get(path)!.toString());
    if (mode === 'abi') value.nodeConfigSha256 = 'b'.repeat(64);
    else value[mode] = 'changed';
    f.full.set(path, Buffer.from(JSON.stringify(value)));
    assert.throws(() => inspectNativeFallbackPair(f.selected, f.full));
  }
});
