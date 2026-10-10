import type { QQClient } from '../index.ts';
import type { ClientOptions, LoginRequest } from '../types.ts';
import { cleanupAll } from '../runtime/cleanup.ts';

export function watchReconnectEnabled(value: ClientOptions['autoReconnect']): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid autoReconnect policy');
  const { maxAttempts = 3, delayMs = 1000 } = value;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 0
  )
    throw new Error('Invalid autoReconnect policy');
  return true;
}

/** Watch only remains open across explicitly retryable, enabled reconnects. */
export function observeWatchFailures(
  client: QQClient,
  autoReconnect: ClientOptions['autoReconnect'],
  fail: (error: Error) => void,
): () => void {
  const enabled = watchReconnectEnabled(autoReconnect);
  const disconnected = (info: { retryable?: boolean } | undefined) => {
    if (!(enabled && info?.retryable === true))
      fail(new Error('QQ watch stopped: account disconnected'));
  };
  const kicked = () => fail(new Error('QQ watch stopped: account kicked offline'));
  const logout = () => fail(new Error('QQ watch stopped: account logged out'));
  const failed = (error: Error) => fail(error);
  client.on('disconnected', disconnected);
  client.on('kicked', kicked);
  client.on('logout', logout);
  client.on('terminated', failed);
  client.on('reconnect-error', failed);
  return () =>
    cleanupAll([
      () => client.off('disconnected', disconnected),
      () => client.off('kicked', kicked),
      () => client.off('logout', logout),
      () => client.off('terminated', failed),
      () => client.off('reconnect-error', failed),
    ]);
}

export function watchEventMode(mode: unknown): 'message' | 'all' | 'normalized' {
  if (mode === undefined || mode === 'message') return 'message';
  if (mode === 'all') return 'all';
  if (mode === 'normalized') return 'normalized';
  throw new Error('--events must be message, all or normalized');
}
/** Attach business deliveries before login; return exact listener cleanup. */
export function observeWatchEvents(
  client: QQClient,
  mode: unknown = undefined,
  write: (line: string) => void = console.log,
): () => void {
  const selected = watchEventMode(mode);
  const events =
    selected === 'message'
      ? (['message'] as const)
      : ([
          'message',
          selected === 'normalized' ? 'message.recalled' : 'message-recalled',
          'request.friend',
          'request.group',
          'friend-list-updated',
          'friend-added',
          'group-list-updated',
          'group-members-updated',
          'group-info-updated',
          'group-membership',
          'group-admin',
          'group-mute',
        ] as const);
  const listeners = events.map((event) => {
    const listener = (payload: unknown) =>
      write(JSON.stringify(selected === 'message' ? payload : { event, payload }));
    client.on(event, listener);
    return { event, listener };
  });
  return () =>
    cleanupAll(
      listeners.map(
        ({ event, listener }) =>
          () =>
            client.off(event, listener),
      ),
    );
}

export interface ClientCommandContext {
  client: QQClient;
  command: string;
  login: LoginRequest;
  autoReconnect: ClientOptions['autoReconnect'];
  watchMode?: unknown;
  action?: (client: QQClient) => Promise<unknown>;
  qrPath: string;
  writeQr(path: string, image: Buffer): Promise<void>;
  output(line: string): void;
  report(line: string): void;
  signals: {
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  };
  setExitCode(code: number): void;
}

/** Own the client and every command listener from setup through shutdown.
 * Dependencies describe the actual CLI IO so tests use the same execution path.
 */
export async function runClientCommand(context: ClientCommandContext): Promise<void> {
  const { client, command, output, report, signals, setExitCode } = context;
  let closed = false;
  let stopped = false;
  let shutdown: Promise<void> | undefined;
  const close = () =>
    (shutdown ??= (async () => {
      await client.close();
    })());
  let qrWrite: Promise<void> = Promise.resolve();
  const qrcode = ({ image }: { image: Buffer }) => {
    if (closed) return;
    const save = async () => {
      if (closed) return;
      await context.writeQr(context.qrPath, image);
      if (!closed) report(`Scan the login QR image: ${context.qrPath}`);
    };
    // A failed older image must not poison later QR deliveries. The latest save
    // still controls the post-login result, and each failure is reported once.
    qrWrite = qrWrite.then(save, save);
    void qrWrite.catch((error: unknown) => {
      if (!closed)
        report(`Cannot save QR image: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const loginError = (error: Error) => {
    if (!closed) report(`Login: ${error.message}`);
  };
  let endWatch: (() => void) | undefined;
  let failWatch: ((error: Error) => void) | undefined;
  const watchDone =
    command === 'watch'
      ? new Promise<void>((resolve, reject) => {
          endWatch = resolve;
          failWatch = reject;
        })
      : undefined;
  // Failure can arrive during login, before the command awaits watchDone.
  if (watchDone) void watchDone.catch(() => {});
  let removeWatchEvents: (() => void) | undefined;
  let removeWatchFailures: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    closed = true;
    setExitCode(130);
    endWatch?.();
    void close()
      .catch(() => {})
      .finally(() => setExitCode(130));
  };
  try {
    client.on('qrcode', qrcode);
    client.on('login-error', loginError);
    // Readiness can deliver business events synchronously; attach before login.
    if (watchDone) {
      removeWatchEvents = observeWatchEvents(client, context.watchMode, (line) => {
        if (!closed) output(line);
      });
      removeWatchFailures = observeWatchFailures(client, context.autoReconnect, (error) =>
        failWatch?.(error),
      );
    }
    signals.once('SIGINT', stop);
    signals.once('SIGTERM', stop);
    const account = await client.login(context.login);
    await qrWrite;
    if (stopped) return;
    if (command === 'login') output(JSON.stringify(account));
    else if (watchDone) await watchDone;
    else if (context.action) {
      const result = await context.action(client);
      if (stopped) return;
      output(JSON.stringify(result === undefined ? { dispatched: true } : result, null, 2));
    }
  } finally {
    closed = true;
    try {
      cleanupAll([
        () => removeWatchEvents?.(),
        () => removeWatchFailures?.(),
        () => client.off('qrcode', qrcode),
        () => client.off('login-error', loginError),
        () => signals.removeListener('SIGINT', stop),
        () => signals.removeListener('SIGTERM', stop),
      ]);
    } finally {
      await close();
    }
  }
}
