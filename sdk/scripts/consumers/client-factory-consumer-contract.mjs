import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { access, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

/** @typedef {import('../../src/index.ts').QQClient} Client */
/** @typedef {import('../../src/index.ts').ClientOptions} ClientOptions */
/** @typedef {import('../../src/contracts/native.ts').QQVersion} QQVersion */
/** @typedef {{wrapperPath:unknown, version:unknown, bridgePath:unknown, videoCodecPath:unknown}} CapturedInitialization */

/** @param {unknown} value @returns {Record<string,unknown>} */
function record(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return /** @type {Record<string,unknown>} */ (value);
}
/** Capture only fields inspected by this controlled IPC observation.
 * @param {unknown} message @returns {CapturedInitialization|undefined}
 */
function captureInitialization(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const raw = record(message);
  if (raw.method !== 'init') return undefined;
  const options = record(raw.options);
  return {
    wrapperPath: options.wrapperPath,
    version: options.version,
    bridgePath: options.bridgePath,
    videoCodecPath: options.videoCodecPath,
  };
}

/** Forward Node's overloaded child-process boundary without changing argument order.
 * @param {typeof childProcess.fork} fork
 * @param {unknown[]} args
 * @returns {import('node:child_process').ChildProcess}
 */
function forwardFork(fork, args) {
  const result = /** @type {unknown} */ (Reflect.apply(fork, childProcess, args));
  assert.ok(result instanceof childProcess.ChildProcess);
  return result;
}
/** @param {import('node:child_process').ChildProcess} worker
 * @param {(value:CapturedInitialization)=>void} capture
 */
function captureWorkerInitialization(worker, capture) {
  const send = worker.send;
  worker.send = (...args) => {
    const captured = captureInitialization(args[0]);
    if (captured) capture(captured);
    const result = /** @type {unknown} */ (Reflect.apply(send, worker, args));
    assert.ok(typeof result === 'boolean');
    return result;
  };
}

/** Actual compiled factory/worker; only addon loading and kernel are synthetic.
 * @param {string} installedRoot
 * @param {{source?:boolean}} [options]
 */
export async function verifyClientFactoryConsumer(installedRoot, { source = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qq-factory-consumer-')));
  const packageRoot = join(directory, 'package');
  const originalFork = childProcess.fork;
  const oldElectron = process.env.ELECTRON_RUN_AS_NODE;
  /** @type {{modulePath:string|URL,envElectron:unknown,execArgv:unknown}[]} */
  const calls = [];
  const tree = source ? 'src' : 'dist';
  const extension = source ? 'ts' : 'js';
  try {
    await mkdir(packageRoot, { recursive: true });
    await cp(join(installedRoot, tree), join(packageRoot, tree), { recursive: true });
    const metadata = record(
      JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')),
    );
    if (source) record(metadata.exports)['.'] = { import: './src/index.ts' };
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(metadata));
    const silkSource = dirname(
      createRequire(join(installedRoot, 'package.json')).resolve('silk-wasm/package.json'),
    );
    await cp(silkSource, join(directory, 'node_modules/silk-wasm'), { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(
      join(packageRoot, tree, `kernel.${extension}`),
      `export function createKernel(){return {async prepare(){},async close(){}};}`,
    );
    await writeFile(
      join(packageRoot, tree, `native/native-contract-inspection.${extension}`),
      `export async function inspectNativeContracts(){return {};}`,
    );
    const hook = join(directory, 'hook.mjs');
    await writeFile(hook, `process.dlopen=()=>{};`);
    const entry = join(packageRoot, 'entry.mjs');
    await writeFile(entry, `export {createClient,QQClient} from 'qq-native-client';`);
    childProcess.fork = (...args) => {
      const modulePath = args[0];
      const options = record(args[2] ?? (Array.isArray(args[1]) ? {} : args[1]) ?? {});
      calls.push({
        modulePath,
        envElectron: record(options.env ?? {}).ELECTRON_RUN_AS_NODE,
        execArgv: options.execArgv,
      });
      return forwardFork(originalFork, [
        modulePath,
        Array.isArray(args[1]) ? args[1] : undefined,
        {
          ...options,
          execArgv: ['--import', pathToFileURL(hook).href],
        },
      ]);
    };
    syncBuiltinESMExports();
    process.env.ELECTRON_RUN_AS_NODE = '1';
    /** @type {Promise<typeof import('../../src/index.ts')>} */
    const installedModule = import(pathToFileURL(entry).href);
    const { createClient, QQClient } = await installedModule;
    /** @type {Promise<typeof import('../../src/client/qq-client.ts')>} */
    const internalModule = import(
      pathToFileURL(join(packageRoot, tree, `client/qq-client.${extension}`)).href
    );
    const internal = await internalModule;
    assert.equal(QQClient, internal.QQClient);
    const wrapper = join(directory, 'bundle/wrapper.node');
    await mkdir(dirname(wrapper), { recursive: true });
    await writeFile(wrapper, 'synthetic wrapper');
    const adjacent = join(dirname(wrapper), 'registration-bridge.node');
    const explicit = join(directory, 'explicit-bridge.node');
    await writeFile(explicit, 'synthetic bridge');
    const fixtures = [
      {
        expected: ['darwin', 'linux'].includes(process.platform)
          ? join(packageRoot, `native/${process.platform}-${process.arch}/registration-bridge.node`)
          : undefined,
      },
      {
        adjacent: true,
        expected: ['darwin', 'linux'].includes(process.platform) ? adjacent : undefined,
      },
      { explicit: true, expected: explicit },
    ];
    // Capture the actual init payload without replacing worker execution.
    for (const [index, fixture] of fixtures.entries()) {
      if (fixture.adjacent) await writeFile(adjacent, 'synthetic adjacent');
      /** @type {CapturedInitialization|undefined} */
      let init;
      const captureFork = childProcess.fork;
      childProcess.fork = (...args) => {
        const worker = forwardFork(captureFork, args);
        captureWorkerInitialization(worker, (value) => {
          init = value;
        });
        return worker;
      };
      syncBuiltinESMExports();
      /** @type {Client|undefined} */
      let client;
      try {
        client = await createClient({
          wrapperPath: wrapper,
          version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
          bridgePath: fixture.explicit ? explicit : undefined,
          preloadLibraries: [],
          dataDir: join(directory, `data-${index}`),
          timeoutMs: 5000,
          autoReconnect: false,
        });
        assert.ok(client instanceof QQClient);
        assert.equal(client.account, undefined);
        assert.ok(init);
        assert.equal(init.bridgePath, fixture.expected);
        const modulePath = calls[index].modulePath;
        assert.equal(typeof modulePath, 'string');
        assert.ok(typeof modulePath === 'string');
        assert.equal(resolve(modulePath), join(packageRoot, tree, `worker.${extension}`));
        assert.equal(calls[index]?.envElectron, undefined);
        assert.deepEqual(calls[index]?.execArgv, []);
        const closing = client.close();
        assert.equal(client.close(), closing);
        await closing;
      } finally {
        await client?.close();
        childProcess.fork = captureFork;
        syncBuiltinESMExports();
      }
    }
    const sourceSelectionChecks = await verifyNativeSourceSelection(
      createClient,
      directory,
      explicit,
    );
    return {
      ...sourceSelectionChecks,
      clientFactoryInstalledContract: true,
      workerUrlExecuted: true,
      bridgePrecedenceContract: true,
      forkEnvironmentContract: true,
      rootClassIdentityContract: true,
      nativeExecuted: false,
      accountUsed: false,
      networkUsed: false,
    };
  } finally {
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
    if (oldElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = oldElectron;
    await rm(directory, { recursive: true, force: true });
  }
}

/** Cross the same public factory from source and a freshly installed archive.
 * Metadata/payload responses and addon loading are fixtures; no account is used.
 * @param {typeof import('../../src/index.ts').createClient} createClient
 * @param {string} directory
 * @param {string} bridgePath
 */
async function verifyNativeSourceSelection(createClient, directory, bridgePath) {
  const originalFetch = globalThis.fetch;
  const originalFork = childProcess.fork;
  /** @param {import('node:crypto').BinaryLike} bytes */
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const name = `qq-native-client-${process.platform}-${process.arch}`;
  const auxiliary = join(directory, 'node_modules', name);
  const bytes = Buffer.from('synthetic selected wrapper');
  const version = { clientVersion: '1.0.0', appId: '1', qua: 'fixture' };
  /** @type {import('../../src/contracts/native.ts').NativeManifest} */
  const manifest = {
    schemaVersion: 1,
    id: 'consumer-source-fixture',
    platform: process.platform,
    arch: process.arch,
    version,
    wrapper: 'wrapper.node',
    files: [{ path: 'wrapper.node', url: './wrapper.node', sha256: hash(bytes) }],
  };
  const manifestUrl = 'https://fixture.example/manifest.json';
  const catalogUrl = 'https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog.json';
  let remoteVersion = version;
  /** @type {typeof version | undefined} */
  let catalogVersionOverride;
  let remoteFiles = manifest.files;
  const payloads = new Map([['https://fixture.example/wrapper.node', bytes]]);
  /** @type {'catalog' | 'manifest' | undefined} */
  let rejectedMetadata;
  /** @type {'catalog' | 'manifest' | undefined} */
  let rejectedResponse;
  /** @type {{error:unknown}|undefined} */
  let cancellationFailure;
  let cancellations = 0;
  /** @type {string[]} */
  const requests = [];
  /** @type {CapturedInitialization|undefined} */
  let init;
  const readInitialization = () => {
    assert.ok(init, 'Worker did not dispatch initialization');
    return init;
  };
  let index = 0;
  let workerStarts = 0;
  /** @param {unknown} value */
  const save = async (value) => writeFile(join(auxiliary, 'manifest.json'), JSON.stringify(value));
  /** @param {Partial<ClientOptions>} options @param {string} expectedWrapper @param {QQVersion} expectedVersion */
  const openAndClose = async (options, expectedWrapper, expectedVersion) => {
    init = undefined;
    /** @type {Client|undefined} */
    let client;
    try {
      client = await createClient({
        dataDir: join(directory, `source-data-${index++}`),
        cacheDir: join(directory, 'source-cache'),
        bridgePath,
        preloadLibraries: [],
        autoReconnect: false,
        timeoutMs: 5000,
        ...options,
      });
      const capturedInit = readInitialization();
      assert.equal(capturedInit.wrapperPath, expectedWrapper);
      assert.deepEqual(capturedInit.version, expectedVersion);
      assert.equal(client.account, undefined);
    } finally {
      await client?.close();
    }
  };
  try {
    await mkdir(auxiliary, { recursive: true });
    await writeFile(
      join(auxiliary, 'package.json'),
      JSON.stringify({
        name,
        version: '0.0.0',
        exports: { './manifest.json': './manifest.json' },
      }),
    );
    await writeFile(join(auxiliary, 'wrapper.node'), bytes);
    await save(manifest);
    childProcess.fork = (...args) => {
      workerStarts++;
      const worker = forwardFork(originalFork, args);
      captureWorkerInitialization(worker, (value) => {
        init = value;
      });
      return worker;
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (
        (rejectedResponse === 'catalog' && url.endsWith('catalog.json')) ||
        (rejectedResponse === 'manifest' && url === manifestUrl)
      ) {
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations++;
              if (cancellationFailure) throw cancellationFailure.error;
            },
          }),
          { status: 503 },
        );
      }
      const body = JSON.stringify({ ...manifest, version: remoteVersion, files: remoteFiles });
      if (url.endsWith('catalog.json')) {
        if (rejectedMetadata === 'catalog') throw Error('Fixture catalog unavailable');
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            packages: [
              {
                platform: process.platform,
                arch: process.arch,
                version: catalogVersionOverride ?? remoteVersion,
                manifestUrl,
                manifestSha256: hash(body),
              },
            ],
          }),
        );
      }
      if (url === manifestUrl) {
        if (rejectedMetadata === 'manifest') throw Error('Fixture manifest unavailable');
        return new Response(body);
      }
      const payload = payloads.get(url);
      assert.ok(payload, `Unexpected fixture download: ${url}`);
      return new Response(payload);
    };
    // JavaScript callers cross the same preflight before any source lookup or worker.
    for (const key of ['wrapperPath', 'manifestUrl', 'catalogUrl', 'version']) {
      for (const value of [null, false, 0, '', [], {}]) {
        await assert.rejects(
          Promise.resolve(
            Reflect.apply(createClient, undefined, [{ dataDir: directory, [key]: value }]),
          ),
          key === 'version' ? /requires clientVersion/ : /nonempty string/,
        );
      }
    }
    await assert.rejects(
      createClient({ dataDir: directory, manifestUrl }),
      /Mirror requires trusted manifestSha256/,
    );
    assert.deepEqual(requests, []);
    assert.equal(workerStarts, 0);
    // Pinning keeps offline resolution; default selection establishes latest first.
    await openAndClose({ version }, join(auxiliary, 'wrapper.node'), version);
    assert.deepEqual(requests, []);
    await writeFile(join(auxiliary, 'wrapper.node'), 'corrupted');
    await assert.rejects(createClient({ dataDir: directory, version }), /failed verification/);
    assert.deepEqual(requests, []);
    await writeFile(join(auxiliary, 'wrapper.node'), bytes);

    await openAndClose({}, join(auxiliary, 'wrapper.node'), version);
    assert.deepEqual(requests, [catalogUrl, manifestUrl]);
    requests.length = 0;
    await writeFile(join(auxiliary, 'wrapper.node'), 'corrupted');
    await assert.rejects(createClient({ dataDir: directory }), /failed verification/);
    assert.deepEqual(
      requests,
      [catalogUrl, manifestUrl],
      'Matching corrupt content never falls back',
    );
    await writeFile(join(auxiliary, 'wrapper.node'), bytes);
    for (const stage of /** @type {const} */ (['catalog', 'manifest'])) {
      requests.length = 0;
      rejectedMetadata = stage;
      await assert.rejects(createClient({ dataDir: directory }), /Fixture .* unavailable/);
      assert.deepEqual(requests, stage === 'catalog' ? [catalogUrl] : [catalogUrl, manifestUrl]);
    }
    rejectedMetadata = undefined;
    // The public factory owns failed HTTP responses before any account/cache/worker acquisition.
    const startsBeforeHttpFailure = workerStarts;
    for (const stage of /** @type {const} */ (['catalog', 'manifest'])) {
      for (const failingCancellation of [false, true]) {
        const opaque = Proxy.revocable({}, {});
        opaque.revoke();
        cancellationFailure = failingCancellation ? { error: opaque.proxy } : undefined;
        requests.length = 0;
        rejectedResponse = stage;
        cancellations = 0;
        const dataDir = join(directory, `http-data-${stage}-${failingCancellation}`);
        const cacheDir = join(directory, `http-cache-${stage}-${failingCancellation}`);
        await assert.rejects(
          createClient({ dataDir, cacheDir }),
          (/** @type {unknown} */ error) => {
            let primary = error;
            if (failingCancellation) {
              assert.ok(error instanceof AggregateError);
              assert.equal(error.errors.length, 2);
              assert.equal(error.errors[1], opaque.proxy);
              primary = error.errors[0];
            }
            assert.ok(primary instanceof Error);
            assert.equal(
              primary.message,
              stage === 'catalog'
                ? 'Native catalog unavailable: HTTP 503'
                : 'Download failed: HTTP 503',
            );
            return true;
          },
        );
        assert.equal(cancellations, 1);
        assert.equal(workerStarts, startsBeforeHttpFailure);
        assert.deepEqual(requests, stage === 'catalog' ? [catalogUrl] : [catalogUrl, manifestUrl]);
        await assert.rejects(access(dataDir), { code: 'ENOENT' });
        await assert.rejects(access(cacheDir), { code: 'ENOENT' });
      }
    }
    rejectedResponse = undefined;
    cancellationFailure = undefined;
    requests.length = 0;
    catalogVersionOverride = { ...version, qua: 'catalog-does-not-match-manifest' };
    await assert.rejects(
      createClient({ dataDir: directory }),
      /does not match the trusted native manifest/,
    );
    assert.deepEqual(requests, [catalogUrl, manifestUrl]);
    catalogVersionOverride = undefined;
    requests.length = 0;

    // Same version and wrapper hash do not imply the same complete bundle.
    const dependency = Buffer.from('fixture selected dependency');
    remoteFiles = [
      ...manifest.files,
      { path: 'dependency.bin', url: './dependency.bin', sha256: hash(dependency) },
    ];
    payloads.set('https://fixture.example/dependency.bin', dependency);
    const differentBody = JSON.stringify({ ...manifest, files: remoteFiles });
    const differentTarget = join(directory, 'source-cache', hash(differentBody), 'wrapper.node');
    await openAndClose({}, differentTarget, version);
    assert.deepEqual(requests.slice(0, 2), [catalogUrl, manifestUrl]);
    assert.deepEqual(requests.slice(2).sort(), [...payloads.keys()].sort());
    assert.deepEqual(await readFile(join(dirname(differentTarget), 'dependency.bin')), dependency);
    remoteFiles = manifest.files;
    requests.length = 0;

    // A valid different ABI constraint is an unselected bundle, not a host failure.
    await save({ ...manifest, nodeVersion: 'v0.0.1', nodeConfigSha256: '0'.repeat(64) });
    const unconstrainedTarget = join(
      directory,
      'source-cache',
      hash(JSON.stringify(manifest)),
      'wrapper.node',
    );
    await openAndClose({}, unconstrainedTarget, version);
    assert.deepEqual(requests, [catalogUrl, manifestUrl]);
    requests.length = 0;
    // Malformed installed metadata must still reject before content-miss fallback.
    await save({ ...manifest, nodeVersion: process.version });
    await assert.rejects(
      createClient({ dataDir: directory }),
      /Invalid native Node runtime constraint/,
    );
    assert.deepEqual(requests, [catalogUrl, manifestUrl]);
    await save(manifest);
    requests.length = 0;

    remoteVersion = { ...version, clientVersion: '2.0.0' };
    const body = JSON.stringify({ ...manifest, version: remoteVersion });
    const target = join(directory, 'source-cache', hash(body), 'wrapper.node');
    await openAndClose({}, target, remoteVersion);
    assert.deepEqual(
      requests,
      [catalogUrl, manifestUrl],
      'Latest replaces an older auxiliary and reuses verified content',
    );
    requests.length = 0;
    // A version mismatch is checked before the auxiliary's runtime constraint.
    await save({ ...manifest, nodeVersion: 'v0.0.1', nodeConfigSha256: '0'.repeat(64) });
    await openAndClose({ version: remoteVersion }, target, remoteVersion);
    assert.deepEqual(requests, [catalogUrl, manifestUrl]);
    requests.length = 0;
    // Explicit catalog and manifest each bypass the installed runtime mismatch.
    await openAndClose(
      { catalogUrl: 'https://fixture.example/catalog.json' },
      target,
      remoteVersion,
    );
    assert.deepEqual(requests, ['https://fixture.example/catalog.json', manifestUrl]);
    requests.length = 0;
    await openAndClose({ manifestUrl, manifestSha256: hash(body) }, target, remoteVersion);
    assert.deepEqual(requests, [manifestUrl]);
    requests.length = 0;
    const local = join(directory, 'local-source/wrapper.node');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, bytes);
    // The legacy explicit path still needs no manifest or inventory.
    await openAndClose({ wrapperPath: local, version }, local, version);
    const codecBytes = Buffer.from(
      'export function getVideoInfo(){throw Error("fixture must not execute")}',
    );
    await writeFile(join(dirname(local), 'codec.mjs'), codecBytes);
    await writeFile(
      join(dirname(local), 'manifest.json'),
      JSON.stringify({
        ...manifest,
        videoCodec: 'codec.mjs',
        files: [
          ...manifest.files,
          { path: 'codec.mjs', url: './codec.mjs', sha256: hash(codecBytes) },
        ],
      }),
    );
    await openAndClose({ wrapperPath: local }, local, version);
    assert.equal(readInitialization().videoCodecPath, join(dirname(local), 'codec.mjs'));
    assert.deepEqual(requests, []);
    return {
      nativeSourceSelectionContract: true,
      nativeSourcePreflightContract: true,
      nativeDirectoryInstalledContract: true,
      nativeDefaultLatestContract: true,
      nativePinnedOfflineContract: true,
      nativeHttpFailureCleanupContract: true,
    };
  } finally {
    globalThis.fetch = originalFetch;
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  }
}
