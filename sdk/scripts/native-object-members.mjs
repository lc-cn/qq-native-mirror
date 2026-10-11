import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const MAX_MEMBERS = 4096;
const MAX_FILE_BYTES = 512 * 1024 ** 2;
const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
const metadataPaths = ['package.json', 'manifest.json', 'README.md'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function safePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\\\0:\r\n]/.test(value) &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function boundedSize(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_FILE_BYTES;
}

/** Inspect every packed object; retain only the requested original members.
 * This archive check performs no IO or cache hydration. Runtime filesystem and
 * lock policy remain with installed storage; release provenance remains with
 * the release validator. Each returned buffer is independent of caller bytes.
 */
export function inspectNativeObjectMembers(files, manifest, requestedPaths) {
  requireThat(
    files instanceof Map &&
      manifest?.schemaVersion === 1 &&
      manifest.npmStorage?.format === 'gzip-objects-v1' &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= MAX_MEMBERS &&
      Array.isArray(manifest.npmStorage.objects) &&
      manifest.npmStorage.objects.length > 0 &&
      manifest.npmStorage.objects.length <= MAX_MEMBERS &&
      Array.isArray(requestedPaths),
    'Invalid packed native object inventory',
  );
  requireThat(
    metadataPaths.every((path) => Buffer.isBuffer(files.get('package/' + path))) &&
      files.get('package/package.json').length <= 32 * 1024 ** 2 &&
      files.get('package/manifest.json').length <= 32 * 1024 ** 2 &&
      JSON.stringify(JSON.parse(files.get('package/manifest.json'))) === JSON.stringify(manifest),
    'Packed native metadata differs from archive',
  );
  const objects = new Map();
  let rawTotal = 0;
  let compressedTotal = 0;
  for (const object of manifest.npmStorage.objects) {
    requireThat(
      object &&
        digest(object.sha256) &&
        digest(object.downloadSha256) &&
        object.path === `objects/${object.sha256}.gz` &&
        boundedSize(object.size) &&
        boundedSize(object.downloadSize) &&
        !objects.has(object.sha256),
      'Invalid packed native object metadata',
    );
    rawTotal += object.size;
    compressedTotal += object.downloadSize;
    requireThat(
      rawTotal <= MAX_TOTAL_BYTES && compressedTotal <= MAX_TOTAL_BYTES,
      'Packed native object bytes exceed bound',
    );
    objects.set(object.sha256, object);
  }

  const originalPaths = new Set();
  const usedObjects = new Set();
  const selectedByObject = new Map();
  const requested = new Set(requestedPaths);
  requireThat(
    requested.size === requestedPaths.length && requestedPaths.every(safePath),
    'Invalid requested native members',
  );
  let originalTotal = 0;
  for (const file of manifest.files) {
    requireThat(
      file &&
        safePath(file.path) &&
        !metadataPaths.includes(file.path) &&
        !originalPaths.has(file.path) &&
        digest(file.sha256) &&
        boundedSize(file.size) &&
        file.url === file.path &&
        file.encoding === undefined &&
        file.downloadSha256 === undefined &&
        objects.get(file.sha256)?.size === file.size,
      'Invalid packed native original file',
    );
    originalPaths.add(file.path);
    usedObjects.add(file.sha256);
    originalTotal += file.size;
    requireThat(originalTotal <= MAX_TOTAL_BYTES, 'Packed native original bytes exceed bound');
    if (requested.has(file.path)) {
      const selected = selectedByObject.get(file.sha256) ?? [];
      selected.push(file.path);
      selectedByObject.set(file.sha256, selected);
    }
  }
  for (const path of originalPaths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++)
      requireThat(
        !originalPaths.has(parts.slice(0, index).join('/')),
        'Packed native path collision',
      );
  }
  requireThat(
    [manifest.wrapper, manifest.videoCodec, 'video/SOURCE-PROVENANCE.json'].every(
      (path) => safePath(path) && originalPaths.has(path),
    ) &&
      requestedPaths.every((path) => originalPaths.has(path)) &&
      usedObjects.size === objects.size,
    'Packed native object references are not complete',
  );

  const members = new Set([
    ...metadataPaths.map((path) => 'package/' + path),
    ...[...objects.values()].map((object) => 'package/' + object.path),
  ]);
  requireThat(
    files.size === members.size && [...files.keys()].every((path) => members.has(path)),
    'Packed native object archive is not closed',
  );
  const snapshot = new Map();
  for (const object of objects.values()) {
    const compressed = files.get('package/' + object.path);
    requireThat(
      Buffer.isBuffer(compressed) &&
        compressed.length === object.downloadSize &&
        sha(compressed) === object.downloadSha256,
      'Packed native compressed object mismatch',
    );
    const raw = gunzipSync(compressed, { maxOutputLength: Math.max(1, object.size) });
    requireThat(
      raw.length === object.size && sha(raw) === object.sha256,
      'Packed native original object mismatch',
    );
    for (const path of selectedByObject.get(object.sha256) ?? [])
      snapshot.set('package/' + path, Buffer.from(raw));
  }
  return snapshot;
}
