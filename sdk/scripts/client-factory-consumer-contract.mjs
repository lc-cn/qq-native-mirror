import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

/** Actual compiled factory/worker; only addon loading and kernel are synthetic. */
export async function verifyClientFactoryConsumer(installedRoot, { source = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qq-factory-consumer-')));
  const packageRoot = join(directory, 'package');
  const originalFork = childProcess.fork;
  const oldElectron = process.env.ELECTRON_RUN_AS_NODE;
  const calls = [];
  const tree = source ? 'src' : 'dist';
  const extension = source ? 'ts' : 'js';
  try {
    await mkdir(packageRoot, { recursive: true });
    await cp(join(installedRoot, tree), join(packageRoot, tree), { recursive: true });
    const metadata = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
    if (source) metadata.exports['.'] = { import: './src/index.ts' };
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
      join(packageRoot, tree, `native/native-contracts.${extension}`),
      `export async function inspectNativeContracts(){return {};}`,
    );
    const hook = join(directory, 'hook.mjs');
    await writeFile(hook, `process.dlopen=()=>{};`);
    const entry = join(packageRoot, 'entry.mjs');
    await writeFile(entry, `export {createClient,QQClient} from 'qq-native-client';`);
    childProcess.fork = (modulePath, args, options) => {
      calls.push({ modulePath, options });
      return originalFork(modulePath, args, {
        ...options,
        execArgv: ['--import', pathToFileURL(hook).href],
      });
    };
    syncBuiltinESMExports();
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const { createClient, QQClient } = await import(pathToFileURL(entry).href);
    const internal = await import(
      pathToFileURL(join(packageRoot, tree, `client/qq-client.${extension}`)).href
    );
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
      let init;
      const captureFork = childProcess.fork;
      childProcess.fork = (...args) => {
        const worker = captureFork(...args);
        const send = worker.send.bind(worker);
        worker.send = (message, ...rest) => {
          if (message?.method === 'init') init = message.options;
          return send(message, ...rest);
        };
        return worker;
      };
      syncBuiltinESMExports();
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
        assert.equal(init.bridgePath, fixture.expected);
        assert.equal(
          resolve(calls[index].modulePath),
          join(packageRoot, tree, `worker.${extension}`),
        );
        assert.equal(calls[index].options.env.ELECTRON_RUN_AS_NODE, undefined);
        assert.deepEqual(calls[index].options.execArgv, []);
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
 */
async function verifyNativeSourceSelection(createClient, directory, bridgePath) {
  const originalFetch = globalThis.fetch;
  const originalFork = childProcess.fork;
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const name = `qq-native-client-${process.platform}-${process.arch}`;
  const auxiliary = join(directory, 'node_modules', name);
  const bytes = Buffer.from('synthetic selected wrapper');
  const version = { clientVersion: '1.0.0', appId: '1', qua: 'fixture' };
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
  const requests = [];
  let init;
  let index = 0;
  const save = async (value) => writeFile(join(auxiliary, 'manifest.json'), JSON.stringify(value));
  const openAndClose = async (options, expectedWrapper, expectedVersion) => {
    init = undefined;
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
      assert.equal(init.options.wrapperPath, expectedWrapper);
      assert.deepEqual(init.options.version, expectedVersion);
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
      const worker = originalFork(...args);
      const send = worker.send.bind(worker);
      worker.send = (message, ...rest) => {
        if (message?.method === 'init') init = message;
        return send(message, ...rest);
      };
      return worker;
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
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
    assert.equal(init.options.videoCodecPath, join(dirname(local), 'codec.mjs'));
    assert.deepEqual(requests, []);
    return {
      nativeSourceSelectionContract: true,
      nativeDirectoryInstalledContract: true,
      nativeDefaultLatestContract: true,
      nativePinnedOfflineContract: true,
    };
  } finally {
    globalThis.fetch = originalFetch;
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  }
}
