import type { ChildProcess } from 'node:child_process';
import { WorkerRpcChannel } from './worker-rpc-channel.ts';
import { terminateWorker, type WorkerTerminationOptions } from './worker-termination.ts';
import { withCleanupFailure } from './cleanup.ts';
import { deserializeKernelError, KernelRequestError, normalizeKernelError } from '../errors.ts';
import { normalizeLoginRequest } from '../native/login-request.ts';
import type { Account, ClientOptions, ClientState, LoginRequest } from '../contracts/client.ts';
import type { ClientEvents } from '../contracts/events.ts';

/** SDK-produced events with guaranteed payload types. Worker events remain unknown. */
export type ClientLifecycleEvent = {
  [Name in 'state' | 'log' | 'terminated']: [event: Name, ...payload: ClientEvents[Name]];
}['state' | 'log' | 'terminated'];

export interface ClientLifecycleContext {
  worker: ChildProcess;
  timeout: number;
  defaultLogin?: LoginRequest;
  restart?: { spawn(): ChildProcess; payload: object };
  autoReconnect?: ClientOptions['autoReconnect'];
  emit(...event: ClientLifecycleEvent): void;
  forward(event: string, payload: unknown): void;
  exportsUpdated(exports: string[]): void;
}

/** Inspect initialization metadata without evaluating getters or iterators. */
function inspectWorkerExports(value: unknown): string[] | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const field = Object.getOwnPropertyDescriptor(value, 'exports');
    const exports: unknown = field && 'value' in field ? field.value : undefined;
    if (!Array.isArray(exports)) return;
    const lengthField = Object.getOwnPropertyDescriptor(exports, 'length');
    const length: unknown = lengthField && 'value' in lengthField ? lengthField.value : undefined;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return;
    const captured: string[] = [];
    for (let index = 0; index < length; index++) {
      const item = Object.getOwnPropertyDescriptor(exports, String(index));
      const name: unknown = item && 'value' in item ? item.value : undefined;
      if (typeof name !== 'string') return;
      captured.push(name);
    }
    return captured;
  } catch {
    // Opaque descriptor failures cannot leak through this metadata boundary.
    return;
  }
}

/** Capture the complete init reply before either owner publishes its export view. */
export function captureWorkerExports(value: unknown): string[] {
  const exports = inspectWorkerExports(value);
  if (!exports) throw new Error('Invalid worker initialization exports');
  return exports;
}

/** Capture only the identity fields produced by the worker. No numeric
 * conversion, UID prefix assumption or native ABI assertion belongs here.
 * Fallible descriptor inspection may retire the client in controlled transports;
 * recheck before reading another field or publishing a captured identity.
 */
