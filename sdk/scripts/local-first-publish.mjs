import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const targets = ['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'];
export const firstMainEvidencePaths = Object.freeze(targets.flatMap(target => ['installed-no-symlink.consumer.json','cache-no-symlink.consumer.json','source-provenance.json'].map(name => `evidence/${target}.${name}`)));
const names = [...targets.map(target => `qq-native-client-${target}`), 'qq-native-client'];
const hash = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
function requireThat(condition, message) { if (!condition) throw new Error(message); }
async function localFile(root, path) {
  requireThat(typeof path === 'string' && path && !path.includes('\\') && !path.split('/').some(part => !part || part === '..' || part === '.'), 'Unsafe artifact path');
  const file = await realpath(join(root, path));
  requireThat(file.startsWith(root + sep) && (await lstat(file)).isFile(), 'Artifact escapes directory or is not a file');
  return { path: file, bytes: await readFile(file) };
}
function tarJson(path, member) {
  const ret = spawnSync('tar', ['-xOf', path, member], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  requireThat(ret.status === 0, `Cannot inspect ${member}`);
  return { bytes: Buffer.from(ret.stdout), json: JSON.parse(ret.stdout) };
}
export async function validateRelease(directory) {
  const root = await realpath(resolve(directory));
  const manifest = JSON.parse((await localFile(root, 'release-manifest.json')).bytes);
  requireThat([1, 2].includes(manifest.schemaVersion) && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version), 'Invalid release version/schema');
  requireThat(manifest.repository === 'lc-cn/qq-native-mirror' && /^\d+$/.test(String(manifest.runId)) && /^[a-f0-9]{40}$/.test(manifest.commit), 'Invalid CI provenance');
  requireThat(Array.isArray(manifest.packages) && manifest.packages.length === 7, 'Exactly seven packages required');
  requireThat(typeof manifest.runId === 'string' && Number.isInteger(manifest.runAttempt) && manifest.runAttempt > 0, 'Invalid CI run attempt');
  const packages = [];
  let videoMaterialsPending = false;
  for (const name of names) {
    const rows = manifest.packages.filter(row => row.name === name);
    requireThat(rows.length === 1, `Missing or duplicate package: ${name}`);
    const row = rows[0];
    requireThat(row.version === manifest.version && row.tarball === `${name}-${row.version}.tgz`, `Package name/version mismatch: ${name}`);
    const file = await localFile(root, row.tarball);
    requireThat(row.size === file.bytes.length && row.sha256 === hash(file.bytes, 'sha256', 'hex') && row.integrity === `sha512-${hash(file.bytes, 'sha512', 'base64')}`, `Tarball digest/size mismatch: ${name}`);
    const pkg = tarJson(file.path, 'package/package.json').json;
    requireThat(pkg.name === name && pkg.version === row.version, `Packed metadata mismatch: ${name}`);
    if (name !== 'qq-native-client') {
      const target = name.slice('qq-native-client-'.length); const [platform, arch] = target.split('-');
      requireThat(JSON.stringify(pkg.os) === JSON.stringify([platform]) && JSON.stringify(pkg.cpu) === JSON.stringify([arch]), `Packed OS/CPU mismatch: ${name}`);
      const native = tarJson(file.path, 'package/manifest.json');
      if (native.json.videoCodec !== undefined) videoMaterialsPending = true;
      requireThat(native.json.platform === platform && native.json.arch === arch, `Native manifest platform mismatch: ${name}`);
      requireThat(row.manifestSha256 === hash(native.bytes, 'sha256', 'hex'), `Native manifest digest mismatch: ${target}`);
      requireThat(row.receipt === `evidence/${target}.consumer.json`, `Invalid receipt path: ${target}`);
      const receiptFile = await localFile(root, row.receipt);
      requireThat(row.receiptSha256 === hash(receiptFile.bytes, 'sha256', 'hex'), `Receipt digest mismatch: ${target}`);
      const receipt = JSON.parse(receiptFile.bytes);
      requireThat(receipt.platform === platform && receipt.arch === arch && receipt.installedMainOnly === true && receipt.automaticPlatformSelection === true && receipt.prepared === true && receipt.closed === true && receipt.loginAttempted === false && Number.isInteger(receipt.exports) && receipt.exports >= 80 && /^v24\./.test(receipt.node), `Unsuccessful consumer: ${target}`);

    } else {
      requireThat(names.slice(0, 6).every(dependency => pkg.optionalDependencies?.[dependency] === row.version), 'Main optional dependencies must pin all six package versions');
    }
    packages.push({ ...row, path: file.path });
  }
  const diskTarballs = (await readdir(root)).filter(name => name.endsWith('.tgz')).sort();
  requireThat(JSON.stringify(diskTarballs) === JSON.stringify(packages.map(row => row.tarball).sort()), 'Unexpected or missing tarball');
  const extended = manifest.acceptanceEvidence !== undefined || manifest.auxiliarySources !== undefined;
  const basePaths = [...targets.map(target => `evidence/${target}.consumer.json`), 'evidence/aggregated-main.consumer.json'];
  const expectedPaths = [...basePaths, ...(extended ? firstMainEvidencePaths : [])];
  const evidenceDirectory = await lstat(join(root, 'evidence'));
  requireThat(evidenceDirectory.isDirectory() && !evidenceDirectory.isSymbolicLink(), 'Evidence directory must be a regular directory');
  const diskEvidence = await readdir(join(root, 'evidence'));
  requireThat(JSON.stringify(diskEvidence.sort()) === JSON.stringify(expectedPaths.map(path => path.slice('evidence/'.length)).sort()), 'Unexpected or missing evidence files');
  for (const path of expectedPaths) requireThat((await lstat(join(root, path))).isFile() && !(await lstat(join(root, path))).isSymbolicLink(), 'Evidence must be a regular file');
  if (extended) {
    requireThat(Array.isArray(manifest.acceptanceEvidence) && manifest.acceptanceEvidence.length === 18 && Array.isArray(manifest.auxiliarySources) && manifest.auxiliarySources.length === 6, 'Incomplete first-main evidence declaration');
    for (const path of firstMainEvidencePaths) {
      const declarations = manifest.acceptanceEvidence.filter(item => item.path === path);
      requireThat(declarations.length === 1, 'Missing/duplicate first-main evidence declaration');
      const bytes = (await localFile(root, path)).bytes;
      requireThat(declarations[0].sha256 === hash(bytes, 'sha256', 'hex'), 'First-main evidence digest mismatch');
      const proof = JSON.parse(bytes), target = targets.find(target => path.startsWith(`evidence/${target}.`));
      const [platform, arch] = target.split('-');
      if (!path.endsWith('.source-provenance.json')) {
        requireThat(proof.platform === platform && proof.arch === arch && /^v(\d+)\./.test(proof.node) && Number(proof.node.match(/^v(\d+)\./)[1]) >= 24 && Number.isInteger(proof.exports) && proof.exports >= 80 && proof.prepared === true && proof.closed === true && proof.loginAttempted === false && proof.symlinkCreationDenied === true && proof.currentRun === manifest.runId, 'Unsuccessful first-main acceptance proof');
        if (path.endsWith('.cache-no-symlink.consumer.json')) requireThat(proof.cacheReused === true && Number.isInteger(proof.firstRequests) && proof.firstRequests > 0 && Number.isInteger(proof.cachedRequests) && proof.cachedRequests >= 0 && proof.cachedRequests <= 1 && proof.cachedFileRequests === 0, 'Cache acceptance did not reuse cached files');
        else requireThat(proof.installedMainOnly === true && proof.automaticPlatformSelection === true, 'Installed acceptance did not automatically select platform');
      } else {
        const row = manifest.packages.find(item => item.name === `qq-native-client-${target}`);
        requireThat(proof.schemaVersion === 1 && proof.sourceRepository === manifest.repository && proof.target === target && proof.reusedAuxiliaryBytes === true && typeof proof.sourceRunId === 'string' && /^\d+$/.test(proof.sourceRunId) && proof.sourceTag === `npm-v${manifest.version}-ci-${proof.sourceRunId}` && /^[a-f0-9]{40}$/.test(proof.sourceCommit) && Number.isInteger(proof.sourceRunAttempt) && proof.sourceRunAttempt > 0 && /^[a-f0-9]{64}$/.test(proof.releaseManifestSha256) && proof.assetDigest === `sha256:${row.sha256}`, 'Invalid auxiliary source provenance');
        requireThat(['name','version','tarball','size','sha256','integrity','manifestSha256'].every(key => proof.package?.[key] === row[key]), 'Auxiliary source package byte identity mismatch');
        const sources = manifest.auxiliarySources.filter(item => item.target === target);
        requireThat(sources.length === 1 && JSON.stringify(sources[0]) === JSON.stringify(proof), 'Auxiliary source declaration mismatch');
      }
    }
  }
  const mainReceiptBytes = (await localFile(root, 'evidence/aggregated-main.consumer.json')).bytes;
  if (manifest.schemaVersion === 2) {
    requireThat(manifest.aggregateReceipt?.path === 'evidence/aggregated-main.consumer.json' && /^[a-f0-9]{64}$/.test(manifest.aggregateReceipt?.sha256 ?? ''), 'Aggregate receipt binding missing or invalid');
    requireThat(manifest.aggregateReceipt.sha256 === hash(mainReceiptBytes, 'sha256', 'hex'), 'Aggregate receipt digest mismatch');
  }
  const mainReceipt = JSON.parse(mainReceiptBytes);
  requireThat(mainReceipt.platform === 'linux' && mainReceipt.arch === 'x64' && mainReceipt.installedMainOnly === true && mainReceipt.automaticPlatformSelection === true && mainReceipt.prepared === true && mainReceipt.closed === true && mainReceipt.loginAttempted === false && Number.isInteger(mainReceipt.exports) && mainReceipt.exports >= 80 && /^v24\./.test(mainReceipt.node), 'Aggregate main consumer failed');
  return { manifest, packages, videoMaterialsPending };
}
export function publishValidated(release, run = spawnSync) {
  requireThat(release.videoMaterialsPending !== true, 'Video runtime candidate lacks permanent corresponding-source/relink distribution; publication is unavailable until those materials are bound');
  requireThat(process.stdin.isTTY && process.stdout.isTTY, '--publish requires an interactive terminal for npm authentication/2FA');
  for (const pkg of release.packages) {
    // Read-only registry lookup. Only a structured E404 allows a new publish.
    const lookup = run('npm', ['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org/'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (lookup.status === 0) {
      requireThat(JSON.parse(lookup.stdout) === pkg.integrity, `Published integrity mismatch: ${pkg.name}`);
      console.log(`Skip identical published package: ${pkg.name}@${pkg.version}`); continue;
    }
    let error; try { error = JSON.parse(lookup.stdout); } catch { throw new Error(`Registry lookup failed: ${pkg.name}`); }
    requireThat(error?.error?.code === 'E404', `Registry lookup failed: ${pkg.name}`);
    console.log(`Publish ${pkg.name}@${pkg.version}; complete npm authentication/2FA in this terminal.`);
    const result = run('npm', ['publish', pkg.path, '--access=public', '--ignore-scripts', '--registry=https://registry.npmjs.org/'], { stdio: 'inherit' });
    requireThat(result.status === 0, `Publish failed; stopped at ${pkg.name}. No automatic retry.`);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2); const publish = args.includes('--publish');
    requireThat(args.length === (publish ? 2 : 1) && args.filter(arg => arg !== '--publish').length === 1, 'Usage: node scripts/local-first-publish.mjs ARTIFACT_DIRECTORY [--publish]');
    const release = await validateRelease(args.find(arg => arg !== '--publish'));
    console.log(`Validated ${release.manifest.repository} run ${release.manifest.runId}, commit ${release.manifest.commit}`);
    for (const pkg of release.packages) console.log(`${publish ? 'Queued' : 'Dry run'}: ${pkg.name}@${pkg.version} ${pkg.sha256}`);
    if (publish) publishValidated(release);
    else console.log('Validation complete. No registry lookup, login or publish performed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
