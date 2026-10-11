import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { npm } from './npm.mjs';
import { validateNativeStorageReceipt } from '../sdk/scripts/local-first-publish.mjs';
import { inspectNativeFallbackPair } from '../sdk/scripts/native-fallbacks.mjs';
import { readNativeTarFiles } from '../sdk/scripts/native-tar-files.mjs';
const sha = (data, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(data).digest(encoding);
const devices = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];
const sdk = JSON.parse(await readFile('sdk/package.json', 'utf8'));
const release = resolve('release');
await mkdir(join(release, 'evidence'), { recursive: true });
const {
  GITHUB_REPOSITORY: repository,
  GITHUB_SHA: commit,
  GITHUB_RUN_ID: runId,
  GITHUB_RUN_ATTEMPT: attempt,
} = process.env;
if (
  repository !== 'lc-cn/qq-native-mirror' ||
  !/^[a-f0-9]{40}$/.test(commit ?? '') ||
  !/^\d+$/.test(runId ?? '') ||
  !/^\d+$/.test(attempt ?? '')
)
  throw Error('GitHub release identity missing');
const packages = [],
  nativeFallbacks = [];
let selectedStorage;
for (const device of devices) {
  const [platform, arch] = device.split('-'),
    name = `qq-native-client-${device}`;
  const input = resolve('artifacts', `npm-${device}`),
    tarball = `${name}-${sdk.version}.tgz`;
  const bytes = await readFile(join(input, tarball));
  const members = await readNativeTarFiles(join(input, tarball), {
    maxArchiveBytes: 2 * 1024 ** 3,
  });
  const pkg = JSON.parse(members.get('package/package.json'));
  const nativeBytes = members.get('package/manifest.json');
  const native = JSON.parse(nativeBytes);
  const storage = native.npmStorage === undefined ? 'plain' : native.npmStorage.format;
  if (
    !['plain', 'gzip-objects-v1'].includes(storage) ||
    (selectedStorage !== undefined && selectedStorage !== storage)
  )
    throw Error('Mixed or unsupported native storage');
  selectedStorage = storage;
  if (
    pkg.name !== name ||
    pkg.version !== sdk.version ||
    pkg.os?.[0] !== platform ||
    pkg.cpu?.[0] !== arch ||
    native.platform !== platform ||
    native.arch !== arch ||
    sdk.optionalDependencies[name] !== sdk.version
  )
    throw Error(`Package identity mismatch: ${device}`);
  const receiptBytes = await readFile(join(input, 'consumer.json')),
    receipt = JSON.parse(receiptBytes);
  let testedMain;
  if (storage === 'gzip-objects-v1') {
    const mainName = `qq-native-client-${sdk.version}.tgz`,
      mainBytes = await readFile(join(input, mainName));
    validateNativeStorageReceipt(native, receipt, {
      auxiliarySha256: sha(bytes),
      manifestSha256: sha(nativeBytes),
      mainSha256: sha(mainBytes),
    });
    const build = JSON.parse(await readFile(join(input, 'build.json')));
    const distribution = build.distribution;
    if (
      build.ci?.repository !== repository ||
      build.ci?.commit !== commit ||
      build.ci?.runId !== runId ||
      build.ci?.runAttempt !== Number(attempt)
    )
      throw Error(`Distribution differs from current CI run: ${device}`);
    if (
      build.platform !== platform ||
      build.arch !== arch ||
      build.sdkVersion !== sdk.version ||
      distribution?.storage !== storage ||
      distribution.tarball !== tarball ||
      distribution.sha256 !== sha(bytes) ||
      distribution.size !== bytes.length ||
      distribution.manifestSha256 !== sha(nativeBytes) ||
      distribution.originalPaths !== native.files.length ||
      distribution.objectCount !== native.npmStorage.objects.length ||
      build.files !== native.files.length
    )
      throw Error(`Distribution receipt mismatch: ${device}`);
    const fallback = distribution.fullNativeFallback;
    if (fallback?.path !== `full-native/${tarball}`)
      throw Error(`Missing full native fallback: ${device}`);
    const fallbackBytes = await readFile(join(input, fallback.path)),
      fullMembers = await readNativeTarFiles(join(input, fallback.path), {
        maxArchiveBytes: 2 * 1024 ** 3,
      });
    if (
      fallback.sha256 !== sha(fallbackBytes) ||
      fallback.size !== fallbackBytes.length ||
      fallback.manifestSha256 !== sha(fullMembers.get('package/manifest.json'))
    )
      throw Error(`Full native fallback identity mismatch: ${device}`);
    inspectNativeFallbackPair(members, fullMembers);
    await mkdir(join(release, 'full-native'), { recursive: true });
    await copyFile(join(input, fallback.path), join(release, fallback.path));
    nativeFallbacks.push({
      name,
      version: sdk.version,
      path: fallback.path,
      size: fallbackBytes.length,
      sha256: sha(fallbackBytes),
      integrity: 'sha512-' + sha(fallbackBytes, 'sha512', 'base64'),
      manifestSha256: fallback.manifestSha256,
    });
    await mkdir(join(release, 'tested-main', device), { recursive: true });
    const mainPath = `tested-main/${device}/${mainName}`;
    await copyFile(join(input, mainName), join(release, mainPath));
    testedMain = {
      path: mainPath,
      size: mainBytes.length,
      sha256: sha(mainBytes),
      integrity: 'sha512-' + sha(mainBytes, 'sha512', 'base64'),
    };
  } else
    validateNativeStorageReceipt(native, receipt, {
      auxiliarySha256: sha(bytes),
      manifestSha256: sha(nativeBytes),
    });
  if (
    receipt.platform !== platform ||
    receipt.arch !== arch ||
    receipt.exports < 80 ||
    !receipt.installedMainOnly ||
    !receipt.automaticPlatformSelection ||
    !receipt.prepared ||
    !receipt.closed ||
    receipt.loginAttempted !== false
  )
    throw Error(`Consumer failed: ${device}`);
  if (
    native.videoCodec !== 'video/video-codec.node' ||
    receipt.automaticVideoCodec !== true ||
    receipt.installedVideoDecoder !== true ||
    receipt.installedVideoFakeCache !== true ||
    receipt.installedVideo?.noQQ !== true ||
    receipt.installedVideo?.noAccount !== true ||
    receipt.installedVideo?.nativeSendAttempted !== false ||
    receipt.installedVideo?.inputs?.length !== 3
  )
    throw Error(`Automatic installed codec failed: ${device}`);
  const codecFile = native.files.find((f) => f.path === native.videoCodec);
  if (!codecFile || codecFile.sha256 !== receipt.installedVideo.binary?.sha256)
    throw Error(`Installed video binary receipt mismatch: ${device}`);
  const bridgeName = platform === 'win32' ? 'QQNT.dll' : 'registration-bridge.node';
  const bridge = await readFile(join(input, 'bridges', device, bridgeName));
  if (native.files.find((f) => f.path === bridgeName)?.sha256 !== sha(bridge))
    throw Error(`Bridge mismatch: ${device}`);
  await mkdir(join('sdk/native', device), { recursive: true });
  await writeFile(join('sdk/native', device, bridgeName), bridge);
  if (platform === 'win32') {
    const license = await readFile(join(input, 'bridges', device, 'NODE-LICENSE.txt'));
    if (native.files.find((f) => f.path === 'NODE-LICENSE.txt')?.sha256 !== sha(license))
      throw Error(`License mismatch: ${device}`);
    await writeFile(join('sdk/native', device, 'NODE-LICENSE.txt'), license);
  }
  await copyFile(join(input, tarball), join(release, tarball));
  const receiptPath = `evidence/${device}.consumer.json`;
  await writeFile(join(release, receiptPath), receiptBytes);
  packages.push({
    name,
    version: sdk.version,
    tarball,
    size: bytes.length,
    sha256: sha(bytes),
    integrity: 'sha512-' + sha(bytes, 'sha512', 'base64'),
    manifestSha256: sha(nativeBytes),
    receipt: receiptPath,
    receiptSha256: sha(receiptBytes),
    ...(testedMain ? { testedMain } : {}),
  });
}
// The main package is compiled and packed by this CI job after all six bridges are present.
execFileSync(npm[0], [...npm[1], 'exec', 'tsc'], { cwd: resolve('sdk'), stdio: 'inherit' });
execFileSync(npm[0], [...npm[1], 'pack', '--ignore-scripts', '--pack-destination', release], {
  cwd: resolve('sdk'),
  stdio: 'inherit',
});
const tarball = `${sdk.name}-${sdk.version}.tgz`,
  bytes = await readFile(join(release, tarball));
