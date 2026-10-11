export interface FeatureLifetimeContext {
  readonly signal: AbortSignal;
  readonly awaitAlive: <T>(value: T | PromiseLike<T>, requestSignal?: AbortSignal) => Promise<T>;
  readonly closedMessage: string;
}

/** Retires one feature independently of its account. The account port retains
 * its own failure semantics and receives the local cancellation signal so its
 * wait can release listeners. A local race also supports ports that only observe
 * account closure. Already issued native work is observed, never replayed.
 */
export class FeatureLifetime {
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #awaitAlive: FeatureLifetimeContext['awaitAlive'];
  readonly #closedMessage: string;

  constructor(context: FeatureLifetimeContext) {
    this.#signal = AbortSignal.any([context.signal, this.#controller.signal]);
    this.#awaitAlive = context.awaitAlive;
    this.#closedMessage = context.closedMessage;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  readonly assertOpen = (): void => this.#signal.throwIfAborted();

  readonly wait = async <T>(value: T | PromiseLike<T>): Promise<T> => {
    // Calling a native method can synchronously close its owner before wait.
    const pending = Promise.resolve(value);
    void pending.catch(() => {});
    this.assertOpen();
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(this.#controller.signal.reason);
      this.#controller.signal.addEventListener('abort', abort, { once: true });
    });
    void stopped.catch(() => {});
    try {
      const awaitAlive = this.#awaitAlive;
      const result = await Promise.race([awaitAlive(pending, this.#controller.signal), stopped]);
      this.assertOpen();
      return result;
    } finally {
      this.#controller.signal.removeEventListener('abort', abort);
    }
  };

  close(): void {
    if (this.#controller.signal.aborted) return;
    this.#controller.abort(new Error(this.#closedMessage));
  }
}
