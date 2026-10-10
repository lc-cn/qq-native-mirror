/** Pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * listeners/NodeIKernelBuddyListener.ts: onBuddyListChange(BuddyCategoryType[]);
 * types/user.ts: BuddyCategoryType and User. Other Buddy callbacks are unknown.
 * This notification has no full-list marker or relationship-change cause.
 */
import type {
  FriendChange,
  FriendCategoryChange,
  FriendListUpdate,
} from '../../contracts/contacts.ts';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function friend(value: unknown): FriendChange | undefined {
  const raw = object(value);
  if (
    !raw ||
    typeof raw.uid !== 'string' ||
    !raw.uid.trim() ||
    typeof raw.uin !== 'string' ||
    !/^\d+$/.test(raw.uin) ||
    typeof raw.nick !== 'string'
  )
    return;
  const result: FriendChange = { uid: raw.uid, userId: raw.uin, nickname: raw.nick };
  if (raw.remark !== undefined) {
    if (typeof raw.remark !== 'string') return;
    result.remark = raw.remark;
  }
  return result;
}
function category(value: unknown): FriendCategoryChange | undefined {
  const raw = object(value);
  if (
    !raw ||
    typeof raw.categoryId !== 'number' ||
    !Number.isSafeInteger(raw.categoryId) ||
    typeof raw.categoryName !== 'string' ||
    typeof raw.categoryMbCount !== 'number' ||
    !Number.isSafeInteger(raw.categoryMbCount) ||
    raw.categoryMbCount < 0 ||
    !Array.isArray(raw.buddyList)
  )
    return;
  const friends = Array.from(raw.buddyList, friend);
  if (friends.some((value) => value === undefined)) return;
  return {
    categoryId: raw.categoryId,
    name: raw.categoryName,
    memberCount: raw.categoryMbCount,
    friends: friends as FriendChange[],
  };
}
export function createFriendEvents(emit: (event: string, payload: unknown) => void) {
  return {
    onBuddyListChange(values: unknown): void {
      const invalid = () => emit('diagnostic', { stage: 'invalid-native-friend-list-update' });
      if (!Array.isArray(values)) {
        invalid();
        return;
      }
      const categories = Array.from(values, category);
      if (categories.some((value) => value === undefined)) {
        invalid();
        return;
      }
      const update: FriendListUpdate = { categories: categories as FriendCategoryChange[] };
      emit('friend-list-updated', update);
    },
  };
}
