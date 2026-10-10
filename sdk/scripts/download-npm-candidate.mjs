import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { validateRelease, firstMainEvidencePaths } from './local-first-publish.mjs';
const repository = 'lc-cn/qq-native-mirror';
const targets = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function check(value, message) {
  if (!value) throw new Error(message);
}
function api(path) {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  check(result.status === 0, 'GitHub metadata lookup failed');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Invalid GitHub metadata');
  }
}
export function extractEvidence(compressed, includeFirstMain = false) {
  const tar = gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 });
  const allowed = new Set([
    ...targets.map((target) => `evidence/${target}.consumer.json`),
    'evidence/aggregated-main.consumer.json',
    ...(includeFirstMain ? firstMainEvidencePaths : []),
  ]);
  const files = new Map();
  let offset = 0;
  let directorySeen = false;
  for (; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const expectedChecksum = Number.parseInt(field(148, 8).trim(), 8);
    const checksum = [...header].reduce(
      (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
      0,
    );
    check(checksum === expectedChecksum, 'Evidence tar checksum mismatch');
    const sizeText = field(124, 12).trim();
    check(/^[0-7]+$/.test(sizeText), 'Invalid evidence tar size');
    const size = Number.parseInt(sizeText, 8);
    check(size <= 1024 * 1024 && offset + size <= tar.length, 'Evidence entry too large/truncated');
    if (header[156] === 53) {
      check(
        !prefix && name === 'evidence/' && size === 0 && !directorySeen,
        'Unexpected evidence directory entry',
      );
      directorySeen = true;
      continue;
    }
    check(
      !prefix && allowed.has(name) && !files.has(name) && (header[156] === 0 || header[156] === 48),
      'Unexpected evidence tar entry/type',
    );
    const bytes = Buffer.from(tar.subarray(offset, offset + size));
    JSON.parse(bytes);
    files.set(name, bytes);
    offset += Math.ceil(size / 512) * 512;
  }
  check(
    files.size === allowed.size && tar.subarray(offset).every((byte) => byte === 0),
    'Incomplete/trailing evidence tar entries',
  );
  return files;
}
export async function downloadCandidate(
  tag,
  directory,
  { proxy, getMetadata = api, fetchImpl = fetch } = {},
) {
  const match = /^npm-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-ci-(\d+)$/.exec(tag);
  check(match, 'Invalid candidate tag');
  const [, version, runId] = match;
  let proxyUrl;
  if (proxy) {
    proxyUrl = new URL(proxy);
    check(
      proxyUrl.protocol === 'https:' &&
        !proxyUrl.username &&
        !proxyUrl.password &&
        !proxyUrl.search &&
        !proxyUrl.hash,
      'Proxy must be a plain HTTPS base URL',
    );
  }
  const release = await getMetadata(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  const run = await getMetadata(`repos/${repository}/actions/runs/${runId}`);
  check(
    release.tag_name === tag && release.prerelease === true && release.draft === false,
    'Not the expected published candidate',
  );
  check(
    String(run.id) === runId &&
      run.repository?.full_name === repository &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      ['.github/workflows/native-npm.yml', '.github/workflows/native-first-main.yml'].includes(
        run.path,
      ),
    'Candidate CI did not succeed in expected workflow',
  );
  check(
    /^[a-f0-9]{40}$/.test(run.head_sha) && release.target_commitish === run.head_sha,
    'Release commit differs from CI',
  );
  const baseAssets = [
    'release-manifest.json',
    'acceptance-evidence.tar.gz',
    ...targets.map((target) => `qq-native-client-${target}-${version}.tgz`),
    `qq-native-client-${version}.tgz`,
  ];
  const materialAssets = ['video-materials-binding.json', 'video-materials.json'];
  check(Array.isArray(release.assets), 'Unexpected candidate asset list');
  const includesMaterials = materialAssets.some((name) =>
    release.assets.some((asset) => asset.name === name),
  );
  const expected = [...baseAssets, ...(includesMaterials ? materialAssets : [])];
  check(
    Array.isArray(release.assets) && release.assets.length === expected.length,
    'Unexpected candidate asset count',
  );
  const assets = expected.map((name) => {
    const matches = release.assets.filter((asset) => asset.name === name);
    check(matches.length === 1, 'Missing/duplicate candidate asset');
    const asset = matches[0];
    check(
      /^sha256:[a-f0-9]{64}$/.test(asset.digest) &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= 1024 * 1024 * 1024,
      'Missing digest/invalid asset size',
    );
    const url = new URL(asset.browser_download_url);
    check(
      url.protocol === 'https:' &&
        url.hostname === 'github.com' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === `/${repository}/releases/download/${tag}/${name}`,
      'Unexpected public asset URL',
    );
    return { ...asset, expectedHash: asset.digest.slice(7) };
  });
  await mkdir(resolve(directory), { recursive: true });
  const root = await realpath(resolve(directory));
  const identity = JSON.stringify({ repository, tag, runId, commit: run.head_sha });
  const identityFile = join(root, '.candidate-identity.json');
  try {
    check(
      (await readFile(identityFile, 'utf8')) === identity,
      'Directory belongs to another candidate',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(identityFile, identity, { flag: 'wx' });
  }
  async function download(asset) {
    const destination = join(root, asset.name);
    try {
      check(
        (await lstat(destination)).isFile() && !(await lstat(destination)).isSymbolicLink(),
        'Asset cache must be a regular file',
      );
      const existing = await readFile(destination);
      if (existing.length === asset.size && sha(existing) === asset.expectedHash) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = join(root, `.${asset.name}.${randomUUID()}.tmp`);
    try {
      const url = proxyUrl
        ? proxyUrl.href.replace(/\/?$/, '/') + asset.browser_download_url
        : asset.browser_download_url;
      let response;
      let currentUrl = url;
      const signal = AbortSignal.timeout(120_000);
      try {
        for (let redirects = 0; ; redirects++) {
          response = await fetchImpl(currentUrl, { signal, redirect: 'manual' });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          check(location && redirects < 5, 'Candidate asset redirect failed');
          const next = new URL(location, currentUrl);
          check(
            next.protocol === 'https:' && !next.username && !next.password,
            'Candidate asset redirect failed',
          );
          await response.body?.cancel();
          currentUrl = next.href;
        }
      } catch {
        throw new Error('Candidate asset download failed');
      }
      check(response.ok && response.body, 'Candidate asset download failed');
      const { open } = await import('node:fs/promises');
      const file = await open(temporary, 'wx');
      let size = 0;
      const digest = createHash('sha256');
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          check(size <= asset.size, 'Candidate asset exceeded declared size');
          digest.update(chunk);
          await file.writeFile(chunk);
        }
      } finally {
        await file.close();
      }
      check(
        size === asset.size && digest.digest('hex') === asset.expectedHash,
        'Candidate asset checksum/size mismatch',
      );
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  // One manifest first; bind its provenance before downloading large bundles.
  await download(assets[0]);
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json')));
  check(
    manifest.repository === repository &&
      manifest.version === version &&
      manifest.runId === runId &&
      manifest.commit === run.head_sha &&
      manifest.runAttempt === run.run_attempt,
    'Manifest CI provenance mismatch',
  );
  check(
    (manifest.videoMaterials !== undefined) === includesMaterials,
    'Candidate video material assets/declaration mismatch',
  );
  const includeFirstMain = run.path === '.github/workflows/native-first-main.yml';
  if (includeFirstMain) {
    check(
      Array.isArray(manifest.acceptanceEvidence) &&
        manifest.acceptanceEvidence.length === firstMainEvidencePaths.length &&
        firstMainEvidencePaths.every(
          (path) =>
            manifest.acceptanceEvidence.filter(
              (item) => item.path === path && /^[a-f0-9]{64}$/.test(item.sha256),
            ).length === 1,
        ) &&
        Array.isArray(manifest.auxiliarySources) &&
        manifest.auxiliarySources.length === 6 &&
        targets.every(
          (target) =>
            manifest.auxiliarySources.filter((item) => item.target === target).length === 1,
        ),
      'Candidate first-main evidence declaration missing/incomplete',
    );
  } else
    check(
      manifest.acceptanceEvidence === undefined && manifest.auxiliarySources === undefined,
      'Candidate extended evidence requires first-main workflow',
    );
  const queue = assets.slice(1);
  let failure;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (!failure && queue.length) {
        const asset = queue.shift();
        try {
          await download(asset);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure) throw failure;
  const evidence = extractEvidence(
    await readFile(join(root, 'acceptance-evidence.tar.gz')),
    includeFirstMain,
  );
  await mkdir(join(root, 'evidence'), { recursive: true });
  check(
    !(await lstat(join(root, 'evidence'))).isSymbolicLink(),
    'Evidence directory must not be a symlink',
  );
  for (const [name, bytes] of evidence) {
    const temporary = join(root, 'evidence', `.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, join(root, name));
  }
  if (includesMaterials) {
    const materials = join(root, 'video-materials');
    await mkdir(materials, { recursive: true });
    check(
      (await lstat(materials)).isDirectory() && !(await lstat(materials)).isSymbolicLink(),
      'Video materials directory must be a regular directory',
    );
    for (const name of materialAssets) {
      const temporary = join(materials, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, await readFile(join(root, name)), { flag: 'wx' });
        await rename(temporary, join(materials, name));
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
  }
  await validateRelease(root);
  return { directory: root, tag, runId, commit: run.head_sha, validated: true };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [tag, directory, option, ...rest] = process.argv.slice(2);
    check(
      tag && directory && !rest.length && (!option || option.startsWith('--proxy=')),
      'Usage: node scripts/download-npm-candidate.mjs TAG DIRECTORY [--proxy=https://gh-proxy.com/]',
    );
    console.log(
      JSON.stringify(await downloadCandidate(tag, directory, { proxy: option?.slice(8) })),
    );
  } catch (error) {
    console.error(
      error.message.startsWith('Candidate') ||
        error.message.startsWith('Invalid') ||
        error.message.startsWith('Unexpected')
        ? error.message
        : 'Candidate validation failed; no publish performed.',
    );
    process.exitCode = 1;
  }
}
