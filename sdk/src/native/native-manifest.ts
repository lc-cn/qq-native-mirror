import { isAbsolute } from 'node:path';
import type { NativeManifest, QQVersion } from '../contracts/native.ts';

export const nativeHashPattern = /^[a-f0-9]{64}$/i;

/** Validate version metadata without imposing the catalog's numeric ordering format. */
export function assertNativeVersion(value: unknown): asserts value is QQVersion {
  const v = value as QQVersion | undefined;
  if (!v || ![v.clientVersion, v.appId, v.qua].every((x) => typeof x === 'string' && x.length > 0))
    throw new Error('A native package requires clientVersion, appId and qua');
}

/** Both fields are required when a bundle restricts the Node internal ABI. */
export function assertNodeRuntimeConstraint(manifest: NativeManifest): void {
  if (manifest.nodeVersion === undefined && manifest.nodeConfigSha256 === undefined) return;
  if (
    typeof manifest.nodeVersion !== 'string' ||
    !/^v\d+\.\d+\.\d+$/.test(manifest.nodeVersion) ||
    typeof manifest.nodeConfigSha256 !== 'string' ||
    !nativeHashPattern.test(manifest.nodeConfigSha256)
  )
    throw new Error('Invalid native Node runtime constraint');
}

/** Manifest-relative paths are portable; they cannot select a different directory. */
export function safeRelative(path: string): string {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    /^[a-zA-Z]:/.test(path) ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((x) => x === '..' || x === '.' || !x)
  )
    throw new Error(`Unsafe native package path: ${path}`);
  return path;
}

/** A codec entry is optional, but discovery requires membership in the verified inventory. */
export function declaredVideoCodec(
  manifest: NativeManifest,
  names: ReadonlySet<string>,
): string | undefined {
  if (manifest.videoCodec === undefined) return;
  const path = safeRelative(manifest.videoCodec);
  if (!names.has(path)) throw new Error('Video codec is missing from native manifest files');
  return path;
}

/** Original file identity is independent of its remote or npm storage representation. */
function contentInventory(manifest: NativeManifest): Map<string, NativeManifest['files'][number]> {
  safeRelative(manifest.wrapper);
  const files = new Map<string, NativeManifest['files'][number]>();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || typeof file.sha256 !== 'string')
      throw new Error('Invalid native manifest file');
    safeRelative(file.path);
    if (files.has(file.path) || !nativeHashPattern.test(file.sha256))
      throw new Error('Duplicate file or invalid SHA-256 in manifest');
    files.set(file.path, file);
  }
  for (const name of files.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (files.has(parts.slice(0, i).join('/')))
        throw new Error('Conflicting native package file paths');
    }
  }
  if (!files.has(manifest.wrapper)) throw new Error('Wrapper is missing from manifest files');
  declaredVideoCodec(manifest, new Set(files.keys()));
  return files;
}

/** Reuse requires the whole selected bundle, not just a matching version or wrapper.
 * Transport URLs, compression and npm object storage do not change original bytes.
 * Validate both inventories first so malformed metadata never becomes a cache miss.
 */
export function sameNativeContent(left: NativeManifest, right: NativeManifest): boolean {
  const installed = contentInventory(left);
  const selected = contentInventory(right);
  assertNativeVersion(left.version);
  assertNativeVersion(right.version);
  assertNodeRuntimeConstraint(left);
  assertNodeRuntimeConstraint(right);
  if (
    left.schemaVersion !== right.schemaVersion ||
    left.platform !== right.platform ||
    left.arch !== right.arch ||
    left.wrapper !== right.wrapper ||
    left.videoCodec !== right.videoCodec ||
    left.nodeVersion !== right.nodeVersion ||
    left.nodeConfigSha256?.toLowerCase() !== right.nodeConfigSha256?.toLowerCase() ||
    (['clientVersion', 'appId', 'qua'] as const).some(
      (key) => left.version[key] !== right.version[key],
    ) ||
    installed.size !== selected.size
  )
    return false;
  for (const [path, file] of installed) {
    const expected = selected.get(path);
    if (
      !expected ||
      file.sha256.toLowerCase() !== expected.sha256.toLowerCase() ||
      (file.size !== undefined && expected.size !== undefined && file.size !== expected.size)
    )
      return false;
  }
  return true;
}

/** Validate remote inventory metadata before any payload acquisition or cache mutation.
 * Installed object storage and legacy local wrappers retain their own source policies.
 */
export function validateRemoteInventory(manifest: NativeManifest): string | undefined {
  const files = contentInventory(manifest);
  for (const file of files.values()) {
    if (typeof file.url !== 'string') throw new Error('Invalid native manifest file');
    if (file.encoding !== undefined && file.encoding !== 'gzip')
      throw new Error('Unsupported native content encoding');
    if (
      file.encoding === 'gzip' &&
      (typeof file.downloadSha256 !== 'string' || !nativeHashPattern.test(file.downloadSha256))
    )
      throw new Error('Compressed native content requires downloadSha256');
    if (file.encoding === undefined && file.downloadSha256 !== undefined)
      throw new Error('downloadSha256 requires content encoding');
  }
  return manifest.videoCodec;
}

/** Pure option capture shared by CLI preflight and bundle preparation. */
export function validateDownloadMirrors(value: unknown): string[] {
  const mirrors = value ?? [];
  if (!Array.isArray(mirrors) || mirrors.length > 8)
    throw new Error('downloadMirrors must contain at most eight HTTPS prefixes');
  for (const mirror of mirrors) {
    if (typeof mirror !== 'string') throw new Error('Invalid download mirror');
    const url = new URL(mirror);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !mirror.endsWith('/')
    )
      throw new Error(
        'Download mirrors require HTTPS prefixes ending in / without credentials, query or fragment',
      );
  }
  return mirrors;
}
