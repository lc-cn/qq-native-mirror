import { constants } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  copyFile,
  rm,
} from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { npm } from './npm.mjs';
import { planNativeStorage } from '../tools/native-storage-plan.mjs';
import { readNativeTarFiles } from '../sdk/scripts/native-tar-files.mjs';
import { inspectNativeObjectMembers } from '../sdk/scripts/native-object-members.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function sourceInventory(directory) {
  const files = new Map();
  let total = 0;
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      requireThat(!/[\\\0:\r\n]/.test(path), 'Unsafe source path');
      const stat = await lstat(join(directory, path));
      requireThat(!stat.isSymbolicLink(), 'Native source links are not permitted');
      if (stat.isDirectory()) await visit(path);
      else {
        requireThat(stat.isFile() && stat.size <= 512 * 1024 ** 2, 'Invalid native source file');
        const bytes = await readFile(join(directory, path));
        total += bytes.length;
        requireThat(
          files.size < 4099 && bytes.length <= 512 * 1024 ** 2 && total <= 2 * 1024 ** 3,
          'Native source resource bound exceeded',
        );
        files.set(path, bytes);
      }
    }
  }
  requireThat((await lstat(directory)).isDirectory(), 'Native source must be a directory');
  await visit();
  return {
    files,
    manifest: JSON.parse(files.get('manifest.json')),
    metadata: JSON.parse(files.get('package.json')),
  };
}

async function pack(directory, destination, cache, filename) {
  await mkdir(destination);
  const rows = JSON.parse(
    execFileSync(
      npm[0],
      [
        ...npm[1],
        'pack',
        '--ignore-scripts',
        '--offline',
        '--cache',
        cache,
        '--pack-destination',
        destination,
        '--json',
      ],
      { cwd: directory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  requireThat(
    rows.length === 1 && rows[0].filename === filename,
    'Packed package identity changed',
  );
  return readNativeTarFiles(join(destination, filename), { maxArchiveBytes: 2 * 1024 ** 3 });
}

function compareMembers(packed, expected) {
  requireThat(packed.size === expected.size, 'Packed native inventory is not closed');
  for (const [path, bytes] of expected)
    requireThat(
      packed.get(`package/${path}`)?.equals(bytes),
      `Packed native bytes changed: ${path}`,
    );
}

async function identity(path, manifestBytes) {
  const bytes = await readFile(path);
  return { size: bytes.length, sha256: sha(bytes), manifestSha256: sha(manifestBytes) };
}

/** Produce a selected package and its independent complete fallback before exposing either.
 * All npm invocations are offline and skip scripts. The supplied source directory is read-only;
 * final tar members are compared with the captured bytes, so npm exclusions cannot shrink it.
 */
export async function packNativeDistribution(fullDirectory, outputDirectory, options = {}) {
  const storage = options.storage === undefined ? 'plain' : options.storage;
  const sourceDirectory = resolve(fullDirectory),
    destination = resolve(outputDirectory);
  requireThat(['plain', 'gzip-objects-v1'].includes(storage), 'Unsupported native npm storage');
  const source = await sourceInventory(sourceDirectory);
  // The pure owner validates complete inventory, platform metadata and ABI before any output.
  const plan = planNativeStorage(source);
  const filename = `${source.metadata.name}-${source.metadata.version}.tgz`;
  const scratch = await mkdtemp(join(tmpdir(), 'qq-native-distribution-'));
  let outputCreated = false;
  try {
    const full = join(scratch, 'full'),
      cache = join(scratch, 'npm-cache');
    const fullMembers = await pack(sourceDirectory, full, cache, filename);
    compareMembers(fullMembers, source.files);
    const fullIdentity = await identity(
      join(full, filename),
      fullMembers.get('package/manifest.json'),
    );
    let selected = full,
      selectedIdentity = fullIdentity;
    if (storage === 'gzip-objects-v1') {
      const staging = join(scratch, 'objects');
      await mkdir(staging);
      for (const { path, bytes } of plan.members) {
        await mkdir(dirname(join(staging, path)), { recursive: true });
        await writeFile(join(staging, path), bytes, { flag: 'wx' });
      }
      selected = join(scratch, 'selected');
      const members = await pack(staging, selected, cache, filename);
      compareMembers(members, new Map(plan.members.map(({ path, bytes }) => [path, bytes])));
      const representatives = [
        ...new Map(plan.manifest.files.map((file) => [file.sha256, file.path])).values(),
      ];
      const restored = inspectNativeObjectMembers(members, plan.manifest, representatives);
      for (const path of representatives)
        requireThat(
          restored.get(`package/${path}`).equals(source.files.get(path)),
          'Restored original bytes changed',
        );
      selectedIdentity = await identity(
        join(selected, filename),
        members.get('package/manifest.json'),
      );
    }
    // mkdir without recursive ownership refuses an existing destination. Only this invocation's
    // directory is removed on a failed copy; existing caller-owned data is never replaced.
    await mkdir(destination);
    outputCreated = true;
    if (storage === 'gzip-objects-v1') {
      await mkdir(join(destination, 'full-native'));
      await copyFile(
        join(full, filename),
        join(destination, 'full-native', filename),
        constants.COPYFILE_EXCL,
      );
    }
    await copyFile(join(selected, filename), join(destination, filename), constants.COPYFILE_EXCL);
    return {
      storage,
      tarball: filename,
      ...selectedIdentity,
      originalPaths: plan.metrics.originalPaths,
      ...(storage === 'gzip-objects-v1'
        ? {
            objectCount: plan.metrics.uniqueObjects,
            fullNativeFallback: { path: `full-native/${filename}`, ...fullIdentity },
          }
        : {}),
    };
  } catch (error) {
    if (outputCreated) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
