import {
  captureFriendCategoryId,
  captureFriendCategoryOrder,
  captureRenameFriendCategory,
  friendCategoryName,
} from './friend-category-input.ts';
import { createFriendCategory } from './friend-category-create.ts';
import type { CreatedFriendCategory } from '../../contracts/contacts.ts';
import { completeFriendCategoryMutation } from './friend-category-completion.ts';

export interface FriendCategoryMutationsPort {
  addCategoryV2?(name: string, members: undefined): unknown;
  renameCategory?(categoryId: number, name: string): unknown;
  delCategory?(categoryId: number): unknown;
  resortCategory?(categories: Array<{ categoryId: number; categroyName: string }>): unknown;
}
export interface FriendCategoryMutationsContext {
  getBuddyService(): FriendCategoryMutationsPort | null | undefined;
  signal: AbortSignal;
  canCreate(): boolean;
  canRename(): boolean;
  canDelete(): boolean;
  canReorder(): boolean;
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
    request:
      | { action: 'rename'; args: [number, string] }
      | { action: 'delete'; args: [number] }
      | { action: 'reorder'; args: [Array<{ categoryId: number; categroyName: string }>] },
  ): Promise<void> {
    const { action, args } = request;
    alive();
    const supported =
      action === 'rename'
        ? context.canRename()
        : action === 'delete'
          ? context.canDelete()
          : context.canReorder();
    alive();
    if (!supported)
      throw Object.assign(
        new Error(`Friend category ${action} contract is not verified for this native binary`),
        { code: 'unsupported-native-contract' },
      );
    const service = context.getBuddyService();
    alive();
    const methodName =
      action === 'rename'
        ? 'renameCategory'
        : action === 'delete'
          ? 'delCategory'
          : 'resortCategory';
    const method = service?.[methodName];
    alive();
    if (typeof method !== 'function') throw new Error(`Missing native method ${methodName}`);
    return completeFriendCategoryMutation(
      action,
      () => Reflect.apply(method, service, args) as unknown,
      signal,
    );
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
    async reorder(categories: unknown): Promise<void> {
      const captured = captureFriendCategoryOrder(categories);
      // Keep the measured upstream typo private; the native vector includes names and array ordinals.
      return mutate({
        action: 'reorder',
        args: [captured.map(({ categoryId, name }) => ({ categoryId, categroyName: name }))],
      });
    },
    close(): void {
      if (!local.signal.aborted)
        local.abort(new Error('Native friend category mutations are closed'));
    },
  };
}
