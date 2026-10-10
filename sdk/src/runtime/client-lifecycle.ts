import type { ChildProcess } from 'node:child_process';
import { WorkerRpcChannel } from './worker-rpc-channel.ts';
import { terminateWorker } from './worker-termination.ts';
import { deserializeKernelError, KernelRequestError } from '../errors.ts';
import { normalizeLoginRequest } from '../native/login-request.ts';
import type { Account, ClientOptions, ClientState, LoginRequest } from '../contracts/client.ts';

export interface ClientLifecycleContext {
  worker: ChildProcess;
  timeout: number;
  defaultLogin?: LoginRequest;
  restart?: { spawn(): ChildProcess; payload: object };
  autoReconnect?: ClientOptions['autoReconnect'];
  emit(event: string, payload: unknown): void;
  exportsUpdated(exports: string[]): void;
}

/** A parent-side failure after IPC submission cannot identify the native phase. */
function requestFailure(method: string, error: Error): Error {
  if (
    method !== 'sendMergedForward' ||
    (error instanceof KernelRequestError && error.mergedForward)
  )
    return error;
  return new KernelRequestError(method, error.message, undefined, error.name, {
    phase: 'operation',
    uploadCompletion: 'unknown',
    cardCompletion: 'unknown',
  });
}

/** Owns a client's worker generations, authorization state and shutdown.
 * Requests are never replayed. Callback presentation belongs to the public facade.
 * Only explicitly retryable disconnections can schedule automatic restoration.
 */
