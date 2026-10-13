import { fork } from 'node:child_process';
import { mkdir, lstat, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientOptions } from '../contracts/client.ts';
import { normalizeLoginRequest } from '../native/login-request.ts';
import { prepareNative } from '../native/native-package.ts';
import { QQClient, completeClientInitialization } from './qq-client.ts';

/** This checks only the selected file, never native ABI compatibility. */
async function registrationBridge(path: string, optional = false): Promise<string | undefined> {
  try {
    try {
      await lstat(path);
    } catch (error) {
      if (
        optional &&
        error instanceof Error &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'
      )
        return undefined;
      throw error;
    }
    if (!(await stat(path)).isFile()) throw new Error('Registration bridge must be a regular file');
    await access(path, constants.R_OK);
    return path;
  } catch (cause) {
    throw new Error(`Cannot use registration bridge: ${path}`, { cause });
  }
}

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
  const dataDir = resolve(options.dataDir);
  let bridgePath: string | undefined;
  if (options.bridgePath !== undefined) {
    if (
      typeof options.bridgePath !== 'string' ||
      !options.bridgePath.trim() ||
      options.bridgePath.includes('\0')
    )
      throw new Error('bridgePath must be a non-empty path without NUL characters');
    // Explicit relative paths were loaded from the worker's data-directory cwd.
    bridgePath = await registrationBridge(resolve(dataDir, options.bridgePath));
  }
  const native = await prepareNative(options);
  if (bridgePath === undefined && ['darwin', 'linux'].includes(process.platform)) {
    const adjacentBridge = join(dirname(native.wrapperPath), 'registration-bridge.node');
    bridgePath = await registrationBridge(adjacentBridge, true);
    if (bridgePath === undefined)
      bridgePath = await registrationBridge(
        fileURLToPath(
          new URL(
            `../../native/${process.platform}-${process.arch}/registration-bridge.node`,
            import.meta.url,
          ),
        ),
      );
  }
  const workerUrl = new URL(
    import.meta.url.endsWith('.ts') ? '../worker.ts' : '../worker.js',
    import.meta.url,
  );
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
    const result = await client.request<unknown>('init', payload);
    completeClientInitialization(client, result, options.login !== undefined);
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
