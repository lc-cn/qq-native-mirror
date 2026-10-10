import { normalizeKernelError } from '../errors.ts';

/** Observe work started by IPC, a native callback or a timer in the isolated worker.
 * Expected failures settle through the task's owner. A rejection escaping that
 * owner (for example, a throwing failure observer) is fatal: continuing would
 * retain an account whose event delivery is no longer reliable. Defer the throw
 * until current Promise settlements run; never notify the failing observer again.
 * Node's default uncaught-exception path exits the worker and releases its locks.
 */
export function observeWorkerTask(task: Promise<unknown>): void {
  void task.catch((error: unknown) => {
    setImmediate(() => {
      throw normalizeKernelError(error);
    });
  });
}
