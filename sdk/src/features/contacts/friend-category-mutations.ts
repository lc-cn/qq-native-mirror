import {
  captureFriendCategoryId,
  captureRenameFriendCategory,
  friendCategoryName,
} from './friend-categories.ts';
import { createFriendCategory } from './friend-category-create.ts';
import type { CreatedFriendCategory } from '../../contracts/contacts.ts';
import { nativeResultError } from '../../errors.ts';

export interface FriendCategoryMutationsPort {
  addCategoryV2?(name: string, members: undefined): unknown;
  renameCategory?(categoryId: number, name: string): unknown;
  delCategory?(categoryId: number): unknown;
}
export interface FriendCategoryMutationsContext {
  getBuddyService(): FriendCategoryMutationsPort | null | undefined;
  signal: AbortSignal;
  canCreate(): boolean;
  canRename(): boolean;
  canDelete(): boolean;
}

/** Exact supported selectors are statically bound to list categoryId.
 * Completion is native ACK only, not verification of remote category state. Once dispatched,
 * cancellation/deadline leave remote effects unknown and do not replay writes.
 */
export function createFriendCategoryMutations(context: FriendCategoryMutationsContext) {
  const local = new AbortController();
  const signal = AbortSignal.any([context.signal, local.signal]);
  const alive = () => signal.throwIfAborted();
  async function mutate(
    request: { action: 'rename'; args: [number, string] } | { action: 'delete'; args: [number] },
  ): Promise<void> {
    const { action, args } = request;
    alive();
    const supported = action === 'rename' ? context.canRename() : context.canDelete();
    alive();
    if (!supported)
      throw Object.assign(
        new Error(`Friend category ${action} contract is not verified for this native binary`),
        { code: 'unsupported-native-contract' },
      );
    const service = context.getBuddyService();
    alive();
    const method = action === 'rename' ? service?.renameCategory : service?.delCategory;
    alive();
    if (typeof method !== 'function')
      throw new Error(
        `Missing native method ${action === 'rename' ? 'renameCategory' : 'delCategory'}`,
      );
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
        () =>
          reject(new Error(`Native friend category ${action} timed out; remote effect unknown`)),
        5000,
      );
    });
    void stopped.catch(() => {});
    try {
      alive();
      dispatched = true;
      const pending = Promise.resolve(Reflect.apply(method, service, args) as unknown);
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
  return {
    async create(name: unknown): Promise<CreatedFriendCategory> {
      const captured = friendCategoryName(name);
      alive();
      const supported = context.canCreate();
      alive();
      if (!supported)
        throw new Error('Friend category creation contract is not verified for this native binary');
      const service = context.getBuddyService();
      alive();
      const method = service?.addCategoryV2;
      alive();
      if (typeof method !== 'function') throw new Error('Native service is missing addCategoryV2');
      return createFriendCategory(
        captured,
        (value, members) => Reflect.apply(method, service, [value, members]) as unknown,
        signal,
      );
    },
    async rename(categoryId: unknown, name: unknown): Promise<void> {
      const captured = captureRenameFriendCategory(categoryId, name);
      return mutate({ action: 'rename', args: [captured.categoryId, captured.name] });
    },
    async delete(categoryId: unknown): Promise<void> {
      return mutate({ action: 'delete', args: [captureFriendCategoryId(categoryId)] });
    },
    close(): void {
      if (!local.signal.aborted)
        local.abort(new Error('Native friend category mutations are closed'));
    },
  };
}
