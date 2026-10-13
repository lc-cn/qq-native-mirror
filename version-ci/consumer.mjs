import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { validateMainSource } from './main-artifact.mjs';
import { openMirrorSelection } from './mirror-selection.mjs';

/** @typedef {{state:string,nativeExports:readonly string[],account?:unknown,close():Promise<void>}} PreparedClient */
/** @typedef {{createClient(options:import('qq-native-client').ClientOptions):Promise<PreparedClient>}} MirrorSDK */
/** @typedef {{success:boolean,prepared?:boolean,closed?:boolean,warmFilesUnchanged?:boolean,verifiedFiles?:number,exports?:number,stage?:string,errorCode?:string,[key:string]:unknown}} Receipt */
/** @param {Uint8Array} bytes */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {number} first @param {number} second */
export function validateCounts(first, second) {
  if (!Number.isInteger(first) || first < 1 || second !== 0)
    throw Error('Native payload cache verification failed');
}

/** One installed archive, two independent empty accounts, one immutable native cache.
 * Fetch observations preserve actual responses; warm payloads fail before network I/O.
 * @param {MirrorSDK} [sdkOverride] Only the offline fixture supplies this port.
 */
export async function verify(sdkOverride) {
  let stage = 'sentinel';
  /** @type {PreparedClient|undefined} */
  let client;
  /** @type {string|undefined} */
  let temporary;
  /** @type {Awaited<ReturnType<typeof openMirrorSelection>>|undefined} */
  let selection;
  /** @type {{error:unknown}|undefined} */
  let primary;
  /** @type {unknown[]} */
  const failures = [];
  /** @type {Receipt} */
  const receipt = {
    platform: process.platform,
    arch: process.arch,
    clientVersion: process.env.TARGET_VERSION,
    node: process.version,
    currentRun: process.env.GITHUB_RUN_ID,
    loginAttempted: false,
    success: false,
  };
  const originalFetch = globalThis.fetch;
  let nativePayloadRequests = 0,
    warmPayloadAttempted = false;
  /** @type {Buffer|undefined} */
  let manifestBody;
  /** @type {import('../sdk/src/contracts/native.ts').NativeManifest|undefined} */
  let manifest;
  try {
    await symlink('unused', 'unused').then(
      () => {
        throw Error('Symlink denial missing');
      },
      (error) => {
        if (error.code !== 'EPERM') throw error;
      },
    );
    receipt.symlinkCreationDenied = true;
    if (!process.env.SOURCE_FILE) throw Error('Missing source file');
    const source = /** @type {import('./main-artifact.mjs').MainSource} */ (
      JSON.parse(await readFile(process.env.SOURCE_FILE, 'utf8'))
    );
    validateMainSource(source);
    receipt.mainSha256 = source.main.sha256;
    receipt.sourceRun = source.runId;
    receipt.sourceCommit = source.commit;
    receipt.sourceMode = source.mode ?? 'published-baseline';
    receipt.sdkVersion = source.main.version;
    temporary = await mkdtemp(join(tmpdir(), 'qq-version-runtime-'));
    const sdk = sdkOverride ?? (await import('qq-native-client'));
    selection = await openMirrorSelection({
      catalogFile: process.env.CATALOG_FILE,
      manifestFile: process.env.CANDIDATE_MANIFEST_FILE,
      mode: process.env.NATIVE_CATALOG_MODE ?? 'public-default',
      platform: process.platform,
      arch: process.arch,
      targetVersion: process.env.TARGET_VERSION,
    });
    receipt.selectionMode = selection.mode;
    receipt.automaticLatest = selection.automaticLatest;
    const selected = selection.selected;
    const expectedManifestUrl = selection.options.manifestUrl ?? selected.manifestUrl;
    const cacheDir = join(temporary, 'native-cache');
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const metadata = url.endsWith('/manifest.json') || url.endsWith('/catalog.json');
      if (stage === 'prepare-second' && !metadata) {
        warmPayloadAttempted = true;
        throw Error('Second preparation attempted native payload download');
      }
      const response = await originalFetch(input, init);
      if (url.endsWith('/manifest.json')) {
        if (url !== expectedManifestUrl) throw Error('Unexpected manifest URL');
        manifestBody = Buffer.from(await response.clone().arrayBuffer());
        if (sha(manifestBody) !== selected.manifestSha256)
          throw Error('Unexpected native manifest');
        manifest = JSON.parse(manifestBody.toString('utf8'));
      } else if (!metadata) nativePayloadRequests++;
      return response;
    };
    /** @type {{path:string,sha256:string,mtimeMs:number}[]|undefined} */
    let firstInventory;
    let firstRequests = 0;
    for (const pass of ['first', 'second']) {
      stage = `prepare-${pass}`;
      client = await sdk.createClient({
        ...selection.options,
        dataDir: join(temporary, `account-${pass}`),
        cacheDir,
        autoReconnect: false,
        timeoutMs: 120000,
      });
      assert.equal(client.account, undefined, 'Unexpected account in isolated preparation');
      assert.equal(client.state, 'idle');
      const expectedExports = process.env.TARGET_VERSION === '3.2.31-51102' ? 92 : 98;
      assert.equal(client.nativeExports.length, expectedExports);
      receipt.exports = client.nativeExports.length;
      await client.close();
      assert.equal(client.state, 'closed');
      client = undefined;
      if (
        !manifest ||
        !manifestBody ||
        manifest.version.clientVersion !== process.env.TARGET_VERSION
      )
        throw Error('Missing or wrong selected native manifest');
      stage = `integrity-${pass}`;
      const inventory = [];
      for (const file of manifest.files) {
        const path = join(cacheDir, sha(manifestBody), file.path);
        if (sha(await readFile(path)) !== file.sha256)
          throw Error('Cached native file hash mismatch');
        inventory.push({
          path: file.path,
          sha256: file.sha256,
          mtimeMs: (await stat(path)).mtimeMs,
        });
      }
      receipt.verifiedFiles = inventory.length;
      if (pass === 'first') {
        firstInventory = inventory;
        firstRequests = nativePayloadRequests;
      } else assert.deepEqual(inventory, firstInventory, 'Warm native files changed');
    }
    validateCounts(firstRequests, nativePayloadRequests - firstRequests);
    if (warmPayloadAttempted) throw Error('Warm payload refusal was bypassed');
    receipt.firstNativePayloadRequests = firstRequests;
    receipt.secondNativePayloadRequests = nativePayloadRequests - firstRequests;
    receipt.warmFilesUnchanged = true;
    receipt.prepared = true;
    receipt.closed = true;
    receipt.success = true;
    stage = 'complete';
  } catch (error) {
    primary = { error };
    receipt.errorCode =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'VALIDATION_FAILED';
  } finally {
    globalThis.fetch = originalFetch;
    // Release in order and preserve failures, including `throw undefined`.
    if (primary) failures.push(primary.error);
    for (const release of [
      async () => {
        if (client) await client.close();
      },
      async () => {
        if (selection) await selection.close();
      },
      async () => {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      },
    ]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
        receipt.success = false;
      }
    }
    receipt.stage = failures.length > 0 && !primary ? 'cleanup' : stage;
    if (!process.env.RECEIPT_FILE) failures.push(new Error('Missing receipt file'));
    else {
      try {
        await writeFile(process.env.RECEIPT_FILE, JSON.stringify(receipt, null, 2));
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Version consumer and cleanup failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verify();