packages.push({
  name: sdk.name,
  version: sdk.version,
  tarball,
  size: bytes.length,
  sha256: sha(bytes),
  integrity: 'sha512-' + sha(bytes, 'sha512', 'base64'),
});
// The producer materials have already been archived before any platform package
// was built. Retain their exact binding/report bytes with the seven-package set.
const bindingBytes = await readFile('out/video-materials/video-materials-binding.json');
const reportBytes = await readFile('out/video-materials/video-materials.json');
const binding = JSON.parse(bindingBytes);
if (
  binding.repository !== repository ||
  binding.commit !== commit ||
  binding.runId !== runId ||
  binding.runAttempt !== Number(attempt) ||
  binding.version !== sdk.version
)
  throw Error('Video materials differ from this package run');
await mkdir(join(release, 'video-materials'), { recursive: true });
await writeFile(join(release, 'video-materials/video-materials-binding.json'), bindingBytes);
await writeFile(join(release, 'video-materials/video-materials.json'), reportBytes);
const videoMaterials = {
  binding: { path: 'video-materials/video-materials-binding.json', sha256: sha(bindingBytes) },
  report: { path: 'video-materials/video-materials.json', sha256: sha(reportBytes) },
};
await writeFile(
  join(release, 'release-manifest.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      repository,
      commit,
      runId,
      runAttempt: Number(attempt),
      version: sdk.version,
      packages,
      videoMaterials,
      ...(nativeFallbacks.length ? { nativeFallbacks } : {}),
    },
    null,
    2,
  ) + '\n',
);
