import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, lstat, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { npm } from '../ci/npm.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const profilePath = resolve('tools/profiles/darwin-arm64-resources-v1.json');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const safePath = path => typeof path === 'string' && path && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..');

export function validateProfile(profile) {
  check(profile.schemaVersion === 1 && profile.id === 'darwin-arm64-resources-v1' && profile.experimental === true && profile.platform === 'darwin' && profile.arch === 'arm64' && profile.sdkVersion === '0.0.2', 'Unsupported pruning profile');
  const source = profile.source;
  check(source?.repository === 'lc-cn/qq-native-mirror' && source.runId === '37925080425' && source.runAttempt === 1 && source.commit === 'b4b2e4eab5e44f99126e2efc68d6701ac7658833' && source.tag === 'npm-v0.0.2-ci-37925080425' && source.nativePaths === 1157, 'Unsupported pruning source');
  check(['releaseManifestSha256', 'nativeManifestSha256'].every(key => /^[a-f0-9]{64}$/.test(source[key] ?? '')), 'Invalid source digest');
  for (const [kind, name] of [['main', 'qq-native-client'], ['auxiliary', 'qq-native-client-darwin-arm64']]) {
    check(source[kind]?.tarball === `${name}-${profile.sdkVersion}.tgz` && /^[a-f0-9]{64}$/.test(source[kind].sha256 ?? '') && Number.isSafeInteger(source[kind].size) && source[kind].size > 0, 'Invalid source tarball');
  }
  check(profile.version?.clientVersion === '7.0.2-53644' && profile.version.appId === '537391652' && profile.version.qua === 'V1_MAC_7.0.2-53644_53644_GW_B', 'Unsupported vendor version');
  check(Array.isArray(profile.files) && profile.files.length === 47 && new Set(profile.files.map(row => row?.path)).size === 47, 'Incomplete or duplicate pruning paths');
  check(profile.files.every(row => safePath(row.path) && /^[a-f0-9]{64}$/.test(row.sha256 ?? '') && Number.isSafeInteger(row.size) && row.size > 0), 'Invalid pruning file');
  check(['wrapper.node', 'registration-bridge.node'].every(path => profile.files.some(row => row.path === path)), 'Required native entry missing');
  return profile;
}

export async function stagePrunedPackage(profile, source, destination) {
  validateProfile(profile);
  const manifestBytes = await readFile(join(source, 'manifest.json'));
  check(sha(manifestBytes) === profile.source.nativeManifestSha256, 'Native source manifest changed');
  const manifest = JSON.parse(manifestBytes);
  check(manifest.schemaVersion === 1 && manifest.platform === profile.platform && manifest.arch === profile.arch && manifest.wrapper === 'wrapper.node', 'Native source device changed');
  check(Object.entries(profile.version).every(([key, value]) => manifest.version?.[key] === value), 'Native source vendor version changed');
  check(Array.isArray(manifest.files) && manifest.files.length === profile.source.nativePaths && manifest.files.every(row => safePath(row?.path)) && new Set(manifest.files.map(row => row.path)).size === manifest.files.length, 'Native source inventory changed');
  const byPath = new Map(manifest.files.map(row => [row.path, row]));
  for (const row of profile.files) {
    check(byPath.get(row.path)?.sha256 === row.sha256, 'Pruning profile differs from source');
    const path = join(source, row.path), stat = await lstat(path);
    check(stat.isFile() && !stat.isSymbolicLink(), 'Native source path must be an ordinary file');
    const bytes = await readFile(path);
    check(sha(bytes) === row.sha256 && bytes.length === row.size, 'Native source bytes changed');
  }
  const metadata = JSON.parse(await readFile(join(source, 'package.json')));
  check(metadata.name === 'qq-native-client-darwin-arm64' && metadata.version === profile.sdkVersion && JSON.stringify(metadata.os) === '["darwin"]' && JSON.stringify(metadata.cpu) === '["arm64"]', 'Source npm metadata changed');
  // Destination must be new. Do not overwrite any full fallback or prior candidate.
  await mkdir(destination);
  for (const row of profile.files) {
    const path = join(destination, row.path);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(join(source, row.path), path);
  }
  manifest.id = `qq-${profile.version.clientVersion}-${profile.id}`;
  manifest.profile = profile.id;
  manifest.files = profile.files.map(row => ({ ...row, url: row.path }));
  metadata.description = 'Experimental CI-built resource-pruned macOS arm64 candidate; account compatibility unverified';
  metadata.files = [...profile.files.map(row => row.path), 'manifest.json', 'README.md'];
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(destination, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(destination, 'README.md'), '# Experimental resource-pruned native candidate\n\nUnpublished 47-path macOS arm64 candidate from a pinned full CI package. Account and business compatibility remain unverified. The original full default package remains available and unchanged.\n');
  return { manifestSha256: sha(await readFile(join(destination, 'manifest.json'))), nativePaths: 47 };
}

async function checkedSource(profile, directory) {
  const bytes = await readFile(join(directory, 'release-manifest.json'));
  check(sha(bytes) === profile.source.releaseManifestSha256, 'Release manifest changed');
  const manifest = JSON.parse(bytes);
  check(manifest.schemaVersion === 2 && manifest.repository === profile.source.repository && manifest.runId === profile.source.runId && manifest.runAttempt === profile.source.runAttempt && manifest.commit === profile.source.commit && manifest.version === profile.sdkVersion, 'Release provenance changed');
  for (const kind of ['main', 'auxiliary']) {
    const expected = profile.source[kind], rows = manifest.packages.filter(row => row.tarball === expected.tarball);
    check(rows.length === 1 && rows[0].sha256 === expected.sha256 && rows[0].size === expected.size, 'Source package declaration changed');
    const data = await readFile(join(directory, expected.tarball));
    check(sha(data) === expected.sha256 && data.length === expected.size, 'Source tarball changed');
  }
}

