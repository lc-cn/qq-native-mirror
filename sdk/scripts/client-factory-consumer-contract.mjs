import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    return {
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
