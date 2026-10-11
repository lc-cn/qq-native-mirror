import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { inspectNativeObjectMembers } from '../scripts/native-object-members.mjs';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(codec = Buffer.from('codec')) {
  const payloads = [Buffer.from('wrapper'), codec, Buffer.from('provenance')];
  const paths = [
    'wrapper.node',
    'video/video-codec.node',
    'video/SOURCE-PROVENANCE.json',
    'alias.node',
  ];
  const files = paths.map((path, index) => {
    const bytes = payloads[index === 3 ? 0 : index]!;
    return { path, url: path, sha256: sha(bytes), size: bytes.length };
  });
  const objects = payloads.map((bytes) => {
    const compressed = gzipSync(bytes);
    return {
      path: `objects/${sha(bytes)}.gz`,
      sha256: sha(bytes),
      size: bytes.length,
      downloadSha256: sha(compressed),
      downloadSize: compressed.length,
    };
  });
  const manifest = {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    wrapper: 'wrapper.node',
    videoCodec: 'video/video-codec.node',
    version: { clientVersion: 'fixed', appId: '1', qua: 'fixed' },
    files,
    npmStorage: { format: 'gzip-objects-v1', objects },
  };
  const members = new Map<string, Buffer>([
    ['package/package.json', Buffer.from('{}')],
    ['package/manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['package/README.md', Buffer.from('fixture')],
  ]);
  objects.forEach((object, index) =>
    members.set(`package/${object.path}`, gzipSync(payloads[index]!)),
  );
  return { manifest, members };
}
test('object member inspector returns only requested original paths and owns their bytes', () => {
  const f = fixture(),
    requested = ['video/video-codec.node', 'video/SOURCE-PROVENANCE.json'];
  const result = inspectNativeObjectMembers(f.members, f.manifest, requested);
  assert.deepEqual(
    [...result.keys()],
    requested.map((path) => `package/${path}`),
  );
  const codec = result.get('package/video/video-codec.node');
  assert.ok(codec);
  assert.deepEqual(codec, Buffer.from('codec'));
  for (const bytes of f.members.values()) bytes.fill(0);
  assert.deepEqual(codec, Buffer.from('codec'));
  const empty = fixture(Buffer.alloc(0));
  assert.equal(
    inspectNativeObjectMembers(empty.members, empty.manifest, ['video/video-codec.node']).get(
      'package/video/video-codec.node',
    )?.length,
    0,
  );
});
test('object inspector rejects compressed and raw digest or size corruption', () => {
  for (const mode of [
    'compressed-digest',
    'raw-digest',
    'raw-size',
    'compressed-size',
    'bytes',
  ] as const) {
    const f = fixture(),
      object = f.manifest.npmStorage.objects[0]!;
    if (mode === 'compressed-digest') object.downloadSha256 = 'a'.repeat(64);
    if (mode === 'raw-digest') object.sha256 = 'a'.repeat(64);
    if (mode === 'raw-size') object.size++;
    if (mode === 'compressed-size') object.downloadSize++;
    if (mode === 'bytes') f.members.set(`package/${object.path}`, Buffer.from('not gzip'));
    f.members.set('package/manifest.json', Buffer.from(JSON.stringify(f.manifest)));
    assert.throws(() => inspectNativeObjectMembers(f.members, f.manifest, ['wrapper.node']));
  }
});
test('object inspector requires exact archive and referenced unique object closure', () => {
  for (const mode of ['extra', 'missing', 'duplicate', 'unused'] as const) {
    const f = fixture();
    if (mode === 'extra') f.members.set('package/extra', Buffer.from('extra'));
    if (mode === 'missing') f.members.delete(`package/${f.manifest.npmStorage.objects[0]!.path}`);
    if (mode === 'duplicate')
      f.manifest.npmStorage.objects.push({ ...f.manifest.npmStorage.objects[0]! });
    if (mode === 'unused') {
      const raw = Buffer.from('unused'),
        gz = gzipSync(raw);
      const object = {
        path: `objects/${sha(raw)}.gz`,
        sha256: sha(raw),
        size: raw.length,
        downloadSha256: sha(gz),
        downloadSize: gz.length,
      };
      f.manifest.npmStorage.objects.push(object);
      f.members.set(`package/${object.path}`, gz);
    }
    f.members.set('package/manifest.json', Buffer.from(JSON.stringify(f.manifest)));
    assert.throws(() => inspectNativeObjectMembers(f.members, f.manifest, ['wrapper.node']));
  }
});
test('object inspector rejects unsafe original paths, delivery fields and missing required inventory', () => {
  for (const mode of [
    'duplicate',
    'traversal',
    'ancestor',
    'encoding',
    'download',
    'format',
    'wrapper',
    'provenance',
  ] as const) {
    const f = fixture(),
      first = f.manifest.files[0]!;
    if (mode === 'duplicate') f.manifest.files[3]!.path = first.path;
    if (mode === 'traversal') first.path = '../wrapper.node';
    if (mode === 'ancestor') f.manifest.files[3]!.path = 'wrapper.node/child';
    if (mode === 'encoding') Object.assign(first, { encoding: 'gzip' });
    if (mode === 'download') Object.assign(first, { downloadSha256: 'a'.repeat(64) });
    if (mode === 'format') f.manifest.npmStorage.format = 'other';
    if (mode === 'wrapper') f.manifest.wrapper = 'missing.node';
    if (mode === 'provenance') f.manifest.files.splice(2, 1);
    f.members.set('package/manifest.json', Buffer.from(JSON.stringify(f.manifest)));
    assert.throws(() => inspectNativeObjectMembers(f.members, f.manifest, ['wrapper.node']));
  }
  const f = fixture();
  assert.throws(() => inspectNativeObjectMembers(f.members, f.manifest, ['absent.node']));
});
