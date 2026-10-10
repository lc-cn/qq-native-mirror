import { readFile, lstat, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile),
  repository = 'lc-cn/qq-native-mirror';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const check = (ok, message) => {
  if (!ok) throw Error(message);
};
const safe = (p) =>
  typeof p === 'string' &&
  p &&
  !/[\\\0:\r\n]/.test(p) &&
  !p.startsWith('/') &&
  !p.split('/').some((v) => !v || v === '.' || v === '..');
async function runGh(args) {
  try {
    return (
      await execute('gh', args, {
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 600000,
      })
    ).stdout;
  } catch {
    throw Error(
      'GitHub command failed; creation may be uncertain. Stop and reconcile read-only; no automatic retry or release edit.',
    );
  }
}
/** Exact immutable release identity and asset binding, independent of transport. */
export function verifyUploadedMetadata(metadata, plan, assets) {
  check(
    metadata?.tag_name === plan.tag &&
      metadata.target_commitish === plan.sourceRelease.commit &&
      metadata.draft === false &&
      metadata.prerelease === true &&
      Number.isSafeInteger(metadata.id) &&
      metadata.id > 0,
    'Remote release identity mismatch',
  );
  check(
    Array.isArray(metadata.assets) && metadata.assets.length === assets.length,
    'Remote asset set mismatch',
  );
  const seen = new Set();
  for (const asset of assets) {
    check(!seen.has(asset.name), 'Duplicate upload asset');
    seen.add(asset.name);
    const matches = metadata.assets.filter((a) => a.name === asset.name);
    check(matches.length === 1, 'Missing or duplicate remote asset');
    const remote = matches[0];
    check(
      Number.isSafeInteger(remote.id) &&
        remote.id > 0 &&
        remote.size === asset.size &&
        remote.digest === `sha256:${asset.sha256}` &&
        remote.browser_download_url ===
          `https://github.com/${repository}/releases/download/${plan.tag}/${asset.name}`,
      'Remote asset digest/size/URL mismatch',
    );
  }
  return {
    schemaVersion: 1,
    repository,
    tag: plan.tag,
    releaseId: metadata.id,
    sourceRelease: plan.sourceRelease,
    assets: assets.map((a) => ({
      name: a.name,
      size: a.size,
      sha256: a.sha256,
      url: `https://github.com/${repository}/releases/download/${plan.tag}/${a.name}`,
    })),
    remoteMetadataVerified: true,
    smallAssetReadbackVerified: false,
    uploaded: true,
    catalogChanged: false,
    nativeExecuted: false,
  };
}
export function candidateMirrorCatalog(plan) {
  return {
    schemaVersion: 1,
    packages: plan.packages.map((p) => ({
      platform: p.platform,
      arch: p.arch,
      version: p.version,
      manifestUrl: `https://github.com/${repository}/releases/download/${plan.tag}/${p.platform}-${p.arch}.json`,
      manifestSha256: p.manifestSha256,
    })),
  };
}
/** Capture approved bytes once; the uploader never reopens mutable stage files. */
export async function captureUploadAsset(root, path, name, expected, snapshotDirectory) {
  check(safe(path) && /^[\w.-]+$/.test(name), 'Unsafe upload path');
  const base = await realpath(root),
    requested = join(base, path),
    actual = await realpath(requested);
  check(
    actual.startsWith(base + sep) && (await lstat(requested)).isFile(),
    'Upload must use contained regular files',
  );
  const bytes = await readFile(actual);
  check(
    expected &&
      sha(bytes) === expected.sha256 &&
      (expected.size === undefined || bytes.length === expected.size),
    'Upload bytes changed after stage verification',
  );
  let captured = actual;
  if (snapshotDirectory !== undefined) {
    check((await lstat(snapshotDirectory)).isDirectory(), 'Snapshot must be a regular directory');
    const directory = await realpath(snapshotDirectory);
    check(
      directory !== base && !directory.startsWith(base + sep),
      'Snapshot must be outside stage',
    );
    captured = join(directory, name);
    await writeFile(captured, bytes, { flag: 'wx', mode: 0o600 });
  }
  return { name, size: bytes.length, sha256: expected.sha256, path: captured };
}
export async function uploadNpmNativeMirror(
  releaseDir,
  stageDir,
  { upload = false, run = runGh } = {},
) {
  const { verifyNpmNativeMirrorStage } = await import('./verify-npm-native-mirror-stage.mjs');
  const verified = await verifyNpmNativeMirrorStage(releaseDir, stageDir);
  const root = await realpath(resolve(stageDir)),
    planBytes = await readFile(join(root, 'mirror-plan.json')),
    plan = JSON.parse(planBytes);
  check(
    JSON.stringify(plan) === JSON.stringify(verified.plan),
    'Plan changed after stage verification',
  );
  check(
    plan.repository === repository &&
      /^native-npm-v[\w.-]+-ci-\d+-attempt-\d+$/.test(plan.tag) &&
      /^[a-f0-9]{40}$/.test(plan.sourceRelease?.commit),
    'Invalid verified upload identity',
  );
  const temporary = upload ? await mkdtemp(join(tmpdir(), 'qq-mirror-upload-')) : undefined;
  try {
    const assets = [];
    async function add(path, name, expected) {
      check(!assets.some((a) => a.name === name), 'Duplicate upload asset');
      assets.push(await captureUploadAsset(root, path, name, expected, temporary));
    }
    for (const asset of plan.assets) await add('assets/' + asset.name, asset.name, asset);
    for (const pkg of plan.packages)
      await add(pkg.manifestPath, `${pkg.platform}-${pkg.arch}.json`, {
        sha256: pkg.manifestSha256,
      });
    await add('mirror-plan.json', 'mirror-plan.json', {
      size: planBytes.length,
      sha256: sha(planBytes),
    });
    const catalogBytes = Buffer.from(JSON.stringify(candidateMirrorCatalog(plan), null, 2) + '\n');
    const catalog = {
      name: 'catalog-candidate.json',
      size: catalogBytes.length,
      sha256: sha(catalogBytes),
    };
    if (upload) {
      catalog.path = join(temporary, catalog.name);
      await writeFile(catalog.path, catalogBytes, { flag: 'wx', mode: 0o600 });
    }
    assets.push(catalog);
    if (!upload)
      return {
        schemaVersion: 1,
        dryRun: true,
        repository,
        tag: plan.tag,
        sourceRelease: plan.sourceRelease,
        assets: assets.map(({ path, ...a }) => a),
        uploaded: false,
        catalogChanged: false,
        nativeExecuted: false,
      };
    // One mutation attempt. A failure never triggers a retry, clobber or edit.
    await run([
      'release',
      'create',
      plan.tag,
      ...assets.map((a) => a.path),
      '--repo',
      repository,
      '--target',
      plan.sourceRelease.commit,
      '--prerelease',
      '--latest=false',
      '--title',
      plan.tag,
      '--notes',
      'Immutable verified codec-bearing native mirror candidate. No catalog update or npm publication.',
    ]);
    const metadata = JSON.parse(
      (await run(['api', `repos/${repository}/releases/tags/${plan.tag}`])).toString(),
    );
    check(Number.isSafeInteger(metadata.id) && metadata.id > 0, 'Invalid remote release ID');
    const pages = JSON.parse(
      (
        await run([
          'api',
          `repos/${repository}/releases/${metadata.id}/assets?per_page=100`,
          '--paginate',
          '--slurp',
        ])
      ).toString(),
    );
    check(Array.isArray(pages) && pages.every(Array.isArray), 'Invalid paginated asset inventory');
    metadata.assets = pages.flat();
    const receipt = verifyUploadedMetadata(metadata, plan, assets);
    for (const asset of assets.filter(
      (a) =>
        a.name === 'mirror-plan.json' ||
        a.name === 'catalog-candidate.json' ||
        plan.packages.some((p) => a.name === `${p.platform}-${p.arch}.json`),
    )) {
      const remote = metadata.assets.find((a) => a.name === asset.name);
      const bytes = await run([
        'api',
        `repos/${repository}/releases/assets/${remote.id}`,
        '-H',
        'Accept: application/octet-stream',
      ]);
      check(
        Buffer.byteLength(bytes) === asset.size && sha(bytes) === asset.sha256,
        'Remote small asset readback mismatch',
      );
    }
    receipt.smallAssetReadbackVerified = true;
    receipt.candidateCatalogUrl = `https://github.com/${repository}/releases/download/${plan.tag}/catalog-candidate.json`;
    return receipt;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  check(
    args.length === 2 || (args.length === 3 && args[2] === '--upload'),
    'Usage: node scripts/upload-npm-native-mirror.mjs RELEASE_DIR STAGE_DIR [--upload]',
  );
  console.log(
    JSON.stringify(
      await uploadNpmNativeMirror(args[0], args[1], { upload: args[2] === '--upload' }),
      null,
      2,
    ),
  );
}
