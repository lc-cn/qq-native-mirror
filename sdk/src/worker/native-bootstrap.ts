import { withCleanupFailure } from '../runtime/cleanup.ts';
import type { ClientOptions, LoginRequest } from '../contracts/client.ts';
import type { Account } from '../contracts/client.ts';
import type { NativeObject } from '../native/native-object.ts';
import type { NativeContractProfile } from '../native/native-contracts.ts';
import type { KernelOptions } from '../kernel.ts';
import type { ServiceOperation } from '../runtime/operations.ts';
import type { RecordCodec, VideoCodec } from '../runtime/media-contracts.ts';

/** Kernel operations visible to its worker owner. Raw native handles stay here. */
export interface WorkerKernel {
  prepare(): Promise<void>;
  login(request: LoginRequest): Promise<Account>;
  invokeOperation(
    method: ServiceOperation,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}

/** Node supplies these ports in bootstrap.ts; tests substitute acquisition and
 * native loading at this same seam without initializing a QQ addon or account.
 */
export interface NativeBootstrapDependencies {
  createDataDirectory(path: string): Promise<unknown>;
  lockDataDirectory(path: string): () => void;
  loadAddon(target: { exports: NativeObject }, path: string, flags?: number): void;
  globalLoadFlags: number;
  defaultPreloadLibraries: readonly string[];
  inspectNativeContracts(
    path: string,
    version: ClientOptions['version'],
  ): Promise<NativeContractProfile | undefined>;
  builtinRecordCodec: RecordCodec;
  loadRecordCodec(path: string): Promise<RecordCodec>;
  loadVideoCodec(path: string): Promise<VideoCodec>;
  createKernel(
    wrapper: NativeObject,
    options: KernelOptions,
    emit: (event: string, payload: unknown) => void,
  ): WorkerKernel;
}

type State = 'idle' | 'initializing' | 'ready' | 'failed' | 'closed';

/** Owns one worker's initialization transaction, candidate kernel and data lock.
 * Reserve before the first await; publish business access only after prepare.
 * Failed native loading is never replayed inside the same worker. A touched
 * addon can retain singleton threads, so its lock lives until process exit.
 */
export class NativeWorkerBootstrap {
  #state: State = 'idle';
  #kernel?: WorkerKernel;
  #releaseDataLock?: () => void;
  #nativeTouched = false;
  #kernelClose?: Promise<void>;
  #close?: Promise<void>;
  readonly #dependencies: NativeBootstrapDependencies;
  readonly #emit: (event: string, payload: unknown) => void;

  constructor(
    dependencies: NativeBootstrapDependencies,
    emit: (event: string, payload: unknown) => void,
  ) {
    this.#dependencies = dependencies;
    this.#emit = emit;
  }

  initialize(options: ClientOptions): Promise<{ exports: string[] }> {
    if (this.#state !== 'idle')
      return Promise.reject(
        new Error(
          this.#state === 'closed'
            ? 'Native worker is closed'
            : 'Native worker is already initialized',
        ),
      );
    this.#state = 'initializing';
    return this.#initialize(options);
  }

  #assertInitializing(): void {
    if (this.#state !== 'initializing') throw new Error('Native worker is closed');
  }

  async #initialize(options: ClientOptions): Promise<{ exports: string[] }> {
    const dependencies = this.#dependencies;
    try {
      await dependencies.createDataDirectory(options.dataDir);
      this.#assertInitializing();
      this.#releaseDataLock = dependencies.lockDataDirectory(options.dataDir);
      this.#assertInitializing();
      const bridge: { exports: NativeObject } = { exports: {} };
      if (options.bridgePath) {
        this.#nativeTouched = true;
        dependencies.loadAddon(bridge, options.bridgePath, dependencies.globalLoadFlags);
        this.#assertInitializing();
      }
      for (const library of options.preloadLibraries ?? dependencies.defaultPreloadLibraries) {
        const preload = bridge.exports.preloadLibrary;
        this.#assertInitializing();
        if (typeof preload !== 'function')
          throw new Error('Registration bridge does not support library preloading');
        this.#nativeTouched = true;
        Reflect.apply(preload, bridge.exports, [library]);
        this.#assertInitializing();
      }
      const nativeContracts = await dependencies.inspectNativeContracts(
        options.wrapperPath!,
        options.version,
      );
      this.#assertInitializing();
      const native = { exports: {} };
      this.#nativeTouched = true;
      dependencies.loadAddon(native, options.wrapperPath!);
      this.#assertInitializing();
      const recordCodec =
        options.recordCodecPath === undefined
          ? dependencies.builtinRecordCodec
          : await dependencies.loadRecordCodec(options.recordCodecPath);
      this.#assertInitializing();
      const videoCodec =
        options.videoCodecPath === undefined
          ? undefined
          : await dependencies.loadVideoCodec(options.videoCodecPath);
      this.#assertInitializing();
      const kernel = dependencies.createKernel(
        native.exports,
        {
          dataDir: options.dataDir,
          version: options.version!,
          device: options.device,
          loginTimeoutMs: options.timeoutMs,
          rememberPassword: options.rememberPassword,
          mediaTools: options.mediaTools,
          recordCodec,
          videoCodec,
          nativeContracts,
        },
        (event, payload) => {
          if (this.#state === 'initializing' || this.#state === 'ready') this.#emit(event, payload);
        },
      );
      // Retain before prepare: it may synchronously invoke callbacks and close.
      this.#kernel = kernel;
      this.#assertInitializing();
      const prepare = kernel.prepare;
      this.#assertInitializing();
      await Reflect.apply(prepare, kernel, []);
      this.#assertInitializing();
      const exports = Object.keys(native.exports);
      this.#assertInitializing();
      this.#state = 'ready';
      return { exports };
    } catch (original) {
      if (this.#state !== 'closed') this.#state = 'failed';
      let error = original;
      try {
        await this.#retireKernel();
      } catch (cleanup) {
        error = withCleanupFailure(error, cleanup);
      }
      // No addon was dispatched: a directory-only acquisition can be released.
      // Once native loading starts, only exit may release this worker's lock.
      if (!this.#nativeTouched) {
        try {
          this.#releaseLock();
        } catch (cleanup) {
          error = withCleanupFailure(error, cleanup);
        }
      }
      throw error;
    }
  }

  #readyKernel(): WorkerKernel {
    if (this.#state === 'closed') throw new Error('Native worker is closed');
    if (this.#state !== 'ready' || !this.#kernel)
      throw new Error('Native worker is not initialized');
    return this.#kernel;
  }

  async login(request: LoginRequest): Promise<Account> {
    const kernel = this.#readyKernel();
    const login = kernel.login;
    this.#readyKernel();
    return Reflect.apply(login, kernel, [request]);
  }

  async invokeOperation(
    method: ServiceOperation,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const kernel = this.#readyKernel();
    const invoke = kernel.invokeOperation;
    this.#readyKernel();
    return Reflect.apply(invoke, kernel, [method, payload, signal]);
  }

  #retireKernel(): Promise<void> {
    const kernel = this.#kernel;
    if (!kernel) return this.#kernelClose ?? Promise.resolve();
    this.#kernel = undefined;
    return (this.#kernelClose ??= Promise.resolve().then(() => kernel.close()));
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#state = 'closed';
    return (this.#close = this.#retireKernel());
  }

  #releaseLock(): void {
    const release = this.#releaseDataLock;
    this.#releaseDataLock = undefined;
    release?.();
  }

  /** Synchronous exit hook: native threads end with the process, not kernel.close. */
  releaseOnExit(): void {
    this.#state = 'closed';
    this.#releaseLock();
  }
}
