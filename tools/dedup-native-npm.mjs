import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { validateRelease } from '../sdk/scripts/local-first-publish.mjs';
import { npm } from '../ci/npm.mjs';
import { readNativeTarFiles } from '../sdk/scripts/native-tar-files.mjs';
import { planNativeStorage } from './native-storage-plan.mjs';
import { inspectNativeSourceIdentity } from './native-source-identity.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(repo, '../..');

export const sourcePins = {
  'linux-x64': {
    manifestSha256: '4ae75dbf26c44673fb4226726a1f5ed884b513de7b5f0b2055a0162692f060c5',
    nativePaths: 19,
    tarballSha256: 'eb7c43401b42f0eb1186037700fb7e80194d072936c954bcf12838051852bfe7',
    tarballSize: 70030024,
  },
  'linux-arm64': {
    manifestSha256: '20b4c73d56324a28ee1c42fdba101b24b94999cae9966dc8a1f995d70f9e97f0',
    nativePaths: 20,
    tarballSha256: 'a68e18dcef2af72176cd2d7d64b4b9e8c41d4191202c9a202793052c93bc34b8',
    tarballSize: 72005502,
  },
  'darwin-x64': {
    manifestSha256: 'b69b9c0709c2afe10a4857d96aa3a0d88e599b53fbd7f19304a40e1077fcfbfd',
    nativePaths: 1168,
    tarballSha256: '5629121c461b0031cca0f5b69d6a0e83a5a4193dda8235fceb805235b7bf77e7',
    tarballSize: 65852287,
  },
  'darwin-arm64': {
    manifestSha256: 'a3c633ad5fc13082b5b8ffa7aa3e09b9a9d37708300bf5df3ea66bd0daa729df',
    nativePaths: 1168,
    tarballSha256: '17df5e2ec460ff2e21209eea473030f6dd4911c43774872d6d4f33417281d586',
    tarballSize: 59911840,
  },
  'win32-x64': {
    manifestSha256: '54ada05e9f19d3394283def363a965902d32dd42fb2f4ae9d4fa0bccc99894a6',
    nativePaths: 32,
    tarballSha256: 'eb599527b8c4eb47cf5bc1f7c9eafbb84b1acf91d26587ff93da19bcd218aa9b',
    tarballSize: 66610876,
  },
  'win32-arm64': {
    manifestSha256: '1889d069ba871386b2e467b6f4c173b8c93e06d143e474cbc7383bcc51dbcf1a',
    nativePaths: 27,
    tarballSha256: '14e9c002c86e4f286eb88bb620565d64032525bdd2f62a6a446b1e1ea6998b27',
    tarballSize: 54122150,
  },
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};
const isSafePackagePath = (path) =>
  typeof path === 'string' &&
  path.length > 0 &&
  !/[\\\0:\r\n]/.test(path) &&
  !path.startsWith('/') &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');
/** Stage a validated complete archive into a new package directory. */
export async function stageDeduplicatedPackage(sourceMap, destination) {
  const plan = planNativeStorage(sourceMap);
  await mkdir(destination);
  await mkdir(join(destination, 'objects'));
  for (const member of plan.members) {
    await writeFile(join(destination, member.path), member.bytes, { flag: 'wx' });
  }
  return { manifest: plan.manifest, ...plan.metrics };
}
async function sourceFiles(tar) {
  const original = await readNativeTarFiles(tar, {
    maxArchiveBytes: 2 * 1024 ** 3,
    maxFileBytes: 512 * 1024 ** 2,
    maxMembers: 10000,
  });
  const files = new Map();
  for (const [path, bytes] of original) {
    requireCondition(
      path.startsWith('package/') && isSafePackagePath(path.slice(8)),
      'Tar file must be inside package',
    );
    files.set(path.slice(8), bytes);
  }
  return files;
}
async function sourceTar(tar) {
  const files = await sourceFiles(tar);
  return {
    metadata: JSON.parse(files.get('package.json')),
    manifest: JSON.parse(files.get('manifest.json')),
    files,
  };
}
async function readPinnedSource(device, sourceDirectory, sourceReleaseSha256) {
  requireCondition(Object.hasOwn(sourcePins, device), 'Unsupported candidate device');
  const releaseBytes = await readFile(join(sourceDirectory, 'release-manifest.json'));
  const expectedReleaseSha256 =
    sourceReleaseSha256 === undefined
      ? '9a362f3c4abada4c8cfc397039c20835bcb5393e0ae356873cccb518be9c8e1a'
      : sourceReleaseSha256;
  const boundRelease = inspectNativeSourceIdentity(releaseBytes, expectedReleaseSha256);
  const validated = await validateRelease(sourceDirectory);
  const release = validated.manifest;
  requireCondition(
    JSON.stringify(release) === JSON.stringify(boundRelease),
    'Source release changed during validation',
  );
  requireCondition(
    release.schemaVersion === 2 &&
      (sourceReleaseSha256 !== undefined ||
        (release.commit === '6cae1ec0a5e1bfb03cb7871083915b3d03272347' &&
          release.runId === '37962268125' &&
          release.runAttempt === 1 &&
          release.version === '0.0.2')) &&
      validated.videoMaterials?.pending === false,
    'Source complete release/materials identity mismatch',
  );
  requireCondition(sha256(releaseBytes) === expectedReleaseSha256, 'Source release bytes mismatch');
  const row = release.packages.find((pkg) => pkg.name === 'qq-native-client-' + device);
  requireCondition(row, 'Missing native source package');
  const expected = row.manifestSha256;
  const pin = sourcePins[device];
  if (sourceReleaseSha256 === undefined)
    requireCondition(
      row.manifestSha256 === pin.manifestSha256 &&
        row.sha256 === pin.tarballSha256 &&
        row.size === pin.tarballSize,
      'Native source manifest/tarball pin mismatch',
    );
  const source = await sourceTar(join(sourceDirectory, row.tarball));
  requireCondition(
    (sourceReleaseSha256 !== undefined || source.manifest.files.length === pin.nativePaths) &&
      source.metadata.version === release.version &&
      sha256(source.files.get('manifest.json')) === expected,
    'Source full inventory mismatch',
  );
  return { release, releaseBytes, row, source, expected };
}

