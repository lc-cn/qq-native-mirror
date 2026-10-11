import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNativePackage, resolveNativeCatalog } from '../src/native/native-catalog.ts';
const entry = (clientVersion: string, arch = 'x64') => ({
  platform: 'linux',
  arch,
  version: { clientVersion, appId: '1', qua: 'test' },
  manifestUrl: 'https://example.com/manifest.json',
  manifestSha256: 'a'.repeat(64),
});
test('catalog selects numeric latest only for the actual device and honors explicit version', () => {
  const catalog = {
    schemaVersion: 1 as const,
    packages: [entry('3.2.9-900'), entry('3.2.32-52194'), entry('9.0.0-1', 'arm64')],
  };
  assert.equal(selectNativePackage(catalog, 'linux', 'x64').version.clientVersion, '3.2.32-52194');
  assert.equal(
    selectNativePackage(catalog, 'linux', 'x64', entry('3.2.9-900').version).version.clientVersion,
    '3.2.9-900',
  );
  assert.throws(() => selectNativePackage(catalog, 'darwin', 'arm64'), /No native package/);
});
test('catalog rejects ambiguous versions and invalid package integrity', () => {
  assert.throws(
    () =>
      selectNativePackage(
        { schemaVersion: 1, packages: [entry('3.2.32-1'), entry('3.2.32-1')] },
        'linux',
        'x64',
      ),
    /Ambiguous/,
  );
  assert.throws(
    () =>
      selectNativePackage(
        { schemaVersion: 1, packages: [{ ...entry('3.2.32-1'), manifestSha256: 'bad' }] },
        'linux',
        'x64',
      ),
    /Invalid/,
  );
});

test('catalog stream stops and cancels at the size limit before parsing', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let cancelled = false,
    calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  };
  await assert.rejects(
    resolveNativeCatalog({
      dataDir: '/unused',
      catalogUrl: 'https://fixture.example/catalog.json',
    }),
    /too large/,
  );
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
  await assert.rejects(
    resolveNativeCatalog({
      dataDir: '/unused',
      catalogUrl: 'https://user:password@fixture.example/catalog.json',
    }),
    /without credentials/,
  );
  assert.equal(calls, 1);
});

test('catalog rejects malformed entries, metadata and unsafe version order', () => {
  for (const value of [
    null,
    { ...entry('1'), version: { clientVersion: '1', appId: 1, qua: 'fixture' } },
    entry('99999999999999999999'),
    { ...entry('1'), manifestUrl: 'https://user:password@example.com/manifest' },
  ]) {
    assert.throws(() =>
      selectNativePackage({ schemaVersion: 1, packages: [value] } as any, 'linux', 'x64'),
    );
  }
});

test('catalog resolution binds selected version while preserving explicit requested metadata', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const selected = { ...entry('2.0.0'), platform: process.platform, arch: process.arch };
  globalThis.fetch = async () => Response.json({ schemaVersion: 1, packages: [selected] });
  const options = { dataDir: '/unused' };
  assert.deepEqual((await resolveNativeCatalog(options)).version, selected.version);
  const requested = { ...selected.version, appId: 'caller-pinned-app' };
  assert.deepEqual(
    (await resolveNativeCatalog({ ...options, version: requested })).version,
    requested,
  );
});

test('rejected catalog HTTP body is released and cleanup failures retain the HTTP error', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const cleanup of [undefined, { opaque: 'cleanup failure' }]) {
    let cancellations = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancellations++;
            if (cleanup !== undefined) throw cleanup;
          },
        }),
        { status: 503 },
      );
    await assert.rejects(
      resolveNativeCatalog({
        dataDir: '/unused',
        catalogUrl: 'https://fixture.example/catalog.json',
      }),
      (error: unknown) => {
        if (cleanup === undefined) {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Native catalog unavailable: HTTP 503/);
        } else {
          assert.ok(error instanceof AggregateError);
          assert.match(error.errors[0].message, /Native catalog unavailable: HTTP 503/);
          assert.equal(error.errors[1], cleanup);
        }
        return true;
      },
    );
    assert.equal(cancellations, 1);
  }
});
