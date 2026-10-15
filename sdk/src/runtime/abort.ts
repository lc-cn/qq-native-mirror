/** Cancel only this wait. The underlying work remains observed and is not owned
 * by the waiter; its eventual rejection must never become unhandled.
 */
export function waitWithSignal<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(work);
  const observed = Promise.resolve(work);
  if (signal.aborted) {
    void observed.then(
      () => {},
      () => {},
    );
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      complete();
    };
    const aborted = () => finish(() => reject(signal.reason));
    // Observe before checking the signal, including a pre-aborted caller.
    observed.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
