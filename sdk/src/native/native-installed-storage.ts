import { runWithCleanup } from '../runtime/cleanup.ts';
import { runNativeInstallation } from '../storage/native-installation-queue.ts';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join, dirname, parse } from 'node:path';
import type { NativeManifest } from '../contracts/native.ts';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const limit = 512 * 1024 * 1024,
  totalLimit = 2 * 1024 * 1024 * 1024;
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function path(value: string) {
  check(
    typeof value === 'string' &&
      value &&
      !/[\\\0:\r\n]/.test(value) &&
      !value.startsWith('/') &&
      !value.split('/').some((p) => !p || p === '.' || p === '..'),
    'Unsafe installed storage path',
  );
  return value;
}
function size(value: unknown) {
  check(
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= limit,
    'Invalid installed storage size',
  );
  return Number(value);
}
export function installedStorageDirectoryParts(absolute: string, root: string): string[] {
  return absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
}
async function directory(value: string, create = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const absolute = resolve(value);
  let current = parse(absolute).root;
  for (const part of installedStorageDirectoryParts(absolute, current)) {
    signal?.throwIfAborted();
    current = join(current, part);
    if (create)
      try {
        await mkdir(current);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    signal?.throwIfAborted();
    const stat = await lstat(current);
    signal?.throwIfAborted();
    check(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'Installed storage directory must not be a symlink',
    );
  }
  return absolute;
}
async function regular(root: string, name: string, max: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const full = join(root, path(name));
  await directory(dirname(full), false, signal);
  const stat = await lstat(full);
  signal?.throwIfAborted();
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= max,
    'Invalid installed storage regular file',
  );
  const body = await readFile(full, {
    flag: constants.O_RDONLY | constants.O_NOFOLLOW,
    signal,
  }).catch((error: unknown) => {
    signal?.throwIfAborted();
    throw error;
  });
  signal?.throwIfAborted();
  check(body.length === stat.size && body.length <= max, 'Installed storage file size changed');
  return body;
}
/** Only installed packages may declare this format. No network or native execution. */
export async function restoreInstalledNativeStorage(
  packageRoot: string,
  manifestBytes: Uint8Array,
  manifest: NativeManifest,
  cacheDir: string,
  acquireLock: (target: string, signal?: AbortSignal) => Promise<() => Promise<void>>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const storage = manifest.npmStorage;
  check(
    storage?.format === 'gzip-objects-v1' &&
      Array.isArray(storage.objects) &&
      storage.objects.length > 0 &&
      storage.objects.length <= 4096,
    'Invalid installed npm storage',
  );
  check(
    Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096,
    'Invalid installed storage inventory',
  );
  const objects = new Map<string, NonNullable<NativeManifest['npmStorage']>['objects'][number]>();
  let rawTotal = 0,
    compressedTotal = 0;
  for (const object of storage.objects) {
    check(
      object &&
        typeof object.sha256 === 'string' &&
        typeof object.downloadSha256 === 'string' &&
        hash.test(object.sha256) &&
        hash.test(object.downloadSha256) &&
        object.path === `objects/${object.sha256}.gz` &&
        !objects.has(object.sha256),
      'Invalid or duplicate installed storage object',
    );
    size(object.size);
    compressedTotal += size(object.downloadSize);
    check(compressedTotal <= totalLimit, 'Installed storage total limit');
    objects.set(object.sha256, object);
  }
  const names = new Set<string>(),
    used = new Set<string>();
  for (const file of manifest.files) {
    path(file.path);
    check(
      !names.has(file.path) && typeof file.sha256 === 'string' && hash.test(file.sha256),
      'Invalid installed storage file',
    );
    names.add(file.path);
    const object = objects.get(file.sha256);
    check(object && size(file.size) === object.size, 'Installed storage object/file mismatch');
    used.add(file.sha256);
    rawTotal += size(file.size);
    check(rawTotal <= totalLimit, 'Installed storage total limit');
  }
  check(used.size === objects.size, 'Extra installed storage objects');
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++)
      check(!names.has(parts.slice(0, i).join('/')), 'Conflicting installed storage paths');
  }
  check(
    names.has(path(manifest.wrapper)) &&
      (!manifest.videoCodec || names.has(path(manifest.videoCodec))),
    'Installed storage entry missing',
  );
  const root = await directory(packageRoot, false, signal),
    base = await directory(cacheDir, true, signal),
    target = join(base, 'npm-' + sha(manifestBytes));
  async function valid() {
    try {
      await directory(target, false, signal);
      for (const file of manifest.files) {
        const body = await regular(target, file.path, size(file.size), signal);
        if (body.length !== file.size || sha(body) !== file.sha256) return false;
      }
      signal?.throwIfAborted();
      return true;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }
  return runNativeInstallation(
    target,
    async () => {
      const release = await acquireLock(target, signal);
      return runWithCleanup(async () => {
        signal?.throwIfAborted();
        // A symlink at the cache root is rejected, never recursively removed.
        try {
          const stat = await lstat(target);
          signal?.throwIfAborted();
          check(
            stat.isDirectory() && !stat.isSymbolicLink(),
            'Unsafe installed storage cache target',
          );
        } catch (e) {
          signal?.throwIfAborted();
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        for (const object of objects.values()) {
          const body = await regular(root, object.path, object.downloadSize, signal);
          check(
            body.length === object.downloadSize && sha(body) === object.downloadSha256,
            'Installed storage compressed checksum mismatch',
          );
        }
        if (await valid()) return target;
        const temporary = join(base, '.npm-' + randomUUID());
        signal?.throwIfAborted();
        await mkdir(temporary);
        return runWithCleanup(
          async () => {
            signal?.throwIfAborted();
            for (const object of objects.values()) {
              const compressed = await regular(root, object.path, object.downloadSize, signal);
              check(
                compressed.length === object.downloadSize &&
                  sha(compressed) === object.downloadSha256,
                'Installed storage compressed checksum mismatch',
              );
              const raw = gunzipSync(compressed, { maxOutputLength: Math.max(1, object.size) });
              check(
                raw.length === object.size && sha(raw) === object.sha256,
                'Installed storage raw checksum mismatch',
              );
              signal?.throwIfAborted();
              for (const file of manifest.files.filter((f) => f.sha256 === object.sha256)) {
                const output = join(temporary, file.path);
                await directory(dirname(output), true, signal);
                await writeFile(output, raw, { flag: 'wx', signal }).catch((error: unknown) => {
                  signal?.throwIfAborted();
                  throw error;
                });
                signal?.throwIfAborted();
              }
            }
            if (!(await valid())) {
              signal?.throwIfAborted();
              await rm(target, { recursive: true, force: true });
              signal?.throwIfAborted();
              await rename(temporary, target);
              signal?.throwIfAborted();
            }
            check(await valid(), 'Installed storage hydration failed');
            return target;
          },
          () => rm(temporary, { recursive: true, force: true }),
        );
      }, release);
    },
    signal,
  );
}
