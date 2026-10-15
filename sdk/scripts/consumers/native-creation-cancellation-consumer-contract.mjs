import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @template T
 * @param {Promise<T>} operation
 * @param {number} milliseconds
 * @param {string} stage
 */
async function bounded(operation, milliseconds, stage) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} directory */
async function entries(directory) {
  try {
    return await readdir(directory, { recursive: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
}

/** @param {string} entry
 * @param {'manifest' | 'payload'} stage
 */
async function cancelDuringDownload(entry, stage) {
  const directory = await mkdtemp(join(tmpdir(), `qq-create-cancel-${stage}-`));
  const cache = join(directory, 'cache');
  const data = join(directory, 'data');
  const config = join(directory, 'config.json');
  const hook = join(directory, 'guard.mjs');
  const nativeLoads = join(directory, 'native-loads.txt');
  const version = { clientVersion: 'cancellation-fixture', appId: '1', qua: 'fixture' };
  const payloads = new Map([
    ['/wrapper.node', Buffer.alloc(1024, 1)],
    ['/resource-a.dat', Buffer.alloc(1024, 2)],
    ['/resource-b.dat', Buffer.alloc(1024, 3)],
  ]);
  const digest = (/** @type {Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      wrapper: 'wrapper.node',
      version,
      files: [...payloads].map(([url, bytes]) => ({
        path: url.slice(1),
        url,
        sha256: digest(bytes),
        size: bytes.length,
      })),
    }),
  );
  /** @type {string[]} */
  const requests = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  let stalledBodies = 0;
  let closedBodies = 0;
  /** @type {() => void} */
  let bodyStarted = () => assert.fail('body observer was not initialized');
  const started = new Promise((resolve) => {
    bodyStarted = () => resolve(undefined);
  });
  const expectedBodies = stage === 'manifest' ? 1 : payloads.size;
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    const bytes = path === '/manifest.json' ? manifest : payloads.get(path);
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-length': bytes.length });
    const stall = stage === 'manifest' ? path === '/manifest.json' : payloads.has(path);
    if (!stall) {
      response.end(bytes);
      return;
    }
    response.once('close', () => closedBodies++);
    // Flush a real partial body. The server never completes it, so process exit
    // requires cancellation rather than a successful download or hash failure.
    response.write(bytes.subarray(0, 1), () => {
      stalledBodies++;
      if (stalledBodies === expectedBodies) bodyStarted();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {Promise<{code:number|null, signal:NodeJS.Signals|null}> | undefined} */
  let completion;
  let stdout = '';
  let stderr = '';
  let outputOverflow = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(undefined);
      });
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await writeFile(
      config,
      JSON.stringify({
        dataDir: data,
        cacheDir: cache,
        manifestUrl: `http://127.0.0.1:${address.port}/manifest.json`,
        manifestSha256: digest(manifest),
        version,
        autoLogin: false,
        autoReconnect: false,
      }),
    );
    await writeFile(nativeLoads, '');
    await writeFile(
      hook,
      `import {appendFileSync} from 'node:fs';
process.dlopen=()=>{appendFileSync(${JSON.stringify(nativeLoads)},'attempted\\n');throw Error('native loading forbidden during cancellation');};
if(process.platform==='win32'&&process.send){
  process.on('message',message=>{
    if(message==='cancel-native-creation'){process.emit('SIGINT');process.disconnect();}
  });
  process.channel?.unref();
}
`,
    );
    child = spawn(
      process.execPath,
      ['--unhandled-rejections=strict', entry, 'prepare', '--config', config],
      {
        // NODE_OPTIONS also guards any unexpected descendant Node process. This
        // hook does not replace createClient, fetch, resource loaders or timers.
        env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` },
        stdio:
          process.platform === 'win32'
            ? ['ignore', 'pipe', 'pipe', 'ipc']
            : ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 65536) {
        outputOverflow = true;
        stdout = stdout.slice(0, 65536);
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 65536) {
        outputOverflow = true;
        stderr = stderr.slice(0, 65536);
      }
    });
    completion = new Promise((resolve, reject) => {
      child?.once('error', reject);
      child?.once('close', (code, signal) => resolve({ code, signal }));
    });
    await bounded(
      Promise.race([
        started,
        completion.then((result) => {
          throw new Error(
            `${stage} CLI exited before its download stalled: ${JSON.stringify(result)} ${stderr}`,
          );
        }),
      ]),
      10_000,
      `${stage} body start`,
    );
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => {
        child?.send('cancel-native-creation', (error) =>
          error ? reject(error) : resolve(undefined),
        );
      });
    } else {
      assert.equal(child.kill('SIGINT'), true, `${stage} interrupt delivery`);
    }
    const result = await bounded(completion, 5_000, `${stage} cancellation`);
    assert.deepEqual(result, { code: 130, signal: null }, `${stage}: ${stderr}`);
    assert.equal(stdout, '', `${stage} printed a preparation result after cancellation`);
    assert.equal(outputOverflow, false, `${stage} produced excessive diagnostics`);
    assert.equal(await readFile(nativeLoads, 'utf8'), '', `${stage} attempted native loading`);
    // Observe client-side disconnect before server cleanup can close anything.
    await bounded(
      Promise.all(
        [...sockets].map((socket) => new Promise((resolve) => socket.once('close', resolve))),
      ),
      2_000,
      `${stage} connection close`,
    );
    assert.equal(sockets.size, 0, `${stage} retained an HTTP connection`);
    assert.equal(closedBodies, expectedBodies, `${stage} did not cancel every active body`);
    const expectedRequests =
      stage === 'manifest' ? ['/manifest.json'] : ['/manifest.json', ...payloads.keys()];
    assert.deepEqual(
      [...requests].sort(),
      expectedRequests.sort(),
      `${stage} retried or acquired an unexpected source`,
    );
    const leftovers = await entries(cache);
    assert.deepEqual(
      leftovers.filter((path) =>
        /(^|[/\\])\.download-|(^|[/\\])\.content-|\.lock(?:$|[./\\])/.test(path),
      ),
      [],
      `${stage} left installation staging or a package lock`,
    );
    assert.equal(
      leftovers.some((path) => path.endsWith('.node')),
      false,
    );
    assert.deepEqual(await entries(data), [], `${stage} acquired account/worker storage`);
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (completion)
        await bounded(
          completion.catch(() => undefined),
          2_000,
          `${stage} child cleanup`,
        );
    } finally {
      try {
        for (const socket of sockets) socket.destroy();
        if (server.listening)
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve(undefined))),
          );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

/** Real CLI and createClient, served only by an owned loopback HTTP server.
 * Windows exercises an explicit IPC-triggered process.emit, not OS SIGINT.
 * @param {string} entry Source cli.ts or installed dist/cli.js.
 */
export async function verifyNativeCreationCancellation(entry) {
  const canonicalEntry = await realpath(entry);
  await cancelDuringDownload(canonicalEntry, 'manifest');
  await cancelDuringDownload(canonicalEntry, 'payload');
  return {
    nativeCreationManifestCancellationContract: true,
    nativeCreationPayloadCancellationContract: true,
    nativeCreationCancellationCleanupContract: true,
    nativeCreationCancellationSignalMode:
      process.platform === 'win32' ? 'programmatic-sigint' : 'os-sigint',
    nativeCreationCancellationLoopbackOnly: true,
    nativeCreationCancellationNativeExecuted: false,
    nativeCreationCancellationAccountUsed: false,
  };
}
