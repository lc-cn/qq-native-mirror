import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openMirrorSelection } from './mirror-selection.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const old = '3.2.31-51102',
  current = '3.2.32-52194';
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-selection-'));
  try {
    const manifest = {
      schemaVersion: 1,
      id: 'fixture',
      platform: 'linux',
      arch: 'x64',
      wrapper: 'wrapper.node',
      version: { clientVersion: old, appId: '1', qua: 'fixture' },
      files: ['wrapper.node', 'registration-bridge.node'].map((path) => ({
        path,
        url: `https://example.test/${path}`,
        sha256: 'a'.repeat(64),
        size: 1,
        encoding: 'gzip',
        downloadSha256: 'b'.repeat(64),
      })),
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const selected = {
      platform: 'linux',
      arch: 'x64',
      version: { ...manifest.version },
      manifestUrl: 'https://example.test/manifest.json',
      manifestSha256: sha(bytes),
    };
    const catalog = {
      schemaVersion: 1,
      packages: [
        selected,
        { ...selected, version: { ...selected.version, clientVersion: current } },
      ],
    };
    const catalogFile = join(dir, 'catalog.json'),
      manifestFile = join(dir, 'manifest.json');
    const save = async () => {
      await writeFile(catalogFile, JSON.stringify(catalog));
      await writeFile(manifestFile, JSON.stringify(manifest));
    };
    await save();
    await run({
      catalog,
      manifest,
      selected,
      save,
      catalogFile,
      manifestFile,
      base: { catalogFile, platform: 'linux', arch: 'x64', targetVersion: old },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test('public selection pins legacy metadata and leaves current SDK defaults untouched', () =>
  fixture(async ({ base, selected }) => {
    const legacy = await openMirrorSelection({ ...base, mode: 'public-default' });
    assert.deepEqual(legacy.options, { version: selected.version });
    assert.equal(legacy.automaticLatest, false);
    await legacy.close();
    const latest = await openMirrorSelection({
      ...base,
      targetVersion: current,
      mode: 'public-default',
    });
    assert.deepEqual(latest.options, {});
    assert.equal(latest.automaticLatest, true);
    await latest.close();
  }));
test('candidate serves exactly original pinned bytes on real loopback and closes idempotently', () =>
  fixture(async ({ base, manifestFile, selected, manifest }) => {
    const selection = await openMirrorSelection({
      ...base,
      manifestFile,
      mode: 'legacy-bridge-candidate',
    });
    try {
      assert.deepEqual(Object.keys(selection.options).sort(), ['manifestSha256', 'manifestUrl']);
      assert.equal(selection.selected.manifestUrl, selected.manifestUrl);
      assert.equal(selection.automaticLatest, false);
      const response = await fetch(selection.options.manifestUrl);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(sha(bytes), selected.manifestSha256);
      assert.deepEqual(JSON.parse(bytes), manifest);
      assert.equal((await fetch(selection.options.manifestUrl, { method: 'POST' })).status, 404);
      assert.equal(
        (await fetch(selection.options.manifestUrl.replace('/manifest.json', '/wrapper.node')))
          .status,
        404,
      );
    } finally {
      const first = selection.close();
      assert.equal(selection.close(), first);
      await first;
    }
    await assert.rejects(fetch(selection.options.manifestUrl));
  }));
test('candidate denies other versions, missing source and public overrides', () =>
  fixture(async ({ base, manifestFile }) => {
    for (const options of [
      { ...base, manifestFile, targetVersion: current, mode: 'legacy-bridge-candidate' },
      { ...base, mode: 'legacy-bridge-candidate' },
      { ...base, manifestFile, mode: 'public-default' },
      { ...base, mode: 'other' },
      { ...base, targetVersion: 'latest', mode: 'public-default' },
    ])
      await assert.rejects(openMirrorSelection(options));
  }));
test('catalog rejects duplicates and malformed trusted selection metadata', () =>
  fixture(async ({ base, catalog, save }) => {
    const original = structuredClone(catalog);
    for (const mutate of [
      (value) => value.packages.push({ ...value.packages[0] }),
      (value) => (value.packages[0].manifestUrl = 'http://example.test/a'),
      (value) => (value.packages[0].manifestUrl = 'https://user:secret@example.test/a'),
      (value) => (value.packages[0].manifestSha256 = 'wrong'),
      (value) => (value.packages[0].version.appId = ''),
      (value) => (value.packages[0].version.clientVersion = 42),
    ]) {
      Object.assign(catalog, structuredClone(original));
      mutate(catalog);
      await save();
      await assert.rejects(openMirrorSelection({ ...base, mode: 'public-default' }));
    }
  }));
test('candidate validates byte trust root and complete device/version/inventory', () =>
  fixture(async ({ base, manifest, selected, save, manifestFile }) => {
    const original = structuredClone(manifest);
    for (const [index, mutate] of [
      (value) => (value.platform = 'darwin'),
      (value) => (value.arch = 'arm64'),
      (value) => (value.version.qua = 'changed'),
      (value) => value.files.pop(),
      (value) => value.files.push({ ...value.files[0] }),
      (value) => (value.files[0].path = '../wrapper.node'),
      (value) => (value.files[0].url = 'http://example.test/a'),
      (value) => (value.files[0].sha256 = 'wrong'),
      (value) => (value.files[0].downloadSha256 = 'wrong'),
      (value) => (value.files[0].path = 'registration-bridge.node/a'),
    ].entries()) {
      Object.assign(manifest, structuredClone(original));
      mutate(manifest);
      selected.manifestSha256 = sha(Buffer.from(JSON.stringify(manifest)));
      await save();
      await assert.rejects(
        openMirrorSelection({ ...base, manifestFile, mode: 'legacy-bridge-candidate' }),
        undefined,
        `mutation ${index}`,
      );
    }
    Object.assign(manifest, original);
    selected.manifestSha256 = '0'.repeat(64);
    await save();
    await assert.rejects(
      openMirrorSelection({ ...base, manifestFile, mode: 'legacy-bridge-candidate' }),
      /digest mismatch/,
    );
  }));

// Read the actual pinned inventory, not synthetic manifests or live endpoints.
const repository = new URL('../', import.meta.url);
async function sourceManifest(row) {
  const url = new URL(row.manifestUrl);
  assert.equal(url.origin, 'https://raw.githubusercontent.com');
  assert.ok(url.pathname.startsWith('/lc-cn/qq-native-mirror/main/packages/'));
  const path = url.pathname.slice('/lc-cn/qq-native-mirror/main/'.length);
  const bytes = await readFile(new URL(path, repository));
  assert.equal(sha(bytes), row.manifestSha256);
  return JSON.parse(bytes.toString('utf8'));
}

test('every default catalog target includes its matching-device registration bridge', async () => {
  const catalog = JSON.parse(await readFile(new URL('catalog.json', repository), 'utf8'));
  const reviewed = JSON.parse(
    await readFile(new URL('catalog-linux-legacy-bridge-v1.json', repository), 'utf8'),
  );
  // Only the repaired legacy rows are tied to this reviewed candidate.
  const legacyRows = catalog.packages.filter(
    (row) => row.platform === 'linux' && row.version.clientVersion === old,
  );
  assert.deepEqual(legacyRows.map((row) => row.arch).sort(), ['arm64', 'x64']);
  for (const row of legacyRows) {
    const candidate = reviewed.packages.find(
      (value) =>
        value.platform === 'linux' &&
        value.arch === row.arch &&
        value.version.clientVersion === old,
    );
    assert.deepEqual(row, candidate);
  }
  for (const row of catalog.packages) {
    const manifest = await sourceManifest(row);
    assert.equal(manifest.platform, row.platform);
    assert.equal(manifest.arch, row.arch);
    assert.deepEqual(manifest.version, row.version);
    const bridge = row.platform === 'win32' ? 'QQNT.dll' : 'registration-bridge.node';
    const file = manifest.files.find((value) => value.path === bridge);
    assert.ok(file, `${row.platform}/${row.arch}/${row.version.clientVersion} lacks ${bridge}`);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.size) && file.size > 0);
  }
});

test('legacy default manifests add only a bridge while retaining the original native inventory and version', async () => {
  const catalog = JSON.parse(await readFile(new URL('catalog.json', repository), 'utf8'));
  const originalPaths = {
    arm64:
      'packages/3.2.31-51102-linux-arm64/25e3e4fbf046d7acb45f2569f2f4e2c5b374142f0575d52d5c962fdbc8c718fa/manifest.json',
    x64: 'packages/3.2.31-51102-linux-x64/7f13f72b7cb5b86583cbf97f08bd3e61ba2b6b288250720d9db393e634bb62eb/manifest.json',
  };
  for (const [arch, path] of Object.entries(originalPaths)) {
    const originalBytes = await readFile(new URL(path, repository));
    assert.equal(sha(originalBytes), path.split('/')[2]);
    const original = JSON.parse(originalBytes.toString('utf8'));
    const row = catalog.packages.find(
      (value) =>
        value.platform === 'linux' && value.arch === arch && value.version.clientVersion === old,
    );
    assert.ok(row);
    const selected = await sourceManifest(row);
    const bridge = selected.files.filter((file) => file.path === 'registration-bridge.node');
    assert.equal(bridge.length, 1);
    assert.deepEqual(
      selected.files.filter((file) => file.path !== 'registration-bridge.node'),
      original.files,
    );
    assert.deepEqual(selected.version, original.version);
    assert.equal(selected.wrapper, original.wrapper);
    assert.equal(selected.platform, original.platform);
    assert.equal(selected.arch, original.arch);
  }
});