// Verify the delivered archive, rather than trusting npm's member list or staging alone.
async function verifyPackedInventory(tarball, staged, source) {
  const packedFiles = await sourceFiles(tarball);
  requireCondition(
    packedFiles.size === staged.uniqueObjects + 3 &&
      sha256(packedFiles.get('manifest.json')) === staged.nativeManifestSha256,
    'Packed manifest or inventory changed',
  );
  for (const object of staged.manifest.npmStorage.objects) {
    const bytes = packedFiles.get(object.path);
    requireCondition(
      sha256(bytes) === object.downloadSha256 && bytes.length === object.downloadSize,
      'Packed gzip differs',
    );
    const restored = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
    requireCondition(
      sha256(restored) === object.sha256 && restored.length === object.size,
      'Packed restore differs',
    );
    for (const file of staged.manifest.files.filter((f) => f.sha256 === object.sha256))
      requireCondition(restored.equals(source.files.get(file.path)), 'Original path byte mismatch');
  }
}

export async function buildCandidate(
  device,
  outputDirectory,
  sourceDirectory = join(workspace, '.local/releases/npm-0.0.2-ci-37962268125'),
  options = {},
) {
  // Capture the caller's independent trust root before source reads can yield.
  const sourceReleaseSha256 = options.sourceReleaseSha256;
  const { release, releaseBytes, row, source, expected } = await readPinnedSource(
    device,
    sourceDirectory,
    sourceReleaseSha256,
  );
  const scratch = await mkdtemp(join(tmpdir(), 'qq-dedup-pack-'));
  try {
    const directory = join(scratch, 'package');
    const staged = await stageDeduplicatedPackage(source, directory);
    await mkdir(outputDirectory);
    const packed = JSON.parse(
      execFileSync(
        npm[0],
        [
          ...npm[1],
          'pack',
          '--ignore-scripts',
          '--offline',
          '--cache',
          join(scratch, 'npm-cache'),
          '--pack-destination',
          resolve(outputDirectory),
          '--json',
        ],
        { cwd: directory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      ),
    )[0];
    requireCondition(
      packed.filename === row.tarball && packed.files.length === staged.uniqueObjects + 3,
      'Packed member count mismatch',
    );
    await verifyPackedInventory(join(outputDirectory, packed.filename), staged, source);
    const tarBytes = await readFile(join(outputDirectory, packed.filename));
    const { manifest: _manifest, ...measured } = staged;
    const receipt = {
      schemaVersion: 1,
      experimental: true,
      device,
      sourceRelease: {
        repository: release.repository,
        commit: release.commit,
        runId: release.runId,
        runAttempt: release.runAttempt,
        releaseManifestSha256: sha256(releaseBytes),
      },
      sourceTarballSha256: row.sha256,
      sourceTarballBytes: row.size,
      sourceNativeManifestSha256: expected,
      ...measured,
      tarball: packed.filename,
      tarballSha256: sha256(tarBytes),
      tarballBytes: tarBytes.length,
      packedPaths: packed.files.length,
      allOriginalBytesRestored: true,
      videoMaterials: release.videoMaterials,
      accountAcceptanceEstablished: false,
      signingAuthenticityEstablished: false,
      installedHydrationVerified: false,
      nativeExecuted: false,
      published: false,
      defaultsChanged: false,
    };
    receipt.source = {
      ...receipt.sourceRelease,
      auxiliary: {
        tarball: row.tarball,
        sha256: row.sha256,
        size: row.size,
        nativeManifestSha256: expected,
      },
    };
    receipt.candidate = {
      tarball: packed.filename,
      sha256: sha256(tarBytes),
      size: tarBytes.length,
      nativeManifestSha256: staged.nativeManifestSha256,
      nativePaths: staged.originalPaths,
      objectCount: staged.uniqueObjects,
    };
    await writeFile(
      join(outputDirectory, 'source-native-manifest.json'),
      source.files.get('manifest.json'),
    );
    await writeFile(join(outputDirectory, 'source-release-manifest.json'), releaseBytes);
    await writeFile(
      join(outputDirectory, 'dedup-build.json'),
      JSON.stringify(receipt, null, 2) + '\n',
    );
    await copyFile(join(directory, 'manifest.json'), join(outputDirectory, 'native-manifest.json'));
    return receipt;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const options = {};
  requireCondition(
    args.length % 2 === 0,
    'Usage: node tools/dedup-native-npm.mjs --device DEVICE [--source DIR --out DIR]',
  );
  for (let i = 0; i < args.length; i += 2) {
    requireCondition(
      ['--device', '--source', '--out', '--source-release-sha256'].includes(args[i]) &&
        options[args[i]] === undefined,
      'Invalid/duplicate argument',
    );
    options[args[i]] = args[i + 1];
  }
  requireCondition(options['--device'], 'Device required');
  const out =
    options['--out'] ??
    join(workspace, `.local/releases/dedup-full-${options['--device']}-local-v1`);
  console.log(
    JSON.stringify(
      await buildCandidate(options['--device'], out, options['--source'], {
        sourceReleaseSha256: options['--source-release-sha256'],
      }),
      null,
      2,
    ),
  );
}
