import { cleanupAll } from './cleanup.ts';
import type { NativeObject } from '../native/native-object.ts';

/** Owns the dispatch, wait and teardown lifetime of one native Session.
 * Closing marks the Session inert before aborting waits or running fallible
 * cleanup. Native invocations already issued are observed, never replayed.
 */
export class NativeServiceLifetime {
  readonly #controller = new AbortController();
  readonly #cleanup: (() => void)[] = [() => this.#controller.abort()];
  #closed = false;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Register acquired resources in construction order; shutdown preserves it. */
  own<T extends { close(): void }>(resource: T): T {
    this.defer(() => resource.close());
    return resource;
  }

  /** Lazy resources register their eventual cleanup before first acquisition. */
  defer(cleanup: () => void): void {
    this.#assertOpen();
    this.#cleanup.push(cleanup);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Native services are closed');
  }

  /** Keep proprietary receiver identity while protecting retained service handles.
   * Listener removals remain available during teardown; other late calls fail.
   * This guards methods, rather than assuming any particular native service ABI.
   */
  guardSession(session: NativeObject): NativeObject {
    return new Proxy(session, {
      get: (target, key) => {
        const member = Reflect.get(target, key);
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          this.#assertOpen();
          const value = Reflect.apply(member, target, args);
          if (
            typeof key !== 'string' ||
            !/^get.+Service$/.test(key) ||
            !value ||
            typeof value !== 'object'
          )
            return value;
          return new Proxy(value, {
            get: (serviceTarget, serviceKey) => {
              const method = Reflect.get(serviceTarget, serviceKey);
              if (typeof method !== 'function') return method;
              return (...serviceArgs: unknown[]) => {
                if (!(
                  typeof serviceKey === 'string' && /^removeKernel.+Listener$/.test(serviceKey)
                ))
                  this.#assertOpen();
                return Reflect.apply(method, serviceTarget, serviceArgs);
              };
            },
          });
        };
      },
    });
  }

  /** Bound for injection into feature modules without exporting mutable state. */
  readonly awaitAlive = async <T>(value: T | PromiseLike<T>): Promise<T> => {
    // Argument evaluation can synchronously close the Session. Observe a native
    // rejection even when no wait can be installed after that callback.
    const pending = Promise.resolve(value);
    if (this.signal.aborted) {
      void pending.catch(() => {});
      this.signal.throwIfAborted();
    }
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Native services closed during operation'));
      this.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([pending, stopped]);
      this.signal.throwIfAborted();
      return result;
    } finally {
      this.signal.removeEventListener('abort', abort);
    }
  };

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Detach the ledger before callbacks can reenter close. Every step is tried
    // once, and released resources/closures are not retained for the worker life.
    const steps = this.#cleanup.splice(0);
    cleanupAll(steps);
  }
}
