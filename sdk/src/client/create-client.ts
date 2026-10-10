import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientOptions } from '../contracts/client.ts';
import { normalizeLoginRequest } from '../native/login-request.ts';
import { prepareNative } from '../native/native-package.ts';
import { QQClient } from './qq-client.ts';

/** Resolve one native bundle and initialize its isolated worker before exposing a client. */
export async function createClient(options: ClientOptions): Promise<QQClient> {
  if (!options.dataDir) throw new Error('dataDir is required');
  options = {
    ...options,
    login: options.login === undefined ? undefined : normalizeLoginRequest(options.login),
  };
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_483_647)
  )
    throw new Error('timeoutMs must be an integer between 1 and 2147483647 milliseconds');
  if (typeof options.autoReconnect === 'object') {
    const { maxAttempts = 3, delayMs = 1000 } = options.autoReconnect;
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0
    )
      throw new Error('Invalid autoReconnect policy');
  }
  const native = await prepareNative(options);
  const adjacentBridge = join(dirname(native.wrapperPath), 'registration-bridge.node');
  const bridgePath =
    options.bridgePath ??
    (['darwin', 'linux'].includes(process.platform)
      ? existsSync(adjacentBridge)
        ? adjacentBridge
        : fileURLToPath(
            new URL(
              `../../native/${process.platform}-${process.arch}/registration-bridge.node`,
              import.meta.url,
            ),
          )
      : undefined);
  const workerUrl = new URL(
    import.meta.url.endsWith('.ts') ? '../worker.ts' : '../worker.js',
    import.meta.url,
  );
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const spawnWorker = () =>
    fork(fileURLToPath(workerUrl), [], {
      cwd: dataDir,
      env,
      execPath: process.execPath,
      execArgv: [],
      serialization: 'advanced' as const,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  const worker = spawnWorker();
  const payload = {
    options: {
      ...options,
      ...native,
      videoCodecPath:
        options.videoCodecPath ??
        (options.mediaTools === undefined ? native.videoCodecPath : undefined),
      bridgePath,
      dataDir,
    },
  };
  const client = new QQClient(
    worker,
    options.timeoutMs ?? 120_000,
    options.login,
    { spawn: spawnWorker, payload },
    options.autoReconnect,
  );
  try {
    const result = await client.request<{ exports: string[] }>('init', payload);
    client.nativeExports.push(...result.exports);
    if (options.login)
      setImmediate(() => {
        void client.login(options.login).catch((error) => client.emit('loginError', error));
      });
    return client;
  } catch (error) {
    try {
      await client.close();
    } catch (cleanupError) {
      // eslint-disable-next-line preserve-caught-error -- AggregateError retains both original and cleanup errors.
      throw new AggregateError(
        [error, cleanupError],
        'QQ initialization and worker cleanup failed',
      );
    }
    throw error;
  }
}
