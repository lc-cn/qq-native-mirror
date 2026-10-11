import { normalizeKernelError } from '../errors.ts';

/** Consume work started without a returned Promise, in the parent or worker.
 * Expected operation failures settle through their owner. Only an escaping
 * failure (such as an error observer throwing) reaches this terminal exit.
 * Defer its exception until current Promise settlements run; never notify the
 * failing observer again or replay the operation. Ordinary Error identity is
 * preserved; opaque thrown values use the existing safe error projection.
 * Node's default uncaught-exception path exits the process, even in rejection
 * warning mode. This module installs no process exception or rejection handler.
 */
export function observeBackgroundTask(task: Promise<unknown>): void {
  void task.catch((error: unknown) => {
    setImmediate(() => {
      throw normalizeKernelError(error);
    });
  });
}
