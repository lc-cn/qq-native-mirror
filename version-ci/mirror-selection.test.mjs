import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