export async function buildCandidate({ sourceDirectory = 'candidate-source', outputDirectory = 'out' } = {}) {
  const profile = validateProfile(JSON.parse(await readFile(profilePath)));
  await checkedSource(profile, sourceDirectory);
  const scratch = await mkdtemp(join(tmpdir(), 'qq-pruned-pack-'));
  try {
    const source = join(scratch, 'source'); await mkdir(source);
    // Extraction is permitted only after the complete immutable source archive matches.
    execFileSync('tar', ['-xzf', resolve(sourceDirectory, profile.source.auxiliary.tarball), '-C', source]);
    const target = join(scratch, 'candidate');
    const staged = await stagePrunedPackage(profile, join(source, 'package'), target);
    await mkdir(outputDirectory);
    const packed = JSON.parse(execFileSync(npm[0], [...npm[1], 'pack', '--ignore-scripts', '--offline', '--cache', join(scratch, 'npm-cache'), '--pack-destination', resolve(outputDirectory), '--json'], { cwd: target, encoding: 'utf8' }))[0];
    const expected = [...profile.files.map(row => row.path), 'manifest.json', 'package.json', 'README.md'].sort();
    assert.deepEqual(packed.files.map(row => row.path).sort(), expected);
    check(packed.filename === profile.source.auxiliary.tarball, 'Candidate filename changed');
    await copyFile(join(sourceDirectory, profile.source.main.tarball), join(outputDirectory, profile.source.main.tarball));
    await copyFile(profilePath, join(outputDirectory, 'pruning-profile.json'));
    await copyFile(join(sourceDirectory, 'release-manifest.json'), join(outputDirectory, 'source-release-manifest.json'));
    const bytes = await readFile(join(outputDirectory, packed.filename));
    const receipt = { schemaVersion: 1, experimental: true, profile: profile.id, source: profile.source, profileSha256: sha(await readFile(profilePath)), ...staged, packagedPaths: expected.length, tarball: packed.filename, tarballSha256: sha(bytes), size: bytes.length, originalSize: profile.source.auxiliary.size, node: process.version, npm: execFileSync(npm[0], [...npm[1], '--version'], {encoding:'utf8'}).trim(), builderCommit: process.env.GITHUB_SHA ?? null, builderRunId: process.env.GITHUB_RUN_ID ?? null, accountAcceptanceEstablished: false, signingAuthenticityEstablished: false, published: false, defaultsChanged: false };
    await writeFile(join(outputDirectory, 'pruning-build.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export function validateConsumerReceipts(profile, build, receipt, environment = process.env) {
  check(build.schemaVersion === 1 && build.experimental === true && build.profile === profile.id && build.nativePaths === 47 && build.packagedPaths === 50 && build.accountAcceptanceEstablished === false && build.signingAuthenticityEstablished === false && build.published === false && build.defaultsChanged === false, 'Candidate build identity changed');
  check(build.builderCommit === (environment.GITHUB_SHA ?? null) && build.builderRunId === (environment.GITHUB_RUN_ID ?? null), 'Candidate belongs to another builder run');
  assert.deepEqual(build.source, profile.source);
  check(receipt.platform === 'darwin' && receipt.arch === 'arm64' && receipt.exports === 104 && receipt.installedMainOnly === true && receipt.automaticPlatformSelection === true && receipt.prepared === true && receipt.closed === true && receipt.loginAttempted === false && receipt.nativeHistoryQueryAttempted === false && receipt.nativeFriendListQueryAttempted === false && receipt.nativeGroupListQueryAttempted === false && receipt.nativeGroupMemberQueryAttempted === false, 'Pruned consumer acceptance failed');
  check(JSON.stringify(receipt.tarballRequests?.slice().sort()) === JSON.stringify(['qq-native-client','qq-native-client-darwin-arm64','silk-wasm'].sort()), 'Consumer did not use matching candidate packages');
}

export async function verifyConsumer(directory = 'out') {
  const profile = validateProfile(JSON.parse(await readFile(profilePath)));
  const buildBytes = await readFile(join(directory, 'pruning-build.json')), build = JSON.parse(buildBytes);
  check(build.profileSha256 === sha(await readFile(profilePath)) && sha(await readFile(join(directory, 'pruning-profile.json'))) === build.profileSha256 && sha(await readFile(join(directory, 'source-release-manifest.json'))) === profile.source.releaseManifestSha256, 'Candidate source records changed');
  const tarball = await readFile(join(directory, build.tarball));
  check(build.tarball === profile.source.auxiliary.tarball && sha(tarball) === build.tarballSha256 && tarball.length === build.size, 'Candidate package changed');
  check(sha(await readFile(join(directory, profile.source.main.tarball))) === profile.source.main.sha256, 'Installed main source changed');
  const receiptBytes = await readFile(join(directory, 'consumer.json')), receipt = JSON.parse(receiptBytes);
  validateConsumerReceipts(profile, build, receipt);
  const result = { profile: profile.id, source: profile.source, candidateTarballSha256: build.tarballSha256, buildReceiptSha256: sha(buildBytes), consumerReceiptSha256: sha(receiptBytes), prepared: true, closed: true, loginAttempted: false, accountAcceptanceEstablished: false, signingAuthenticityEstablished: false, published: false, defaultsChanged: false, builderCommit: process.env.GITHUB_SHA ?? null, builderRunId: process.env.GITHUB_RUN_ID ?? null };
  await writeFile(join(directory, 'pruning-acceptance.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    check(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === '--verify-consumer'), 'Invalid pruning arguments');
    console.log(JSON.stringify(process.argv[2] ? await verifyConsumer() : await buildCandidate()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
