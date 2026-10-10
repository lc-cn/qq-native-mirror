import { nativeResultError } from '../errors.ts';

interface Waiter {
  event: string;
  check(args: unknown[]): unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  stop(error: unknown): void;
}

/** Correlates callbacks without treating callback success as native completion.
 * Failures interrupt a pending invocation; successes wait for its fulfillment.
 * There is no retry, and cleanup removes every timer and abort listener.
 */
export function createNativeEventChannel(signal: AbortSignal) {
  const waiters = new Set<Waiter>();
  const active = new Set<Waiter>();
  let closed = false;
  const closedError = () => new Error('Client closed during native operation');
  return {
    dispatch(event: string, args: unknown[]): void {
      for (const waiter of [...waiters]) {
        if (!waiters.has(waiter) || waiter.event !== event) continue;
        try {
          const value = waiter.check(args);
          if (value !== undefined) {
            waiters.delete(waiter);
            waiter.resolve(value);
          }
        } catch (error) {
          waiters.delete(waiter);
          waiter.reject(error);
        }
      }
    },
    async call<Args extends unknown[], Value>(
      event: string,
      check: (...args: Args) => Value | undefined,
      invoke: () => unknown,
      timeoutMs = 10_000,
      checkReturn?: (value: unknown) => boolean,
      requestSignal?: AbortSignal,
    ): Promise<Value> {
      signal.throwIfAborted();
      requestSignal?.throwIfAborted();
      if (closed) throw closedError();
      const activeSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      let stop!: (error: unknown) => void;
      const stopped = new Promise<never>((_, reject) => {
        stop = reject;
      });
      void stopped.catch(() => {});
      let waiter!: Waiter;
      const result = new Promise<unknown>((resolve, reject) => {
        waiter = { event, check: (args) => check(...(args as Args)), resolve, reject, stop };
      });
      void result.catch(() => {});
      const failed = result.then(() => new Promise<never>(() => {}));
      void failed.catch(() => {});
      const abort = () => {
        // Retire correlation synchronously: a native callback may run again
        // before the rejected invocation resumes its finally block.
        waiters.delete(waiter);
        stop(signal.aborted ? closedError() : requestSignal?.reason);
      };
      activeSignal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        const error = new Error(`Native operation timed out: ${event}`);
        waiter.reject(error);
        stop(error);
      }, timeoutMs);
      waiters.add(waiter);
      active.add(waiter);
      try {
        const returned = await Promise.race([
          new Promise<unknown>((resolve) => resolve(invoke())),
          failed,
          stopped,
        ]);
        activeSignal.throwIfAborted();
        if (closed) throw closedError();
        if (checkReturn && !checkReturn(returned))
          throw nativeResultError(`Native operation rejected: ${event}`, returned);
        const value = await Promise.race([result, stopped]);
        activeSignal.throwIfAborted();
        if (closed) throw closedError();
        return value as Value;
      } catch (error) {
        waiter.reject(error);
        throw error;
      } finally {
        waiters.delete(waiter);
        active.delete(waiter);
        clearTimeout(timer);
        activeSignal.removeEventListener('abort', abort);
      }
    },
    close(): void {
      closed = true;
      for (const waiter of active) {
        const error = closedError();
        waiter.reject(error);
        waiter.stop(error);
      }
      waiters.clear();
    },
  };
}

export type NativeEventChannel = ReturnType<typeof createNativeEventChannel>;
