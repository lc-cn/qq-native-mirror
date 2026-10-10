import { captureRenameFriendCategory } from './friend-categories.ts';
import { nativeResultError } from '../../errors.ts';

export interface FriendCategoryRenamePort {
  renameCategory?(categoryId: number, name: string): unknown;
}
export interface FriendCategoryRenameContext {
  getBuddyService(): FriendCategoryRenamePort | null | undefined;
  signal: AbortSignal;
}

/** Exact Linux default selectors are statically bound to list categoryId.
 * Completion is native ACK only, never a server-name receipt. Once dispatched,
 * cancellation/deadline leave remote effects unknown and do not replay writes.
 */
export function createFriendCategoryRename(context: FriendCategoryRenameContext) {
  const local = new AbortController();
  const signal = AbortSignal.any([context.signal, local.signal]);
  const alive = () => signal.throwIfAborted();
  return {
    async rename(categoryId: number, name: string): Promise<void> {
      const captured = captureRenameFriendCategory(categoryId, name);
      alive();
      const service = context.getBuddyService();
      alive();
      const method = service?.renameCategory;
      alive();
      if (typeof method !== 'function') throw new Error('Missing native method renameCategory');
      let dispatched = false;
      const completionAlive = () => {
        if (signal.aborted)
          throw new Error(
            'Native services closed during friend category rename; remote effect unknown',
          );
      };
      let abort!: () => void;
      let timer!: ReturnType<typeof setTimeout>;
      const stopped = new Promise<never>((_, reject) => {
        abort = () =>
          reject(
            dispatched
              ? new Error(
                  'Native services closed during friend category rename; remote effect unknown',
                )
              : signal.reason,
          );
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(
          () => reject(new Error('Native friend category rename timed out; remote effect unknown')),
          5000,
        );
      });
      void stopped.catch(() => {});
      try {
        alive();
        dispatched = true;
        const pending = Promise.resolve(
          Reflect.apply(method, service, [captured.categoryId, captured.name]) as unknown,
        );
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
          throw nativeResultError('Invalid native friend category rename result', {});
        }
        completionAlive();
        if (
          typeof code !== 'number' ||
          !Number.isInteger(code) ||
          code < -0x8000_0000 ||
          code > 0x7fff_ffff
        )
          throw nativeResultError('Invalid native friend category rename result', {});
        if (code !== 0)
          throw nativeResultError('Native friend category rename failed', { result: code });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
    close(): void {
      if (!local.signal.aborted) local.abort(new Error('Native friend category rename is closed'));
    },
  };
}
