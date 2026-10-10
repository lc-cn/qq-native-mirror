import assert from 'node:assert/strict';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateRelease } from './local-first-publish.mjs';
import { verifyVideoMaterialsOnline, videoTargets } from './video-materials.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => {
  if (!value) throw Error(message);
};
const safe = (value) =>
  typeof value === 'string' &&
  value &&
  !/[\\\0:\r\n\t]/.test(value) &&
  !value.startsWith('/') &&
  !value.split('/').some((part) => !part || part === '.' || part === '..');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
async function regular(root, path, maxBytes = 32 * 1024 * 1024) {
  check(safe(path), 'Unsafe stage path');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    check(!(await lstat(current)).isSymbolicLink(), 'Stage symlink rejected');
  }
  const stat = await lstat(current);
  check(stat.isFile() && stat.size <= maxBytes, 'Stage member must be bounded regular file');
  const actual = await realpath(current);
  check(actual.startsWith(root + sep), 'Stage escapes root');
  return readFile(actual);
}
async function directory(path) {
  check(
    (await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink(),
    'Regular directory required',
  );
  return realpath(path);
}
/** Pure asset validation is shared with tests; no account/native/network operations. */
export function verifyStagedAsset(meta, bytes) {
  check(
    meta &&
      /^[a-f0-9]{64}\.gz$/.test(meta.name) &&
      digest(meta.sha256) &&
      digest(meta.rawSha256) &&
      meta.name === `${meta.rawSha256}.gz` &&
      Number.isSafeInteger(meta.size) &&
      meta.size > 0 &&
      meta.size === bytes.length &&
      meta.size <= 512 * 1024 * 1024 &&
      Number.isSafeInteger(meta.rawSize) &&
      meta.rawSize >= 0 &&
      meta.rawSize <= 512 * 1024 * 1024,
    'Invalid compressed asset metadata',
  );
  check(sha(bytes) === meta.sha256, 'Compressed asset SHA mismatch');
  const raw = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  check(
    raw.length === meta.rawSize && sha(raw) === meta.rawSha256,
    'Compressed raw SHA/size mismatch',
  );
  return raw;
}
/** Compare the complete native contract; only named delivery fields may change. */
export function verifyStagedManifest(original, staged, row, assets, identity) {
  const target = `${row.platform}-${row.arch}`,
    id = `npm-${identity.version}-ci-${identity.runId}-attempt-${identity.runAttempt}-${target}-codec-gzip-v1`;
  check(
    videoTargets.includes(target) &&
      original.platform === row.platform &&
      original.arch === row.arch &&
      Array.isArray(original.files) &&
      original.files.length > 0,
    'Native target/inventory mismatch',
  );
  const paths = new Set();
  for (const file of original.files) {
    check(safe(file?.path) && !paths.has(file.path), 'Duplicate/unsafe source path');
    paths.add(file.path);
  }
  const expectedFiles = original.files.map((file) => {
    check(safe(file.path) && digest(file.sha256), 'Invalid source file');
    const asset = assets.get(`${file.sha256}.gz`);
    check(
      asset &&
        asset.rawSha256 === file.sha256 &&
        (file.size === undefined || file.size === asset.rawSize),
      'Missing source payload asset',
    );
    return {
      ...file,
      size: asset.rawSize,
      url: `https://github.com/lc-cn/qq-native-mirror/releases/download/${identity.tag}/${asset.name}`,
      encoding: 'gzip',
      downloadSha256: asset.sha256,
    };
  });
  assert.deepEqual(
    staged,
    { ...original, id, files: expectedFiles },
    'Staged manifest changed native contract',
  );
  assert.deepEqual(row.version, original.version, 'Staged vendor version differs');
  check(
    row.manifestPath === `manifests/${target}.json` &&
      row.repoPath === `packages/${id}/${row.manifestSha256}/manifest.json`,
    'Noncanonical staged manifest path',
  );
  return expectedFiles.map((file) => `${file.sha256}.gz`);
}
export async function verifyNpmNativeMirrorStage(
  releaseDir,
  stageDir,
  { verifyOnline = verifyVideoMaterialsOnline } = {},
) {
  const releaseRoot = await directory(resolve(releaseDir)),
    stageRoot = await directory(resolve(stageDir));
  check(
    releaseRoot !== stageRoot &&
      !releaseRoot.startsWith(stageRoot + sep) &&
      !stageRoot.startsWith(releaseRoot + sep),
    'Release/stage must be independent',
  );
  const release = await validateRelease(releaseRoot);
  check(
    release.videoMaterials?.pending === false && !release.videoMaterialsPending,
    'Complete video materials closure required',
  );
  await verifyOnline(release.videoMaterials);
  check(release.videoMaterials.onlineVerified === true, 'Online source closure required');
  const source = release.manifest,
    plan = JSON.parse(await regular(stageRoot, 'mirror-plan.json'));
  check(
    plan.schemaVersion === 1 &&
      plan.repository === 'lc-cn/qq-native-mirror' &&
      source.repository === plan.repository &&
      plan.tag ===
        `native-npm-v${source.version}-ci-${source.runId}-attempt-${source.runAttempt}` &&
      plan.uploaded === false &&
      plan.catalogChanged === false &&
      plan.nativeExecuted === false,
    'Stage identity or action flags invalid',
  );
  assert.deepEqual(
    plan.sourceRelease,
    {
      commit: source.commit,
      runId: source.runId,
      runAttempt: source.runAttempt,
      version: source.version,
      releaseManifestSha256: sha(await readFile(join(releaseRoot, 'release-manifest.json'))),
    },
    'Stage source release differs',
  );
  check(
    Array.isArray(plan.packages) &&
      plan.packages.length === 6 &&
      new Set(plan.packages.map((row) => `${row.platform}-${row.arch}`)).size === 6,
    'Six distinct stage packages required',
  );
  check(Array.isArray(plan.assets) && plan.assets.length > 0, 'Stage assets missing');
  assert.deepEqual((await readdir(stageRoot)).sort(), ['assets', 'manifests', 'mirror-plan.json']);
  await directory(join(stageRoot, 'assets'));
  await directory(join(stageRoot, 'manifests'));
  const assets = new Map();
  for (const meta of plan.assets) {
    check(meta && safe(meta.name) && !assets.has(meta.name), 'Duplicate/unsafe asset');
    const bytes = await regular(stageRoot, `assets/${meta.name}`, 512 * 1024 * 1024);
    verifyStagedAsset(meta, bytes);
    assets.set(meta.name, { ...meta, path: join(stageRoot, 'assets', meta.name) });
  }
  assert.deepEqual(
    (await readdir(join(stageRoot, 'assets'))).sort(),
    [...assets.keys()].sort(),
    'Unexpected staged assets',
  );
  assert.deepEqual(
    (await readdir(join(stageRoot, 'manifests'))).sort(),
    videoTargets.map((target) => `${target}.json`).sort(),
    'Unexpected staged manifests',
  );
  const expectedAssets = new Set(),
    manifestRows = [];
  for (const row of plan.packages) {
    const target = `${row.platform}-${row.arch}`,
      sourcePackage = release.packages.find((pkg) => pkg.name === `qq-native-client-${target}`);
    check(
      sourcePackage &&
        row.sourceTarballSha256 === sourcePackage.sha256 &&
        row.sourceManifestSha256 === sourcePackage.manifestSha256 &&
        digest(row.manifestSha256),
      'Stage package source hash mismatch',
    );
    const originalBytes = execFileSync(
      'tar',
      ['-xOf', sourcePackage.path, 'package/manifest.json'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    check(sha(originalBytes) === row.sourceManifestSha256, 'Original native manifest SHA mismatch');
    const body = await regular(stageRoot, row.manifestPath);
    check(sha(body) === row.manifestSha256, 'Staged manifest SHA mismatch');
    const staged = JSON.parse(body);
    for (const name of verifyStagedManifest(JSON.parse(originalBytes), staged, row, assets, {
      version: source.version,
      runId: source.runId,
      runAttempt: source.runAttempt,
      tag: plan.tag,
    }))
      expectedAssets.add(name);
    manifestRows.push({ ...row, path: join(stageRoot, row.manifestPath), manifest: staged });
  }
  assert.deepEqual(
    [...assets.keys()].sort(),
    [...expectedAssets].sort(),
    'Stage assets differ from exact source union',
  );
  assert.deepEqual(
    plan.catalogUpdates,
    {
      schemaVersion: 1,
      packages: plan.packages.map((row) => ({
        platform: row.platform,
        arch: row.arch,
        version: row.version,
        manifestUrl: `https://raw.githubusercontent.com/${plan.repository}/main/${row.repoPath}`,
        manifestSha256: row.manifestSha256,
      })),
    },
    'Catalog plan differs from staged manifests',
  );
  return {
    plan,
    stageRoot,
    manifestRows,
    assets: [...assets.values()],
    sourceCommit: source.commit,
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    check(
      process.argv.length === 4,
      'Usage: node scripts/verify-npm-native-mirror-stage.mjs RELEASE_DIR STAGE_DIR',
    );
    const result = await verifyNpmNativeMirrorStage(process.argv[2], process.argv[3]);
    console.log(
      JSON.stringify({
        tag: result.plan.tag,
        sourceCommit: result.sourceCommit,
        packages: result.manifestRows.length,
        assets: result.assets.length,
        uploaded: false,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
