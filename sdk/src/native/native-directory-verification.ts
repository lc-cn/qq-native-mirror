import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { NativeManifest } from '../contracts/native.ts';
import { declaredVideoCodec, nativeHashPattern, safeRelative } from './native-manifest.ts';

/** Verify an already resolved directory, returning only its optional codec path.
 * Source selection, version/runtime policy and cache repair belong to callers.
 * Both callers supply a canonical root; verification never downloads or writes files.
 */
export async function verifyNativeDirectory(
  base: string,
  manifest: NativeManifest,
  source: 'local' | 'installed',
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const label = source === 'local' ? 'Local' : 'Installed';
  const names = new Set<string>();
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    // Preserve the stricter legacy local codec-inventory preflight. Installed
    // object-storage validation remains with its own storage-format owner.
    if (
      source === 'local' &&
      (!file || typeof file !== 'object' || typeof file.sha256 !== 'string')
    )
      throw new Error('Invalid local native manifest');
    const relative = safeRelative(file.path);
    if (names.has(relative) || !nativeHashPattern.test(file.sha256))
      throw new Error(`Invalid ${source} native manifest`);
    names.add(relative);
    const path = join(base, relative);
    signal?.throwIfAborted();
    const canonical = await realpath(path);
    signal?.throwIfAborted();
    const stat = await lstat(path);
    signal?.throwIfAborted();
    if (!canonical.startsWith(base + sep) || !stat.isFile())
      throw new Error(`${label} native file failed verification: ${relative}`);
    const body = await readFile(path, { signal }).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw error;
    });
    signal?.throwIfAborted();
    if (createHash('sha256').update(body).digest('hex') !== file.sha256.toLowerCase())
      throw new Error(`${label} native file failed verification: ${relative}`);
  }
  if (!names.has(safeRelative(manifest.wrapper)))
    throw new Error(`${label} native wrapper is missing`);
  const codec = declaredVideoCodec(manifest, names);
  signal?.throwIfAborted();
  return codec === undefined ? undefined : join(base, codec);
}
