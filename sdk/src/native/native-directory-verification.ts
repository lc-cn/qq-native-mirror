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
): Promise<string | undefined> {
  const label = source === 'local' ? 'Local' : 'Installed';
  const names = new Set<string>();
  for (const file of manifest.files) {
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
    if (
      !(await realpath(path)).startsWith(base + sep) ||
      !(await lstat(path)).isFile() ||
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== file.sha256.toLowerCase()
    )
      throw new Error(`${label} native file failed verification: ${relative}`);
  }
  if (!names.has(safeRelative(manifest.wrapper)))
    throw new Error(`${label} native wrapper is missing`);
  const codec = declaredVideoCodec(manifest, names);
  return codec === undefined ? undefined : join(base, codec);
}
