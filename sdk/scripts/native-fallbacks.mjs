import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readNativeTarFiles } from './native-tar-files.mjs';
import { inspectNativeObjectMembers } from './native-object-members.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Compare a delivered object archive with its independent complete original archive.
 * Decompress one representative per raw digest, then compare every original path's bytes.
 * Package delivery description/files and README may differ; all runtime metadata must agree.
 */
export function inspectNativeFallbackPair(selected, full) {
  const native = JSON.parse(selected.get('package/manifest.json'));
  const original = JSON.parse(full.get('package/manifest.json'));
  requireThat(
    original.npmStorage === undefined,
    'Native fallback must be a plain complete archive',
  );
  requireThat(Array.isArray(original.files), 'Missing native fallback inventory');
  const representatives = [
    ...new Map(native.files.map((file) => [file.sha256, file.path])).values(),
  ];
  const restored = inspectNativeObjectMembers(selected, native, representatives);
  const byDigest = new Map(
    representatives.map((path) => {
      const file = native.files.find((file) => file.path === path);
      return [file.sha256, restored.get(`package/${path}`)];
    }),
  );
  const expected = new Set(['package/package.json', 'package/manifest.json', 'package/README.md']);
  const normalized = [];
  for (const file of original.files) {
    const path = `package/${file.path}`,
      bytes = full.get(path);
    requireThat(
      !expected.has(path) &&
        Buffer.isBuffer(bytes) &&
        file.encoding === undefined &&
        file.downloadSha256 === undefined &&
        sha(bytes) === file.sha256 &&
        (file.size === undefined || file.size === bytes.length) &&
        byDigest.get(file.sha256)?.equals(bytes),
      'Native fallback original bytes differ',
    );
    expected.add(path);
    normalized.push({ ...file, size: bytes.length, url: file.path });
  }
  requireThat(
    full.size === expected.size && [...full.keys()].every((path) => expected.has(path)),
    'Native fallback inventory is not closed',
  );
  const { npmStorage: _storage, ...runtimeManifest } = native;
  requireThat(
    isDeepStrictEqual(runtimeManifest, { ...original, files: normalized }),
    'Native fallback runtime metadata differ',
  );
  const originalPackage = JSON.parse(full.get('package/package.json'));
  const selectedPackage = JSON.parse(selected.get('package/package.json'));
  requireThat(
    (!originalPackage.scripts || Object.keys(originalPackage.scripts).length === 0) &&
      (!selectedPackage.scripts || Object.keys(selectedPackage.scripts).length === 0),
    'Native fallback scripts are not permitted',
  );
  const deliveryFields = ({
    description: _description,
    files: _files,
    scripts: _scripts,
    ...identity
  }) => identity;
  requireThat(
    isDeepStrictEqual(deliveryFields(originalPackage), deliveryFields(selectedPackage)),
    'Native fallback npm metadata differ',
  );
  return { originalPaths: original.files.length, allOriginalBytesEqual: true };
}

async function regularDirectory(path, message) {
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink(), message);
}

async function verifiedFile(root, row, expectedPath) {
  requireThat(row?.path === expectedPath, 'Invalid retained native artifact path');
  const path = join(root, expectedPath),
    stat = await lstat(path);
  requireThat(
    stat.isFile() && !stat.isSymbolicLink(),
    'Retained native artifact must be a regular file',
  );
  const bytes = await readFile(path);
  requireThat(
    row.size === bytes.length &&
      row.sha256 === sha(bytes) &&
      row.integrity === 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    'Retained native artifact identity mismatch',
  );
  return path;
}

/** A transformed release retains all six complete fallbacks and the exact tested mains.
 * Legacy plain releases need neither declaration. No native code or network is executed here.
 */
export async function validateNativeFallbacks(root, release, nativePackages) {
  const objects = nativePackages.filter(({ native }) => native.npmStorage !== undefined);
  if (!objects.length) {
    requireThat(
      release.nativeFallbacks === undefined,
      'Plain release cannot declare object fallbacks',
    );
    for (const directory of ['full-native', 'tested-main']) {
      try {
        await lstat(join(root, directory));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('Unexpected retained native artifact directory');
    }
    return;
  }
  requireThat(
    objects.length === 6 &&
      Array.isArray(release.nativeFallbacks) &&
      release.nativeFallbacks.length === 6,
    'Object release requires six complete native fallbacks',
  );
  await regularDirectory(join(root, 'full-native'), 'Native fallback directory must be regular');
  await regularDirectory(join(root, 'tested-main'), 'Tested main directory must be regular');
  const expectedFallbacks = [],
    expectedDevices = [];
  for (const { path, target, receipt } of objects) {
    const name = `qq-native-client-${target}`;
    const rows = release.nativeFallbacks.filter((row) => row.name === name);
    requireThat(
      rows.length === 1 && rows[0].version === release.version,
      'Native fallback declaration mismatch',
    );
    const declaration = rows[0],
      filename = `${name}-${release.version}.tgz`;
    const fallback = await verifiedFile(root, declaration, `full-native/${filename}`);
    const fullMembers = await readNativeTarFiles(fallback, { maxArchiveBytes: 2 * 1024 ** 3 });
    requireThat(
      declaration.manifestSha256 === sha(fullMembers.get('package/manifest.json')),
      'Native fallback manifest identity mismatch',
    );
    const selected = await readNativeTarFiles(path, { maxArchiveBytes: 2 * 1024 ** 3 });
    inspectNativeFallbackPair(selected, fullMembers);
    const row = release.packages.find((row) => row.name === name);
    const mainName = `qq-native-client-${release.version}.tgz`;
    await regularDirectory(
      join(root, 'tested-main', target),
      'Tested main device directory must be regular',
    );
    const main = await verifiedFile(root, row.testedMain, `tested-main/${target}/${mainName}`);
    const mainFiles = await readNativeTarFiles(main);
    const pkg = JSON.parse(mainFiles.get('package/package.json'));
    requireThat(
      pkg.name === 'qq-native-client' &&
        pkg.version === release.version &&
        nativePackages.every(
          ({ target }) =>
            pkg.optionalDependencies?.[`qq-native-client-${target}`] === release.version,
        ) &&
        row.testedMain.sha256 === receipt.installedNativeStorage.mainPackageSha256,
      'Object consumer tested main identity mismatch',
    );
    requireThat(
      isDeepStrictEqual((await readdir(join(root, 'tested-main', target))).sort(), [mainName]),
      'Unexpected tested main device inventory',
    );
    expectedFallbacks.push(filename);
    expectedDevices.push(target);
  }
  requireThat(
    isDeepStrictEqual(
      (await readdir(join(root, 'full-native'))).sort(),
      expectedFallbacks.sort(),
    ) &&
      isDeepStrictEqual((await readdir(join(root, 'tested-main'))).sort(), expectedDevices.sort()),
    'Retained native artifact inventory is not closed',
  );
}
