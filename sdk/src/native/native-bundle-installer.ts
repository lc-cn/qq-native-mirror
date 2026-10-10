import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { constants as fsConstants } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  realpath,
  lstat,
  link,
  copyFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { NativeManifest } from '../contracts/native.ts';
import { acquirePackageLock } from '../storage/native-package-lock.ts';

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const installations = new Map<string, Promise<void>>();

/** Trusted inputs have passed the resolver's manifest/version/path checks.
 * Owns content cache, per-bundle queue, cross-process lock and atomic installation.
 * The download port preserves the coordinator's reviewed network policy.
 */
export interface VerifiedBundleInstallation {
  manifestBytes: Buffer;
  manifest: NativeManifest;
  manifestUrl: string;
  cacheDir?: string;
  mirrors: readonly string[];
  download(url: string, maxBytes: number): Promise<Buffer>;
}
export async function installVerifiedBundle({
  manifestBytes: body,
  manifest,
  manifestUrl,
  cacheDir,
  mirrors,
  download,
}: VerifiedBundleInstallation): Promise<string> {
  const requestedBase = resolve(cacheDir ?? join(homedir(), '.cache/qq-native-client'));
  await mkdir(requestedBase, { recursive: true });
  const base = await realpath(requestedBase);
  const target = join(base, digest(body));
  async function validate(): Promise<boolean> {
    try {
      for (const file of manifest.files) {
        const path = join(target, file.path);
        if (
          !(await realpath(path)).startsWith(target + sep) ||
          !(await lstat(path)).isFile() ||
          digest(await readFile(path)) !== file.sha256.toLowerCase()
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  const previous = installations.get(target) ?? Promise.resolve();
  const installation = previous
    .catch(() => {})
    .then(async () => {
      if (await validate()) return;
      const release = await acquirePackageLock(target);
      try {
        if (!(await validate())) {
          await mkdir(base, { recursive: true });
          const temporary = join(base, `.download-${randomUUID()}`);
          try {
            let next = 0;
            let failed = false;
            const contentGroups = new Map<string, NativeManifest['files']>();
            for (const file of manifest.files) {
              const key = file.sha256.toLowerCase();
              const group = contentGroups.get(key) ?? [];
              group.push(file);
              contentGroups.set(key, group);
            }
            const groups = [...contentGroups.values()];
            const contentCache = join(base, '.contents');
            await mkdir(contentCache, { recursive: true });
            if (
              !(await lstat(contentCache)).isDirectory() ||
              (await realpath(contentCache)) !== contentCache
            )
              throw new Error('Native content cache must stay inside cache root');
            // Bound memory/network use while avoiding one round trip per small
            // framework resource. Await every worker before cleaning staging.
            const results = await Promise.allSettled(
              Array.from({ length: Math.min(4, groups.length) }, async () => {
                while (!failed && next < groups.length) {
                  const group = groups[next++]!;
                  const file = group[0]!;
                  try {
                    const contentPath = join(contentCache, file.sha256.toLowerCase());
                    let data: Buffer | undefined = await readFile(contentPath).catch(
                      () => undefined,
                    );
                    const cached = !!data && digest(data) === file.sha256.toLowerCase();
                    if (!cached) {
                      const original = new URL(file.url, manifestUrl).href;
                      let lastError: unknown;
                      for (const url of [...mirrors.map((prefix) => prefix + original), original]) {
                        try {
                          let candidate = await download(url, 512 * 1024 * 1024);
                          if (file.encoding === 'gzip') {
                            if (digest(candidate) !== file.downloadSha256!.toLowerCase())
                              throw new Error(`Compressed native SHA-256 mismatch: ${file.path}`);
                            candidate = gunzipSync(candidate, {
                              maxOutputLength: 512 * 1024 * 1024,
                            });
                          }
                          if (digest(candidate) !== file.sha256.toLowerCase())
                            throw new Error(`Native file SHA-256 mismatch: ${file.path}`);
                          data = candidate;
                          break;
                        } catch (error) {
                          lastError = error;
                        }
                      }
                      if (!data || digest(data) !== file.sha256.toLowerCase()) throw lastError;
                    }
                    if (!data || digest(data) !== file.sha256.toLowerCase())
                      throw new Error(`Native file SHA-256 mismatch: ${file.path}`);
                    if (!cached) {
                      const contentTemporary = join(contentCache, `.content-${randomUUID()}`);
                      try {
                        await writeFile(contentTemporary, data, { mode: 0o600 });
                        await rename(contentTemporary, contentPath);
                      } finally {
                        await rm(contentTemporary, { force: true });
                      }
                    }
                    const destination = join(temporary, file.path);
                    await mkdir(dirname(destination), { recursive: true });
                    // Reflinks preserve independent mutable files; unsupported
                    // filesystems fall back to ordinary copies, never cache hardlinks.
                    await copyFile(contentPath, destination, fsConstants.COPYFILE_FICLONE);
                    if (digest(await readFile(destination)) !== file.sha256.toLowerCase())
                      throw new Error(`Copied native SHA-256 mismatch: ${file.path}`);
                    for (const duplicate of group.slice(1)) {
                      const duplicatePath = join(temporary, duplicate.path);
                      await mkdir(dirname(duplicatePath), { recursive: true });
                      await link(destination, duplicatePath);
                    }
                  } catch (error) {
                    failed = true;
                    throw error;
                  }
                }
              }),
            );
            const failure = results.find((result) => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
            // Another client may have completed the same immutable package meanwhile.
            if (await validate()) await rm(temporary, { recursive: true });
            else {
              await rm(target, { recursive: true, force: true });
              await rename(temporary, target);
            }
          } finally {
            await rm(temporary, { recursive: true, force: true });
          }
        }
      } finally {
        await release();
      }
    });
  installations.set(target, installation);
  try {
    await installation;
  } finally {
    if (installations.get(target) === installation) installations.delete(target);
  }
  return target;
}
