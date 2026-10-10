import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { verifyMirrorConsumer } from '../scripts/mirror-consumer-contract.mjs';
import type { NativeManifest } from '../src/contracts/native.ts';
import type { ClientOptions } from '../src/contracts/client.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(
  mode:
    'good' | 'warm-download' | 'account' | 'close-failure' | 'bad-cache' | 'bad-catalog' = 'good',
) {
  const payload = Buffer.from('controlled native payload; not executable');
  const manifest: NativeManifest = {
    schemaVersion: 1,
    id: 'fixture',
    platform: process.platform,
    arch: process.arch,
    version: { clientVersion: '1.2.3-4', appId: '123', qua: 'fixture' },
    wrapper: 'wrapper.node',
    files: [{ path: 'wrapper.node', sha256: sha(payload), url: 'https://example.test/payload' }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const selected = {
    platform: process.platform,
    arch: process.arch,
    version: manifest.version,
    manifestSha256: sha(manifestBytes),
    manifestUrl: 'https://example.test/manifest.json',
  };
  const catalogBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, packages: [selected] }));
  const network: string[] = [];
  const options: ClientOptions[] = [];
  const closed: number[] = [];
  let codecs = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    network.push(url);
    if (url.endsWith('/catalog.json'))
      return new Response(mode === 'bad-catalog' ? Buffer.from('{}') : catalogBytes);
    if (url === selected.manifestUrl) return new Response(manifestBytes);
    assert.equal(url, manifest.files[0]!.url);
    return new Response(payload);
  };
  async function createClient(value: ClientOptions) {
    const phase = options.length;
    options.push(value);
    assert.equal(value.version, undefined);
    assert.equal(value.wrapperPath, undefined);
    assert.equal(value.manifestUrl, undefined);
    assert.equal(value.catalogUrl, undefined);
    await (
      await fetch('https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog.json')
    ).arrayBuffer();
    await (await fetch(selected.manifestUrl)).arrayBuffer();
    if (phase === 0 || mode === 'warm-download') {
      const bytes = Buffer.from(await (await fetch(manifest.files[0]!.url)).arrayBuffer());
      const target = join(value.cacheDir!, selected.manifestSha256);
      await mkdir(target, { recursive: true });
      await writeFile(
        join(target, 'wrapper.node'),
        mode === 'bad-cache' ? Buffer.from('corrupt') : bytes,
      );
    }
    let state: 'idle' | 'closed' = 'idle';
    return {
      nativeExports: Array.from({ length: 80 }, (_, i) => String(i)),
      account: mode === 'account' ? { uin: '123', uid: 'u_fixture' } : undefined,
      get state() {
        return state;
      },
      async close() {
        closed.push(phase);
        if (mode === 'close-failure') throw new Error('controlled close failure');
        state = 'closed';
      },
    };
  }
  return {
    context: {
      createClient,
      fetchImpl,
      selected,
      catalogSha256: sha(catalogBytes),
      verifyCodec: async (value: ClientOptions) => {
        assert.equal(closed.length, 1, 'Codec must follow actual worker retirement');
        assert.equal(value.cacheDir, options[0]!.cacheDir);
        codecs++;
      },
    },
    options,
    network,
    closed,
    codecs: () => codecs,
  };
}

test('default mirror owner proves cold bytes, independent cache hashes and warm reuse through the public factory', async () => {
  const f = fixture(),
    originalFetch = globalThis.fetch;
  const receipt = await verifyMirrorConsumer(f.context);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.automaticLatest, true);
  assert.equal(receipt.verifiedFiles, 1);
  assert.equal(receipt.first.payloadRequests, 1);
  assert.equal(receipt.second.payloadRequests, 0);
  assert.equal(receipt.second.payloadBytes, 0);
  assert.equal(receipt.loginAttempted, false);
  assert.equal(receipt.nativeSendAttempted, false);
  assert.equal(receipt.codecVerified, true);
  assert.equal(f.codecs(), 1);
  assert.equal(f.options.length, 2);
  assert.deepEqual(f.closed, [0, 1]);
  assert.notEqual(f.options[0]!.dataDir, f.options[1]!.dataDir);
  assert.equal(f.options[0]!.cacheDir, f.options[1]!.cacheDir);
  assert.equal(globalThis.fetch, originalFetch);
  await assert.rejects(access(f.options[0]!.cacheDir!), { code: 'ENOENT' });
});

test('CRLF checkout digest rejects raw LF before payload; exact Git blob digest passes cold and warm verification', async () => {
  const bad = fixture();
  const bytes = Buffer.from(
    JSON.stringify({ schemaVersion: 1, packages: [bad.context.selected] }, null, 2) + '\n',
  );
  const originalBad = bad.context.fetchImpl;
  bad.context.fetchImpl = async (input, init) =>
    String(input).endsWith('/catalog.json') ? new Response(bytes) : originalBad(input, init);
  bad.context.catalogSha256 = sha(Buffer.from(bytes.toString().replaceAll('\n', '\r\n')));
  await assert.rejects(verifyMirrorConsumer(bad.context), { code: 'ERR_ASSERTION' });
  assert.equal(bad.options.length, 1);
  assert.deepEqual(bad.closed, []);
  assert.equal(bad.network.length, 0, 'Digest mismatch stops before manifest and payload fetch');
  const good = fixture(),
    originalGood = good.context.fetchImpl;
  good.context.fetchImpl = async (input, init) =>
    String(input).endsWith('/catalog.json') ? new Response(bytes) : originalGood(input, init);
  good.context.catalogSha256 = sha(bytes);
  assert.equal((await verifyMirrorConsumer(good.context)).completed, true);
  assert.deepEqual(good.closed, [0, 1]);
});

for (const mode of [
  'warm-download',
  'account',
  'close-failure',
  'bad-cache',
  'bad-catalog',
] as const) {
  test(`mirror owner rejects ${mode}, restores fetch and retires its temporary files`, async () => {
    const f = fixture(mode),
      originalFetch = globalThis.fetch;
    await assert.rejects(verifyMirrorConsumer(f.context));
    assert.equal(globalThis.fetch, originalFetch);
    assert.ok(f.options.length >= 1);
    await assert.rejects(access(f.options[0]!.cacheDir!), { code: 'ENOENT' });
    if (mode === 'account') assert.deepEqual(f.closed, [0]);
    if (mode === 'close-failure') assert.deepEqual(f.closed, [0]);
    if (mode === 'bad-catalog') assert.equal(f.network.length, 1);
    if (mode === 'warm-download')
      assert.equal(f.network.filter((url) => url.endsWith('/payload')).length, 1);
  });
}
