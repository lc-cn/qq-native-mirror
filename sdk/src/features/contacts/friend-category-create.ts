import { nativeResultError } from '../../errors.ts';
import type { CreatedFriendCategory } from '../../types.ts';

export function friendCategoryName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Friend category name must be a nonblank string');
  return value;
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Native groupId is the identifier in NodeIModifyCategoryCallback. */
export function projectCreatedFriendCategory(value: unknown): CreatedFriendCategory {
  const result = field(value, 'result');
  if (result !== 0) throw nativeResultError('Native friend category creation failed', { result });
  const categoryId = field(value, 'groupId'),
    name = field(value, 'name');
  if (
    typeof categoryId !== 'number' ||
    !Number.isInteger(categoryId) ||
    categoryId < 0 ||
    categoryId > 0xffff_ffff ||
    typeof name !== 'string'
  )
    throw new Error('Invalid native friend category creation receipt');
  return { categoryId, name };
}

/** One dispatch; timeout/close after dispatch leaves its remote effect unknown. */
export async function createFriendCategory(
  name: string,
  dispatch: (name: string, members: undefined) => unknown,
  signal: AbortSignal,
): Promise<CreatedFriendCategory> {
  friendCategoryName(name);
  signal.throwIfAborted();
  let abort: () => void;
  let timer: ReturnType<typeof setTimeout>;
  const stopped = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new Error('Native services closed during friend category creation; remote effect unknown'),
      );
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(
      () => reject(new Error('Native friend category creation timed out; remote effect unknown')),
      5000,
    );
  });
  // A synchronous native callback can abort and then throw before race attaches.
  void stopped.catch(() => {});
  try {
    // The native wrapper asserts argc == 2, including this explicit undefined.
    const pending = Promise.resolve(dispatch(name, undefined));
    const result = await Promise.race([pending, stopped]);
    signal.throwIfAborted();
    return projectCreatedFriendCategory(result);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', abort!);
  }
}
