import { nativeResultError } from '../../errors.ts';

/** Single native ACK wait. A dispatched write is never retried; cancellation leaves its effect unknown. */
export async function completeFriendCategoryMutation(
  action: 'rename' | 'delete' | 'reorder' | 'assignment',
  dispatch: () => unknown,
  signal: AbortSignal,
): Promise<void> {
  let dispatched = false;
  const completionAlive = () => {
    if (signal.aborted)
      throw new Error(
        `Native services closed during friend category ${action}; remote effect unknown`,
      );
  };
  let abort!: () => void;
  let timer!: ReturnType<typeof setTimeout>;
  const stopped = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        dispatched
          ? new Error(
              `Native services closed during friend category ${action}; remote effect unknown`,
            )
          : signal.reason,
      );
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(
      () => reject(new Error(`Native friend category ${action} timed out; remote effect unknown`)),
      5000,
    );
  });
  void stopped.catch(() => {});
  try {
    signal.throwIfAborted();
    dispatched = true;
    const pending = Promise.resolve(dispatch());
    const result = await Promise.race([pending, stopped]);
    completionAlive();
    let code: unknown;
    try {
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const descriptor = Object.getOwnPropertyDescriptor(result, 'result');
        if (descriptor && 'value' in descriptor) code = descriptor.value;
      }
    } catch {
      completionAlive();
      throw nativeResultError(`Invalid native friend category ${action} result`, {});
    }
    completionAlive();
    if (
      typeof code !== 'number' ||
      !Number.isInteger(code) ||
      code < -0x8000_0000 ||
      code > 0x7fff_ffff
    )
      throw nativeResultError(`Invalid native friend category ${action} result`, {});
    if (code !== 0)
      throw nativeResultError(`Native friend category ${action} failed`, { result: code });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
