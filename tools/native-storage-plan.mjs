import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const MAX_FILES = 4096;
const MAX_FILE_BYTES = 512 * 1024 ** 2;
const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
const METADATA_PATHS = ['manifest.json', 'package.json', 'README.md'];
const README =
  '# Experimental deduplicated full native inventory\n\nAll original runtime paths, CodeResources and bytes are retained in SHA-bound gzip objects. Requires an SDK supporting gzip-objects-v1 cache hydration. QQ vendor licensing is unchanged; decoded video license/notices/provenance and permanent source/relink references remain in the full restored inventory. No account, business, signing-authenticity or production acceptance is established.\n';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isDigest = (value) => /^[a-f0-9]{64}$/.test(value);
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function isSafePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !/[\\\0:\r\n]/.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function captureSource(source) {
  requireCondition(source.files instanceof Map, 'Missing complete source map');
  // The archive is the source of truth. Parsing its bytes also detaches every nested
  // metadata value from caller-owned objects before staging can yield to filesystem IO.
  const manifest = JSON.parse(source.files.get('manifest.json'));
  const metadata = JSON.parse(source.files.get('package.json'));
  requireCondition(
    JSON.stringify(manifest) === JSON.stringify(source.manifest) &&
      JSON.stringify(metadata) === JSON.stringify(source.metadata),
    'Tar metadata differs from source map',
  );
  return { manifest, metadata, files: source.files };
}

function validateIdentity(manifest, metadata) {
  requireCondition(
    manifest?.schemaVersion === 1 &&
      ['darwin', 'linux', 'win32'].includes(manifest.platform) &&
      ['arm64', 'x64'].includes(manifest.arch) &&
      manifest.npmStorage === undefined,
    'Unsupported source manifest',
  );
  requireCondition(
    metadata?.name === `qq-native-client-${manifest.platform}-${manifest.arch}` &&
      metadata.version === '0.0.2' &&
      JSON.stringify(metadata.os) === JSON.stringify([manifest.platform]) &&
      JSON.stringify(metadata.cpu) === JSON.stringify([manifest.arch]),
    'Source npm identity mismatch',
  );
  requireCondition(
    !metadata.scripts || Object.keys(metadata.scripts).length === 0,
    'Source scripts are not permitted',
  );
  requireCondition(
    manifest.version &&
      ['clientVersion', 'appId', 'qua'].every(
        (key) => typeof manifest.version[key] === 'string' && manifest.version[key],
      ),
    'Missing vendor version',
  );
}

function validateInventory(manifest, files) {
  requireCondition(
    Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= MAX_FILES,
    'Missing complete source map',
  );
  const names = new Set();
  for (const file of manifest.files) {
    requireCondition(
      file &&
        isSafePath(file.path) &&
        !METADATA_PATHS.includes(file.path) &&
        !names.has(file.path) &&
        isDigest(file.sha256),
      'Invalid inventory path/digest',
    );
    names.add(file.path);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) {
      requireCondition(!names.has(parts.slice(0, index).join('/')), 'Native file path collision');
    }
  }
  const expected = new Set([...names, ...METADATA_PATHS]);
  requireCondition(
    files.size === expected.size && [...files.keys()].every((path) => expected.has(path)),
    'Tar member inventory is not closed',
  );
  requireCondition(
    isSafePath(manifest.wrapper) &&
      names.has(manifest.wrapper) &&
      isSafePath(manifest.videoCodec) &&
      names.has(manifest.videoCodec) &&
      names.has('video/SOURCE-PROVENANCE.json'),
    'Required wrapper/video provenance missing',
  );
  if (manifest.platform === 'win32') {
    requireCondition(
      manifest.nodeVersion === 'v24.20.0' &&
        isDigest(manifest.nodeConfigSha256 ?? '') &&
        names.has('QQNT.dll') &&
        names.has('NODE-LICENSE.txt'),
      'Missing Windows ABI constraints/license',
    );
  }
  return names;
}

function compressInventory(manifest, files) {
  const objects = new Map();
  const inventory = [];
  let originalBytes = 0;
  for (const file of manifest.files) {
    requireCondition(
      file.encoding === undefined && file.downloadSha256 === undefined,
      'Source compressed delivery semantics are unsupported',
    );
    const bytes = files.get(file.path);
    requireCondition(
      Buffer.isBuffer(bytes) &&
        bytes.length <= MAX_FILE_BYTES &&
        sha256(bytes) === file.sha256 &&
        (file.size === undefined || file.size === bytes.length),
      'Source byte hash/size mismatch',
    );
    originalBytes += bytes.length;
    requireCondition(originalBytes <= MAX_TOTAL_BYTES, 'Source total runtime bytes exceed bound');
    inventory.push({ ...file, size: bytes.length, url: file.path });
    const existing = objects.get(file.sha256);
    if (existing) {
      // A repeated digest must represent the same bytes, not just another declared hash.
      requireCondition(
        bytes.equals(gunzipSync(existing.bytes, { maxOutputLength: MAX_FILE_BYTES })),
        'Raw SHA object collision',
      );
      continue;
    }
    const compressed = gzipSync(bytes, { level: 6, mtime: 0 });
    requireCondition(compressed.length <= MAX_FILE_BYTES, 'Compressed object exceeds bound');
    objects.set(file.sha256, {
      path: `objects/${file.sha256}.gz`,
      sha256: file.sha256,
      downloadSha256: sha256(compressed),
      size: bytes.length,
      downloadSize: compressed.length,
      bytes: compressed,
    });
  }
  requireCondition(objects.size <= MAX_FILES, 'Object count exceeds bound');
  const sorted = [...objects.values()].sort((left, right) =>
    left.sha256.localeCompare(right.sha256),
  );
  return { inventory, objects: sorted, originalBytes };
}

/**
 * Validate a closed archive inventory and produce all final package bytes synchronously.
 * Owns validation, compression and serialization; performs no filesystem or process IO.
 * The returned members contain only newly created buffers and can be staged without
 * retaining the caller's metadata, manifest or raw native-file buffers.
 */
export function planNativeStorage(source) {
  const { manifest, metadata, files } = captureSource(source);
  validateIdentity(manifest, metadata);
  const names = validateInventory(manifest, files);
  const { inventory, objects, originalBytes } = compressInventory(manifest, files);
  const output = {
    ...manifest,
    files: inventory,
    npmStorage: {
      format: 'gzip-objects-v1',
      objects: objects.map(({ bytes: _bytes, ...object }) => object),
    },
  };
  const pkg = {
    ...metadata,
    description:
      'Experimental full-inventory gzip-object storage; cache hydration requires compatible SDK',
    files: [...objects.map((object) => object.path), 'manifest.json', 'README.md'],
  };
  delete pkg.scripts;
  const manifestBytes = jsonBytes(output);
  return {
    manifest: output,
    members: [
      ...objects.map(({ path, bytes }) => ({ path, bytes })),
      { path: 'manifest.json', bytes: manifestBytes },
      { path: 'package.json', bytes: jsonBytes(pkg) },
      { path: 'README.md', bytes: Buffer.from(README) },
    ],
    metrics: {
      nativeManifestSha256: sha256(manifestBytes),
      originalPaths: names.size,
      uniqueObjects: objects.length,
      originalBytes,
      uniqueRawBytes: objects.reduce((total, object) => total + object.size, 0),
      gzipObjectBytes: objects.reduce((total, object) => total + object.downloadSize, 0),
    },
  };
}
