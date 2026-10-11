import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** @typedef {Pick<import('../../src/index.ts').QQClient, 'close'|'state'|'account'|'nativeExports'>} MirrorClient */
/** @typedef {import('../../src/contracts/client.ts').ClientOptions} ClientOptions */
/** @typedef {import('../../src/native/native-catalog.ts').NativeCatalog['packages'][number]} CatalogEntry */
/** @typedef {{requests:number, payloadRequests:number, bytes:number, payloadBytes:number}} TransferCounts */
const hash = (/** @type {Uint8Array} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const catalogUrl = 'https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog.json';

/** Exercise the public factory with no wrapper, version, manifest or catalog override.
 * The caller supplies its independently bound expected catalog entry. This owner
 * checks actual network bytes and installed files, then retires both workers.
 * Run in a dedicated consumer process: fetch observation is process-wide.
 * @param {{
 * createClient:(options:ClientOptions)=>Promise<MirrorClient>,
 * selected:CatalogEntry,
 * catalogSha256:string,
 * downloadMirrors?:string[],
 * fetchImpl?:typeof fetch,
 * verifyCodec?:(options:ClientOptions)=>Promise<void>,
 * installedStorage?:{manifestSha256:string,objects:number}
 * }} context
 */
export async function verifyMirrorConsumer(context) {
  const { createClient, verifyCodec, fetchImpl: suppliedFetch } = context;
  const selected = structuredClone(context.selected);
  const catalogSha256 = context.catalogSha256;
  const downloadMirrors = [...(context.downloadMirrors ?? ['https://gh-proxy.com/'])];
  const installedStorage = context.installedStorage ? { ...context.installedStorage } : undefined;
  if (installedStorage) {
    assert.match(installedStorage.manifestSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(installedStorage.objects) && installedStorage.objects > 0);
  }
  assert.equal(selected.platform, process.platform);
  assert.equal(selected.arch, process.arch);
  assert.match(selected.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(catalogSha256, /^[a-f0-9]{64}$/);
  const originalFetch = globalThis.fetch;
  const fetchImpl = suppliedFetch ?? originalFetch;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-current-mirror-')));
  const cacheDir = join(root, 'cache');
  /** @type {import('../../src/contracts/native.ts').NativeManifest|undefined} */
  let manifest;
  /** @type {MirrorClient|undefined} */
  let client;
  let phase = 0;
  /** @type {[TransferCounts, TransferCounts]} */
  const counts = [
    { requests: 0, payloadRequests: 0, bytes: 0, payloadBytes: 0 },
    { requests: 0, payloadRequests: 0, bytes: 0, payloadBytes: 0 },
  ];
  let nativeExports = 0;
  let codecVerified = false;
  const metadataReads = [
    { catalog: 0, manifest: 0 },
    { catalog: 0, manifest: 0 },
  ];
  /** @type {Map<string,number>} */
  const coldMtimes = new Map();
  let verifiedFiles = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.equal(new URL(url).protocol, 'https:');
      const metadata = url === catalogUrl || url === selected.manifestUrl;
      const stats = counts[phase];
      assert.ok(stats, 'Unexpected consumer phase');
      stats.requests++;
      if (!metadata) {
        stats.payloadRequests++;
        assert.ok(!installedStorage, 'Installed storage attempted native payload download');
        assert.equal(phase, 0, 'Warm cache attempted native payload download');
      }
      const response = await fetchImpl(input, init);
      if (!response.body) return response;
      if (metadata && response.ok) {
        const reads = metadataReads[phase];
        assert.ok(reads);
        if (url === catalogUrl) reads.catalog++;
        else reads.manifest++;
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          assert.ok(size <= 1024 * 1024, 'Mirror metadata exceeds bound');
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        stats.bytes += bytes.length;
        assert.equal(hash(bytes), url === catalogUrl ? catalogSha256 : selected.manifestSha256);
        if (url === selected.manifestUrl) {
          const value = /** @type {import('../../src/contracts/native.ts').NativeManifest} */ (
            JSON.parse(bytes.toString('utf8'))
          );
          assert.equal(value.platform, process.platform);
          assert.equal(value.arch, process.arch);
          assert.deepEqual(value.version, selected.version);
          manifest = value;
        }
        return new Response(bytes, { status: response.status, headers: response.headers });
      }
      const reader = response.body.getReader();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const result = await reader.read();
              if (result.done) {
                controller.close();
                return;
              }
              stats.bytes += result.value.length;
              if (!metadata) stats.payloadBytes += result.value.length;
              controller.enqueue(result.value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        }),
        { status: response.status, headers: response.headers },
      );
    };
    for (phase = 0; phase < 2; phase++) {
      /** @type {ClientOptions} */
      const options = {
        cacheDir,
        dataDir: join(root, `empty-account-${phase}`),
        downloadMirrors: [...downloadMirrors],
        autoReconnect: false,
        timeoutMs: 120000,
      };
      client = await createClient(options);
      assert.equal(client.account, undefined, 'Preparation unexpectedly authenticated an account');
      assert.ok(client.nativeExports.length >= 80, 'Native exports are incomplete');
      nativeExports = client.nativeExports.length;
      const retiring = client;
      client = undefined;
      await retiring.close();
      assert.equal(retiring.state, 'closed');
      assert.ok(
        metadataReads[phase]?.catalog && metadataReads[phase]?.manifest,
        'Each phase must read catalog and manifest metadata',
      );
      assert.ok(manifest, 'Default selection did not fetch its manifest');
      const target = await realpath(
        join(
          cacheDir,
          installedStorage ? `npm-${installedStorage.manifestSha256}` : selected.manifestSha256,
        ),
      );
      assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
      for (const file of manifest.files) {
        assert.ok(typeof file.path === 'string' && !file.path.split(/[\\/]/).includes('..'));
        const path = join(target, file.path);
        assert.ok((await realpath(path)).startsWith(target + sep));
        const stat = await lstat(path);
        assert.ok(stat.isFile(), 'Native cache entry must be a regular file');
        assert.equal(hash(await readFile(path)), file.sha256.toLowerCase());
        if (phase === 0) coldMtimes.set(file.path, stat.mtimeMs);
        else
          assert.equal(stat.mtimeMs, coldMtimes.get(file.path), 'Warm cache rewrote native file');
      }
      verifiedFiles = manifest.files.length;
      // The factory already exercised the empty cache. Codec discovery follows
      // its worker retirement and shares that cache; it cannot stand in for login.
      if (phase === 0 && verifyCodec) {
        await verifyCodec(options);
        codecVerified = true;
      }
    }
    assert.ok(manifest, 'Default selection did not fetch its manifest');
    if (installedStorage) {
      assert.equal(counts[0].payloadRequests, 0);
      assert.equal(counts[0].payloadBytes, 0);
    } else assert.ok(counts[0].payloadRequests > 0 && counts[0].payloadBytes > 0);
    assert.equal(counts[1].payloadRequests, 0);
    assert.equal(counts[1].payloadBytes, 0);
    return {
      completed: true,
      storageVariant: installedStorage ? 'installed-gzip-objects' : 'remote',
      installedStorage,
      warmFileMtimesUnchanged: true,
      device: `${process.platform}-${process.arch}`,
      node: process.version,
      automaticLatest: true,
      metadataFetchSource: suppliedFetch ? 'caller-supplied' : 'global-fetch',
      catalogSha256,
      manifestSha256: selected.manifestSha256,
      version: selected.version,
      first: counts[0],
      second: counts[1],
      nativeExports,
      verifiedFiles,
      codecVerified,
      prepared: true,
      closed: true,
      cacheFilesIndependentlyHashVerified: true,
      loginAttempted: false,
      restoreAttempted: false,
      nativeSendAttempted: false,
    };
  } finally {
    globalThis.fetch = originalFetch;
    try {
      await client?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
