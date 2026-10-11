import { captureFriendCategoryAssignment } from './friend-categories.ts';
import { completeFriendCategoryMutation } from './friend-category-completion.ts';

export interface FriendCategoryAssignmentPort {
  setBuddyCategory?(uid: string, categoryId: number): unknown;
}
export interface FriendCategoryAssignmentContext {
  canAssign(): boolean;
  resolveUid(userId: string): Promise<string>;
  awaitAlive<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T>;
  getBuddyService(): FriendCategoryAssignmentPort | null | undefined;
  signal: AbortSignal;
}

/** Owns one UID-resolution and one assignment dispatch per invocation, without readback or replay. */
export function createFriendCategoryAssignment(context: FriendCategoryAssignmentContext) {
  const local = new AbortController();
  const signal = AbortSignal.any([context.signal, local.signal]);
  const alive = () => signal.throwIfAborted();
  return {
    async assign(userId: unknown, categoryId: unknown): Promise<void> {
      const captured = captureFriendCategoryAssignment(userId, categoryId);
      alive();
      const supported = context.canAssign();
      alive();
      if (!supported)
        throw Object.assign(
          new Error('Friend category assignment contract is not verified for this native binary'),
          { code: 'unsupported-native-contract' },
        );
      const uid = await context.awaitAlive(context.resolveUid(captured.userId), signal);
      alive();
      if (typeof uid !== 'string' || !uid.trim()) throw new Error('Invalid native friend UID');
      const service = context.getBuddyService();
      alive();
      const method = service?.setBuddyCategory;
      alive();
      if (typeof method !== 'function') throw new Error('Missing native method setBuddyCategory');
      return completeFriendCategoryMutation(
        'assignment',
        () => Reflect.apply(method, service, [uid, captured.categoryId]) as unknown,
        signal,
      );
    },
    close(): void {
      if (!local.signal.aborted)
        local.abort(new Error('Native friend category assignment is closed'));
    },
  };
}
