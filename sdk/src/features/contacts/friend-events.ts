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
/** Native projections consume own data only. Accessors and descriptor traps
 * belong to the malformed-input boundary, never to callback presentation.
 */
function dataField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor)) throw new Error('Invalid native friend field');
  return descriptor?.value;
}
function array(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return;
  const length = dataField(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return;
    result.push(descriptor.value);
  }
  return result;
}
function friend(value: unknown): FriendChange | undefined {
  const raw = object(value);
  if (!raw) return;
  const uid = dataField(raw, 'uid');
  const userId = dataField(raw, 'uin');
  const nickname = dataField(raw, 'nick');
  if (
    typeof uid !== 'string' ||
    !uid.trim() ||
    typeof userId !== 'string' ||
    !/^\d+$/.test(userId) ||
    typeof nickname !== 'string'
  )
    return;
  const result: FriendChange = { uid, userId, nickname };
  const remark = dataField(raw, 'remark');
  if (remark !== undefined) {
    if (typeof remark !== 'string') return;
    result.remark = remark;
  }
  return result;
}
function category(value: unknown): FriendCategoryChange | undefined {
  const raw = object(value);
  if (!raw) return;
  const categoryId = dataField(raw, 'categoryId');
  const name = dataField(raw, 'categoryName');
  const memberCount = dataField(raw, 'categoryMbCount');
  const buddies = array(dataField(raw, 'buddyList'));
  if (
    typeof categoryId !== 'number' ||
    !Number.isSafeInteger(categoryId) ||
    typeof name !== 'string' ||
    typeof memberCount !== 'number' ||
    !Number.isSafeInteger(memberCount) ||
    memberCount < 0 ||
    !buddies
  )
    return;
  const friends = buddies.map(friend);
  if (friends.some((value) => value === undefined)) return;
  return {
    categoryId,
    name,
    memberCount,
    friends: friends as FriendChange[],
  };
}
export function createFriendEvents(emit: (event: string, payload: unknown) => void) {
  return {
    onBuddyListChange(values: unknown): void {
      let categories: (FriendCategoryChange | undefined)[] | undefined;
      try {
        categories = array(values)?.map(category);
      } catch {
        // Native field/descriptor failures emit no payload or exception details.
      }
      if (!categories || categories.some((value) => value === undefined)) {
        emit('diagnostic', { stage: 'invalid-native-friend-list-update' });
        return;
      }
      const update: FriendListUpdate = { categories: categories as FriendCategoryChange[] };
      emit('friend-list-updated', update);
    },
  };
}