export class ClientLifecycle {
  #worker: ChildProcess;
  #closed = false;
  #closing = false;
  #closePromise?: Promise<void>;
  #retiringWorker = false;
  #state: ClientState = 'idle';
  #account?: Account;
  #rpc: WorkerRpcChannel;
  #timeout: number;
  #login?: Promise<Account>;
  #loginRequest?: LoginRequest;
  #defaultLogin: LoginRequest;
  #generation = 0;
  #lastAccount?: Account;
  #reconnecting?: Promise<Account>;
  #reconnectRequest?: LoginRequest;
  #restart?: { spawn(): ChildProcess; payload: object };
  #auto?: { maxAttempts: number; delayMs: number };
  #autoTimer?: NodeJS.Timeout;
  #autoAttempts = 0;
  readonly #context: ClientLifecycleContext;
  constructor(context: ClientLifecycleContext) {
    this.#context = context;
    const { worker, timeout, defaultLogin, restart, autoReconnect } = context;
    this.#worker = worker;
    this.#timeout = timeout;
    this.#defaultLogin = normalizeLoginRequest(defaultLogin ?? { method: 'qr' });
    this.#rpc = new WorkerRpcChannel(() => this.#worker, {
      failure: requestFailure,
      responseFailure: deserializeKernelError,
      timeout: (method, error) => this.#requestTimedOut(method, error),
    });
    this.#restart = restart;
    if (autoReconnect)
      this.#auto = {
        maxAttempts: typeof autoReconnect === 'object' ? (autoReconnect.maxAttempts ?? 3) : 3,
        delayMs: typeof autoReconnect === 'object' ? (autoReconnect.delayMs ?? 1000) : 1000,
      };
    this.#attach(worker);
  }
  #attach(worker: ChildProcess) {
    const generation = ++this.#generation;
    worker.on('message', (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const message = value as {
        event?: string;
        payload?: Record<string, unknown> & { peer?: { type?: unknown } };
      };
      if (generation !== this.#generation || this.#closed) return;
      if (message.event) {
        if (this.#closing) return;
        if (message.event === 'ready') {
          this.#account = { ...message.payload } as unknown as Account;
          this.#lastAccount = { ...message.payload } as unknown as Account;
          this.#autoAttempts = 0;
          clearTimeout(this.#autoTimer);
          this.#autoTimer = undefined;
          this.#setState('online');
        }
        if (
          message.event === 'disconnected' ||
          message.event === 'logout' ||
          message.event === 'kicked'
        ) {
          this.#login = undefined;
          this.#account = undefined;
          this.#setState('disconnected');
          this.#rpc.rejectPending(
            new Error(`QQ account became offline (${message.event}); request was not replayed`),
            (method) => method === 'close',
          );
          if (message.event === 'disconnected' && message.payload?.retryable !== true) {
            clearTimeout(this.#autoTimer);
            this.#autoTimer = undefined;
          }
          if (message.event !== 'disconnected') {
            clearTimeout(this.#autoTimer);
            this.#autoTimer = undefined;
            this.#lastAccount = undefined;
          }
        }
        this.#context.emit(message.event, message.payload);
        if (message.event === 'disconnected' && message.payload?.retryable === true)
          this.#scheduleReconnect();
      } else {
        this.#rpc.receive(message);
      }
    });
    const fail = (error: Error) => {
      if (generation !== this.#generation || this.#closed) return;
      clearTimeout(this.#autoTimer);
      this.#autoTimer = undefined;
      this.#closed = true;
      this.#rpc.rejectPending(error);
      this.#account = undefined;
      this.#setState(this.#closing ? 'closed' : 'failed');
      if (!this.#closing) this.#context.emit('terminated', error);
      // A worker crash has no proven network-only reason. Preserve the failure;
      // automatic login cannot safely infer that a restore should be attempted.
    };
    worker.on('error', fail);
    worker.on('exit', (code, signal) =>
      fail(new Error(`Native worker exited (code=${code}, signal=${signal})`)),
    );
    worker.stderr?.on('data', (data) => {
      if (generation === this.#generation)
        this.#context.emit('log', { stream: 'stderr', text: data.toString() });
    });
    worker.stdout?.on('data', (data) => {
      if (generation === this.#generation)
        this.#context.emit('log', { stream: 'stdout', text: data.toString() });
    });
  }
  get state(): ClientState {
    return this.#state;
  }
  get account(): Readonly<Account> | undefined {
    return this.#account && { ...this.#account };
  }
  #setState(state: ClientState) {
    if (this.#state === state) return;
    this.#state = state;
    this.#context.emit('state', state);
  }
  #scheduleReconnect() {
    if (
      !this.#auto ||
      !this.#restart ||
      !this.#lastAccount ||
      this.#closing ||
      this.#autoTimer ||
      this.#reconnecting ||
      this.#autoAttempts >= this.#auto.maxAttempts
    )
      return;
    this.#autoTimer = setTimeout(() => {
      this.#autoTimer = undefined;
      this.#autoAttempts++;
      void this.reconnect().catch((error) => {
        this.#context.emit('reconnect-error', error);
        // Login/initialization failures do not establish a transport-only cause.
        // Require explicit evidence before another automatic restore attempt.
        if (error?.retryable === true) this.#scheduleReconnect();
      });
    }, this.#auto.delayMs);
  }
  async request<T = unknown>(
    method: string,
    payload: object = {},
    timeoutMs = this.#timeout,
  ): Promise<T> {
    if (this.#closed || (this.#closing && method !== 'close') || !this.#worker.connected)
      throw new Error('QQ client is closed');
    return this.#rpc.request(method, payload, timeoutMs) as Promise<T>;
  }
  async #requestTimedOut(method: string, error: Error): Promise<Error> {
    if (method === 'login') {
      // A timed-out authorization must not later make this generation online.
      this.#closed = true;
      this.#account = undefined;
      this.#setState('failed');
      this.#rpc.rejectPending(error);
      try {
        await this.#stopWorker();
      } catch (cleanupError) {
        // eslint-disable-next-line preserve-caught-error -- AggregateError retains both original and cleanup errors.
        throw new AggregateError(
          [error, cleanupError],
          'QQ login timeout and worker cleanup failed',
        );
      }
    }
    return error;
  }
  login(request: LoginRequest = this.#defaultLogin): Promise<Account> {
    if (this.#closing || this.#closed) return Promise.reject(new Error('QQ client is closed'));
    try {
      request = normalizeLoginRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#account) {
      if ('uin' in request && request.uin !== undefined && request.uin !== this.#account.uin)
        return Promise.reject(
          new Error('A different account is online; use reconnect() to change accounts'),
        );
      return Promise.resolve({ ...this.#account });
    }
    if (
      this.#login &&
      this.#loginRequest &&
      (request.method !== this.#loginRequest.method ||
        ('uin' in request ? request.uin : undefined) !==
          ('uin' in this.#loginRequest ? this.#loginRequest.uin : undefined))
    ) {
      return Promise.reject(new Error('A different login request is already in progress'));
    }
    if (!this.#login) {
      this.#loginRequest = { ...request };
      this.#setState('connecting');
      const loginPromise = this.request<Account>('login', { login: request }).catch((error) => {
        if (this.#login === loginPromise) {
          this.#login = undefined;
          if (!this.#closed && !this.#closing && this.#state === 'connecting')
            this.#setState('idle');
        }
        throw error;
      });
      this.#login = loginPromise;
    }
    return this.#login;
  }
  waitForLogin(): Promise<Account> {
    if (this.#closing || this.#closed) return Promise.reject(new Error('QQ client is closed'));
    // A completed login Promise exposes its mutable result to its caller.
    // Return the current stored identity, while still joining a pending login.
    if (this.#account) return Promise.resolve({ ...this.#account });
    return this.#login ?? this.login();
  }
  /** Restart the isolated native process and restore authorization. Requests are never replayed. */
  reconnect(
    login: LoginRequest = {
      method: 'restore',
      ...(this.#lastAccount ? { uin: this.#lastAccount.uin } : {}),
    },
  ): Promise<Account> {
    if (this.#closing || this.#state === 'closed')
      return Promise.reject(new Error('QQ client is closed'));
    try {
      login = normalizeLoginRequest(login);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.#restart)
      return Promise.reject(new Error('Worker restart is unavailable for this client'));
    if (this.#reconnecting) {
      if (
        login.method !== this.#reconnectRequest?.method ||
        ('uin' in login ? login.uin : undefined) !==
          (this.#reconnectRequest && 'uin' in this.#reconnectRequest
            ? this.#reconnectRequest.uin
            : undefined)
      ) {
        return Promise.reject(new Error('A different reconnect request is already in progress'));
      }
      return this.#reconnecting;
    }
    clearTimeout(this.#autoTimer);
    this.#autoTimer = undefined;
    this.#reconnectRequest = login;
    this.#reconnecting = Promise.resolve()
      .then(() => this.#restartAndLogin(login))
      .catch((error) => {
        if (!this.#closing) {
          this.#closed = true;
          this.#setState('failed');
        }
        throw error;
      })
      .finally(() => {
        this.#reconnecting = undefined;
        this.#reconnectRequest = undefined;
      });
    this.#setState('connecting');
    return this.#reconnecting;
  }
  async #restartAndLogin(login: LoginRequest): Promise<Account> {
    if (this.#closing || this.#state === 'closed') throw new Error('QQ client is closed');
    this.#setState('connecting');
    this.#account = undefined;
    this.#login = undefined;
    this.#rpc.rejectPending(new Error('QQ client reconnecting; request was not replayed'));
    const previous = this.#worker;
    ++this.#generation;
    this.#retiringWorker = true;
    try {
      if (previous.exitCode == null && previous.signalCode == null) {
        await terminateWorker(previous, {
          timeoutMessage: 'Previous native worker did not exit',
        });
      }
    } finally {
      this.#retiringWorker = false;
    }
    if (this.#closing) throw new Error('QQ client closed during reconnect');
    this.#closed = false;
    this.#worker = this.#restart!.spawn();
    this.#attach(this.#worker);
    try {
      const result = await this.request<{ exports: string[] }>('init', this.#restart!.payload);
      this.#context.exportsUpdated(result.exports);
      return await this.login(login);
    } catch (error) {
      if (!this.#closing) {
        this.#closed = true;
        this.#setState('failed');
      }
      try {
        await this.#stopWorker();
      } catch (cleanupError) {
        // eslint-disable-next-line preserve-caught-error -- AggregateError retains both original and cleanup errors.
        throw new AggregateError([error, cleanupError], 'QQ reconnect and worker cleanup failed');
      }
      throw error;
    }
  }
  close(): Promise<void> {
    return (this.#closePromise ??= this.#finishClose());
  }
  async #stopWorker(): Promise<void> {
    const worker = this.#worker;
    if (worker.exitCode != null || worker.signalCode != null) return;
    await terminateWorker(worker, {
      timeoutMessage: 'Native worker did not exit after shutdown',
    });
  }
  async #finishClose(): Promise<void> {
    clearTimeout(this.#autoTimer);
    this.#autoTimer = undefined;
    if (this.#closing) return;
    if (this.#retiringWorker) {
      this.#closing = true;
      this.#closed = true;
      this.#account = undefined;
      this.#setState('closing');
      try {
        await this.#stopWorker();
        this.#setState('closed');
      } catch (error) {
        this.#setState('failed');
        throw error;
      }
      return;
    }
    if (this.#closed) {
      this.#closing = true;
      await this.#stopWorker();
      this.#setState('closed');
      return;
    }
    this.#closing = true;
    this.#setState('closing');
    try {
      await this.request('close', {}, 2000);
    } finally {
      this.#closed = true;
      this.#account = undefined;
      this.#rpc.rejectPending(new Error('QQ client closed'));
      try {
        await this.#stopWorker();
        this.#setState('closed');
      } catch (error) {
        this.#setState('failed');
        // eslint-disable-next-line no-unsafe-finally -- Preserve the existing close cleanup failure precedence.
        throw error;
      }
    }
  }
}
