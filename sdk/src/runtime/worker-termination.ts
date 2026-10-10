import type { ChildProcess } from 'node:child_process';

export interface WorkerTerminationOptions {
  /** Preserve the owning lifecycle's operation-specific timeout description. */
  timeoutMessage?: string;
  /** A successful close acknowledgement promises voluntary process exit.
   * Give its synchronous exit cleanup a grace period before force termination.
   */
  waitForExit?: boolean;
  forceDelayMs?: number;
  deadlineMs?: number;
}

/** Stops one worker, escalating once to SIGKILL. Every terminal path removes
 * its listener and timers; synchronous kill failures retain their original value.
 * No replacement, retry or account policy belongs to this transport operation.
 */
export function terminateWorker(
  worker: ChildProcess,
  options: WorkerTerminationOptions = {},
): Promise<void> {
  if (worker.exitCode != null || worker.signalCode != null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failure?: { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      clearTimeout(deadline);
      worker.removeListener('exit', exited);
      if (failure) reject(failure.error);
      else resolve();
    };
    const exited = () => finish();
    worker.once('exit', exited);
    const force = setTimeout(() => {
      if (settled) return;
      try {
        worker.kill('SIGKILL');
      } catch (error) {
        finish({ error });
      }
    }, options.forceDelayMs ?? 2000);
    const deadline = setTimeout(
      () =>
        finish({
          error: new Error(options.timeoutMessage ?? 'Native worker did not exit after shutdown'),
        }),
      options.deadlineMs ?? 4000,
    );
    if (!options.waitForExit) {
      try {
        worker.kill();
      } catch (error) {
        finish({ error });
      }
    }
  });
}
