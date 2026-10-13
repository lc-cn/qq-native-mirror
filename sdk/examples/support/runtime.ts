import type { Account, ClientEvents, ClientOptions, QQClient } from 'qq-native-client';
import type { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { DemoConfig } from './config.ts';

export type DemoClient = Pick<EventEmitter<ClientEvents>, 'on' | 'off' | 'removeAllListeners'> &
  Pick<
    QQClient,
    | 'login'
    | 'close'
    | 'listFriends'
    | 'listGroups'
    | 'sendPrivateMessage'
    | 'sendGroupMessage'
    | 'state'
  >;
export interface DemoDependencies {
  createClient(options: ClientOptions): Promise<DemoClient>;
  showQr(image: Buffer, path: string, open: boolean, signal: AbortSignal): Promise<void>;
  removeQr(path: string): Promise<void>;
  saveAccount(account: Account, dataDir: string): Promise<void>;
  log(message: string): void;
  now(): number;
}
export type DemoOutcome = { ok: true } | { ok: false; error: unknown };

/** Owns one newly-created demo client, outstanding tasks and Ctrl+C cleanup. */
export class DemoLifetime {
  #closeClient: (() => Promise<void>) | undefined;
  #beforeClose: () => void = () => {};
  #shutdown: Promise<void> | undefined;
  #terminalFailure: Error | undefined;
  readonly #pending = new Set<Promise<void>>();
  #qrQueue = Promise.resolve();
  readonly #qrPath: string;
  readonly #stop: Promise<void>;
  #stopped!: () => void;
  private readonly config: DemoConfig;
  private readonly signal: AbortSignal;
  private readonly dependencies: DemoDependencies;
  constructor(config: DemoConfig, signal: AbortSignal, dependencies: DemoDependencies) {
    this.config = config;
    this.signal = signal;
    this.dependencies = dependencies;
    this.#qrPath = join(config.client.dataDir, 'demo-qrcode.png');
    this.#stop = new Promise<void>((resolve) => {
      this.#stopped = resolve;
    });
    signal.addEventListener('abort', this.#onStop, { once: true });
  }
  attach(closeClient: () => Promise<void>, beforeClose: () => void): void {
    this.#closeClient = closeClient;
    this.#beforeClose = beforeClose;
  }
  report(stage: string, error: unknown): void {
    this.dependencies.log(
      `${stage}：${error instanceof Error ? error.message : '未知错误'}（不自动重试）`,
    );
  }
  observe(task: Promise<void>, stage: string): void {
    const watched = task
      .catch((error: unknown) => this.report(stage, error))
      .finally(() => this.#pending.delete(watched));
    this.#pending.add(watched);
  }
  showQr(image: Buffer, isOnline: () => boolean): void {
    this.#qrQueue = this.#qrQueue
      .then(async () => {
        if (this.signal.aborted || isOnline()) return;
        await this.dependencies.showQr(image, this.#qrPath, this.config.openQr, this.signal);
        if (!this.signal.aborted && !isOnline())
          this.dependencies.log(`请扫描二维码并确认登录：${this.#qrPath}`);
      })
      .catch((error: unknown) => this.report('二维码展示失败', error));
    this.observe(this.#qrQueue, '事件处理失败');
  }
  async clearQr(): Promise<void> {
    await this.#qrQueue;
    await this.dependencies.removeQr(this.#qrPath);
  }
  terminate = (error: Error): void => {
    this.#terminalFailure = error;
    this.report('原生进程已终止', error);
    this.#onStop();
  };
  async waitForStop(): Promise<void> {
    await this.#stop;
    if (this.#terminalFailure) throw this.#terminalFailure;
  }
  #close(): Promise<void> {
    this.#beforeClose();
    if (!this.#closeClient) return Promise.resolve();
    return (this.#shutdown ??= Promise.resolve().then(() => this.#closeClient!()));
  }
  #onStop = (): void => {
    this.#stopped();
    this.#close().catch((error: unknown) => this.report('关闭失败', error));
  };
  async finish(outcome: DemoOutcome): Promise<void> {
    this.signal.removeEventListener('abort', this.#onStop);
    const failures: unknown[] = [];
    try {
      await this.#close();
    } catch (error) {
      failures.push(error);
    }
    await Promise.allSettled([...this.#pending]);
    try {
      await this.dependencies.removeQr(this.#qrPath);
    } catch (error) {
      failures.push(error);
    }
    this.dependencies.log('关闭流程结束，示例已退出。');
    if (failures.length > 0)
      throw new AggregateError(
        outcome.ok ? failures : [outcome.error, ...failures],
        outcome.ok ? '示例关闭时发生错误' : '示例失败，关闭时也发生错误',
        outcome.ok ? undefined : { cause: outcome.error },
      );
    if (!outcome.ok) throw outcome.error;
  }
}
