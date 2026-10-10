import { isAbsolute } from 'node:path';
import type { NativeManifest, QQVersion } from '../contracts/native.ts';

export const nativeHashPattern = /^[a-f0-9]{64}$/i;

/** Validate version metadata without imposing the catalog's numeric ordering format. */
export function assertNativeVersion(value: unknown): asserts value is QQVersion {
  const v = value as QQVersion | undefined;
  if (!v || ![v.clientVersion, v.appId, v.qua].every((x) => typeof x === 'string' && x.length > 0))
    throw new Error('A native package requires clientVersion, appId and qua');
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

/** Validate remote inventory metadata before any payload acquisition or cache mutation.
 * Installed object storage and legacy local wrappers retain their own source policies.
 */
export function validateRemoteInventory(manifest: NativeManifest): string | undefined {
  safeRelative(manifest.wrapper);
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof file.url !== 'string' ||
      typeof file.sha256 !== 'string'
    )
      throw new Error('Invalid native manifest file');
    safeRelative(file.path);
    if (names.has(file.path) || !nativeHashPattern.test(file.sha256))
      throw new Error('Duplicate file or invalid SHA-256 in manifest');
    if (file.encoding !== undefined && file.encoding !== 'gzip')
      throw new Error('Unsupported native content encoding');
    if (
      file.encoding === 'gzip' &&
      (typeof file.downloadSha256 !== 'string' || !nativeHashPattern.test(file.downloadSha256))
    )
      throw new Error('Compressed native content requires downloadSha256');
    if (file.encoding === undefined && file.downloadSha256 !== undefined)
      throw new Error('downloadSha256 requires content encoding');
    names.add(file.path);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join('/')))
        throw new Error('Conflicting native package file paths');
    }
  }
  if (!names.has(manifest.wrapper)) throw new Error('Wrapper is missing from manifest files');
  return declaredVideoCodec(manifest, names);
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
