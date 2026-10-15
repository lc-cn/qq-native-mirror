import { waitWithSignal } from '../runtime/abort.ts';

const pending = new Map<string, Promise<void>>();

/** Serialize this process's installers for one immutable cache target. A waiting
 * caller may leave immediately, but its queue slot cannot release a successor
 * past an active predecessor. Active work owns and awaits its own cleanup.
 */
export async function runNativeInstallation<T>(
  target: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const previous = pending.get(target) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => released);
  pending.set(target, tail);
  const remove = () => {
    if (pending.get(target) === tail) pending.delete(target);
  };
  void tail.then(remove, remove);
  try {
    await waitWithSignal(previous, signal);
    signal?.throwIfAborted();
    const result = await task();
    signal?.throwIfAborted();
    return result;
  } finally {
    release();
  }
}