function captureWorkerAccount(value: unknown, isCurrent: () => boolean): Account | undefined {
  try {
    if (!isCurrent()) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const uinField = Object.getOwnPropertyDescriptor(value, 'uin');
    if (!isCurrent()) return;
    const uidField = Object.getOwnPropertyDescriptor(value, 'uid');
    if (!isCurrent()) return;
    const uin: unknown = uinField && 'value' in uinField ? uinField.value : undefined;
    const uid: unknown = uidField && 'value' in uidField ? uidField.value : undefined;
    if (typeof uin !== 'string' || !/^\d+$/.test(uin) || typeof uid !== 'string' || !uid.trim())
      return;
    return { uin, uid };
  } catch {
    // Malformed worker data cannot expose thrown descriptor/serialization details.
    return;
  }
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
  #termination?: { worker: ChildProcess; promise: Promise<void> };
  #failureRetirement?: { worker: ChildProcess; promise: Promise<void> };
  #state: ClientState = 'idle';
  #account?: Account;
  #rpc: WorkerRpcChannel;
  #timeout: number;
  #login?: Promise<Account>;
  #loginRequest?: LoginRequest;
  #defaultLogin: LoginRequest;
  #generation = 0;
  #offlineRevision = 0;
  #lastAccount?: Account;
  #reconnecting?: Promise<Account>;
  #reconnectRequest?: LoginRequest;
  #restart?: { spawn(): ChildProcess; payload: object };
  #auto?: { maxAttempts: number; delayMs: number };
  #autoTimer?: NodeJS.Timeout;
  #autoAttempts = 0;
  #configuredLogin?: { generation: number; handle?: NodeJS.Immediate };
  readonly #context: ClientLifecycleContext;
  constructor(context: ClientLifecycleContext) {
    this.#context = context;
    const { worker, timeout, defaultLogin, restart, autoReconnect } = context;
    this.#worker = worker;
    this.#timeout = timeout;
    this.#defaultLogin = normalizeLoginRequest(defaultLogin ?? { method: 'qr' });
    this.#rpc = new WorkerRpcChannel(
      () => {
        const worker = this.#worker;
        return {
          send: (message, callback) => worker.send(message, callback),
          cancelRead: (id) => {
            // This closure retains the original worker generation. IPC delivery
            // is best effort; its callback observes errors without replaying IO.
            worker.send({ control: 'cancel-read', id }, () => {});
          },
        };
      },
      {
        failure: requestFailure,
        responseFailure: deserializeKernelError,
        timeout: (method, error) => this.#requestTimedOut(method, error),
      },
    );
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
    const isCurrent = () => generation === this.#generation && !this.#closed && !this.#closing;
    worker.on('message', (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const message = value as {
        event?: string;
        payload?: Record<string, unknown> & { peer?: { type?: unknown } };
      };
      if (generation !== this.#generation || this.#closed) return;
      if (message.event) {
        if (this.#closing) return;
        let offlineRevision: number | undefined;
        let retryableDisconnect = false;
        if (message.event === 'ready') {
          const account = captureWorkerAccount(message.payload, isCurrent);
          if (!isCurrent()) return;
          if (!account) {
            this.#context.forward('diagnostic', { stage: 'invalid-worker-ready-account' });
            return;
          }
          this.#account = account;
          this.#lastAccount = { ...account };
          this.#autoAttempts = 0;
          clearTimeout(this.#autoTimer);
          this.#autoTimer = undefined;
          this.#setState('online');
          if (!isCurrent()) return;
        }
        if (
          message.event === 'disconnected' ||
          message.event === 'logout' ||
          message.event === 'kicked'
        ) {
          const beforePolicyRevision = this.#offlineRevision;
          let policyFailure: { error: unknown } | undefined;
          try {
            retryableDisconnect =
              message.event === 'disconnected' && message.payload?.retryable === true;
          } catch (error) {
            policyFailure = { error };
          }
          // A fallible policy lookup cannot supersede a nested retirement or close.
          if (!isCurrent() || beforePolicyRevision !== this.#offlineRevision) return;
          try {
            offlineRevision = this.#retireAccount(message.event, retryableDisconnect);
          } catch (error) {
            if (policyFailure) {
              // eslint-disable-next-line preserve-caught-error -- Preserve both policy and observer failures.
              throw new AggregateError(
                [policyFailure.error, error],
                'QQ offline policy inspection and notification failed',
              );
            }
            throw error;
          }
          if (policyFailure) throw policyFailure.error;
        }
        this.#context.forward(message.event, message.payload);
        if (
          retryableDisconnect &&
          offlineRevision === this.#offlineRevision &&
          isCurrent() &&
          this.#state === 'disconnected' &&
          !this.#login &&
          !this.#account
        )
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
  /** Commit the selected state before presentation; retain both original values
   * if an observer throws. The caller owns cleanup, shutdown and retry policy.
   */
  #withStateNotificationFailure(
    error: unknown,
    state: 'idle' | 'failed',
    operation: 'login' | 'close' | 'reconnect',
  ): unknown {
    try {
      this.#setState(state);
    } catch (notificationError) {
      return new AggregateError(
        [error, notificationError],
        `QQ ${operation} and state notification failed`,
      );
    }
    return error;
  }
  /** Commit retirement before synchronous observers can throw, reply or log in.
   * The revision prevents a nested offline notification from reviving an older
   * event's automatic restore decision. It does not retire the worker generation.
   */
  #retireAccount(event: 'disconnected' | 'logout' | 'kicked', retryable: boolean): number {
    this.#cancelConfiguredLogin();
    const revision = ++this.#offlineRevision;
    const stateChanged = this.#state !== 'disconnected';
    this.#login = undefined;
    this.#account = undefined;
    this.#state = 'disconnected';
    if (event !== 'disconnected' || !retryable) {
      clearTimeout(this.#autoTimer);
      this.#autoTimer = undefined;
    }
    if (event !== 'disconnected') this.#lastAccount = undefined;
    this.#rpc.rejectPending(
      new Error(`QQ account became offline (${event}); request was not replayed`),
      (method) => method === 'close',
    );
    if (stateChanged && revision === this.#offlineRevision && this.#state === 'disconnected')
      this.#context.emit('state', 'disconnected');
    return revision;
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
        // Promise rejection can carry arbitrary thrown values; preserve their identity.
        this.#context.forward('reconnect-error', error);
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
    if (method === 'login') await this.#retireFailedWorker(this.#worker, error, 'login timeout');
    return error;
  }
  /** One worker failure owns retirement, presentation and the exit gate.
   * A reconnect's login timeout may reach this transaction again through its
   * catch; joining the result prevents duplicate notification and aggregation.
   */
  #retireFailedWorker(
    worker: ChildProcess,
    error: unknown,
    operation: 'login timeout' | 'reconnect',
  ): Promise<void> {
    if (this.#failureRetirement?.worker === worker) return this.#failureRetirement.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((fulfilled, rejected) => {
      resolve = fulfilled;
      reject = rejected;
    });
    // Reserve before cancellation transports or synchronous observers reenter.
    this.#failureRetirement = { worker, promise };
    this.#finishFailureRetirement(worker, error, operation).then(resolve, reject);
    return promise;
  }
  async #finishFailureRetirement(
    worker: ChildProcess,
    error: unknown,
    operation: 'login timeout' | 'reconnect',
  ): Promise<void> {
    const stateChanged = !this.#closing && this.#state !== 'failed';
    this.#closed = true;
    this.#account = undefined;
    if (!this.#closing) this.#state = 'failed';
    clearTimeout(this.#autoTimer);
    this.#autoTimer = undefined;
    this.#rpc.rejectPending(normalizeKernelError(error));
    const stopped = this.#stopWorker(false, worker);
    let notificationFailure: { error: unknown } | undefined;
    try {
      if (stateChanged && !this.#closing && this.#state === 'failed')
        this.#context.emit('state', 'failed');
    } catch (error) {
      notificationFailure = { error };
    }
    try {
      await stopped;
    } catch (cleanupError) {
      // eslint-disable-next-line preserve-caught-error -- AggregateError retains operation, notification and cleanup failures.
      throw new AggregateError(
        notificationFailure
          ? [error, notificationFailure.error, cleanupError]
          : [error, cleanupError],
        `QQ ${operation} and worker cleanup failed`,
      );
    }
    if (notificationFailure)
      throw new AggregateError(
        [error, notificationFailure.error],
        `QQ ${operation} and state notification failed`,
      );
  }
  /** Initialization schedules one captured default request. Explicit account work
   * takes ownership before observers run; an obsolete task never reports errors
   * against a newer worker or a closed client. No authorization is replayed.
   */
  scheduleDefaultLogin(): void {
    if (this.#configuredLogin || this.#closing || this.#closed || this.#reconnecting) return;
    const task: { generation: number; handle?: NodeJS.Immediate } = {
      generation: this.#generation,
    };
    this.#configuredLogin = task;
    const ownsTask = () =>
      this.#configuredLogin === task && task.generation === this.#generation && !this.#closing;
    task.handle = setImmediate(() => {
      task.handle = undefined;
      if (!ownsTask() || this.#closed || this.#reconnecting) {
        if (this.#configuredLogin === task) this.#configuredLogin = undefined;
        return;
      }
      this.#startLogin(this.#defaultLogin).then(
        () => {
          if (this.#configuredLogin === task) this.#configuredLogin = undefined;
        },
        (error: unknown) => {
          const report = ownsTask();
          if (this.#configuredLogin === task) this.#configuredLogin = undefined;
          // An active timeout/crash may have committed failed/closed ownership.
          // Preserve its error; only explicit supersession silences the task.
          if (report) this.#context.forward('loginError', error);
        },
      );
    });
  }
  #cancelConfiguredLogin(): void {
    const task = this.#configuredLogin;
    this.#configuredLogin = undefined;
    if (task?.handle) clearImmediate(task.handle);
  }
  login(request: LoginRequest = this.#defaultLogin): Promise<Account> {
    if (this.#closing || this.#closed) return Promise.reject(new Error('QQ client is closed'));
    try {
      request = normalizeLoginRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    this.#cancelConfiguredLogin();
    return this.#startLogin(request);
  }
  #startLogin(request: LoginRequest): Promise<Account> {
    if (this.#closing || this.#closed) return Promise.reject(new Error('QQ client is closed'));
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
    if (this.#login) return this.#login;
    let resolve!: (account: Account) => void;
    let reject!: (reason: unknown) => void;
    const loginPromise = new Promise<Account>((fulfilled, rejected) => {
      resolve = fulfilled;
      reject = rejected;
    });
    // Reserve before synchronous state observers can join, replace or close this attempt.
    this.#loginRequest = { ...request };
    this.#login = loginPromise;
    const generation = this.#generation;
    const isCurrent = () => generation === this.#generation && !this.#closed && !this.#closing;
    let submitted: Promise<unknown>;
    try {
      this.#setState('connecting');
      if (!isCurrent()) throw new Error('QQ client closed or replaced during login');
      submitted = this.request<unknown>('login', { login: request });
    } catch (error) {
      submitted = Promise.reject(error);
    }
    submitted
      .then((value) => {
        const account = captureWorkerAccount(value, isCurrent);
        if (!isCurrent()) throw new Error('QQ client closed or replaced during login');
        if (!account) throw new Error('Invalid worker login account identity');
        return account;
      })
      .catch((error) => {
        if (this.#login === loginPromise) {
          this.#login = undefined;
          if (!this.#closed && !this.#closing && this.#state === 'connecting')
            throw this.#withStateNotificationFailure(error, 'idle', 'login');
        }
        throw error;
      })
      .then(resolve, reject);
    return loginPromise;
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
    this.#cancelConfiguredLogin();
    clearTimeout(this.#autoTimer);
    this.#autoTimer = undefined;
    const before = {
      state: this.#state,
      account: this.#account,
      login: this.#login,
      closed: this.#closed,
      generation: this.#generation,
      offlineRevision: this.#offlineRevision,
    };
    let resolve!: (account: Account) => void;
    let reject!: (error: unknown) => void;
    const reconnectPromise = new Promise<Account>((fulfilled, rejected) => {
      resolve = fulfilled;
      reject = rejected;
    });
    // Reserve for synchronous joins before notification, but do not schedule
    // worker replacement until presentation succeeds.
    this.#reconnectRequest = login;
    this.#reconnecting = reconnectPromise;
    let submitted: Promise<Account>;
    try {
      this.#setState('connecting');
      if (this.#closing || this.state === 'closed')
        throw new Error('QQ client closed during reconnect');
      submitted = Promise.resolve()
        .then(() => this.#restartAndLogin(login))
        .catch((error) => {
          if (!this.#closing) {
            this.#closed = true;
            throw this.#withStateNotificationFailure(error, 'failed', 'reconnect');
          }
          throw error;
        });
    } catch (error) {
      // A presentation failure has not retired the old worker or its requests.
      // Roll back only our own transition; nested account/shutdown work wins.
      if (
        !this.#closing &&
        this.#state === 'connecting' &&
        this.#closed === before.closed &&
        this.#generation === before.generation &&
        this.#offlineRevision === before.offlineRevision &&
        this.#account === before.account &&
        this.#login === before.login
      )
        this.#state = before.state;
      submitted = Promise.reject(error);
    }
    const release = () => {
      if (this.#reconnecting === reconnectPromise) {
        this.#reconnecting = undefined;
        this.#reconnectRequest = undefined;
      }
    };
    submitted.then(
      (account) => {
        release();
        resolve(account);
      },
      (error: unknown) => {
        release();
        reject(error);
      },
    );
    return reconnectPromise;
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
        await this.#terminateWorker(previous, {
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
    const replacement = this.#worker;
    try {
      const result = await this.request<unknown>('init', this.#restart!.payload);
      const exports = captureWorkerExports(result);
      if (this.#worker !== replacement || this.#closed || this.#closing)
        throw new Error('QQ client closed or replaced during initialization');
      this.#context.exportsUpdated(exports);
      return await this.login(login);
    } catch (error) {
      await this.#retireFailedWorker(replacement, error, 'reconnect');
      throw error;
    }
  }
  close(): Promise<void> {
    this.#cancelConfiguredLogin();
    if (this.#closePromise) return this.#closePromise;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((fulfilled, rejected) => {
      resolve = fulfilled;
      reject = rejected;
    });
    // State observers run synchronously and may close again before shutdown awaits.
    this.#closePromise = promise;
    this.#finishClose().then(resolve, reject);
    return promise;
  }
  #terminateWorker(worker: ChildProcess, options: WorkerTerminationOptions): Promise<void> {
    if (this.#termination?.worker === worker) return this.#termination.promise;
    // Promise scheduling reserves ownership before kill/exit hooks can reenter.
    // A terminal failure remains observable; another owner path cannot retry it.
    const promise = Promise.resolve().then(() => terminateWorker(worker, options));
    this.#termination = { worker, promise };
    return promise;
  }
  #stopWorker(waitForExit = false, worker = this.#worker): Promise<void> {
    return this.#terminateWorker(worker, {
      timeoutMessage: 'Native worker did not exit after shutdown',
      waitForExit,
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
      let notificationFailure: { error: unknown } | undefined;
      try {
        this.#setState('closing');
      } catch (error) {
        notificationFailure = { error };
      }
      try {
        await this.#stopWorker();
        this.#setState('closed');
      } catch (error) {
        const failure = this.#withStateNotificationFailure(error, 'failed', 'close');
        if (notificationFailure) throw withCleanupFailure(notificationFailure.error, failure);
        throw failure;
      }
      if (notificationFailure) throw notificationFailure.error;
      return;
    }
    if (this.#closed) {
      this.#closing = true;
      await this.#stopWorker();
      this.#setState('closed');
      return;
    }
    this.#closing = true;
    let notificationFailure: { error: unknown } | undefined;
    try {
      this.#setState('closing');
    } catch (error) {
      notificationFailure = { error };
    }
    // Presentation cannot prevent the owner's shutdown transaction from running.
    try {
      await this.#closeWorker();
    } catch (error) {
      if (notificationFailure) throw withCleanupFailure(notificationFailure.error, error);
      throw error;
    }
    if (notificationFailure) throw notificationFailure.error;
  }
  async #closeWorker(): Promise<void> {
    let acknowledged = false;
    try {
      await this.request('close', {}, 2000);
      acknowledged = true;
    } finally {
      this.#closed = true;
      this.#account = undefined;
      this.#rpc.rejectPending(new Error('QQ client closed'));
      try {
        await this.#stopWorker(acknowledged);
        this.#setState('closed');
      } catch (error) {
        // eslint-disable-next-line no-unsafe-finally -- Preserve the existing close cleanup failure precedence.
        throw this.#withStateNotificationFailure(error, 'failed', 'close');
      }
    }
  }
}
