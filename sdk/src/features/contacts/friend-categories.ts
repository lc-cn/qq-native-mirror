import { sendUserId } from '../../validation/identifiers.ts';
import { nativeResultError } from '../../errors.ts';
import type { Friend, FriendCategory, FriendCategoryOrderEntry } from '../../contracts/contacts.ts';

interface CapturedCategory {
  categoryId: number;
  sortId: number;
  name: string;
  memberCount: number;
  onlineCount: number;
  uids: readonly string[];
}
export interface CapturedFriendCategories {
  readonly categories: readonly Readonly<CapturedCategory>[];
  readonly uniqueUIDs: readonly string[];
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function integer(value: unknown, count = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && (!count || value >= 0);
}

/** Pinned Buddy V2 category fields retain their upstream spelling at this boundary. */
export function captureFriendCategories(rawV2Result: unknown): CapturedFriendCategories {
  const result = field(rawV2Result, 'result');
  if (result !== 0) throw nativeResultError('Native buddy list query failed', { result });
  const data = field(rawV2Result, 'data');
  if (!Array.isArray(data)) throw new Error('Invalid native buddy categories');
  const categories = Array.from(data, (raw) => {
    const categoryId = field(raw, 'categoryId'),
      sortId = field(raw, 'categorySortId');
    const name = field(raw, 'categroyName'),
      memberCount = field(raw, 'categroyMbCount'),
      onlineCount = field(raw, 'onlineCount');
    const members = field(raw, 'buddyUids');
    if (
      !integer(categoryId) ||
      !integer(sortId) ||
      typeof name !== 'string' ||
      !integer(memberCount, true) ||
      !integer(onlineCount, true) ||
      !Array.isArray(members)
    )
      throw new Error('Invalid native buddy category');
    const uids = Array.from(members, (uid) => {
      if (typeof uid !== 'string' || !uid.trim()) throw new Error('Invalid native buddy UID');
      return uid;
    });
    return Object.freeze({
      categoryId,
      sortId,
      name,
      memberCount,
      onlineCount,
      uids: Object.freeze(uids),
    });
  });
  return Object.freeze({
    categories: Object.freeze(categories),
    uniqueUIDs: Object.freeze([...new Set(categories.flatMap((category) => [...category.uids]))]),
  });
}

/** Validate the complete requested profile batch before exposing any friend. */
export function projectFriends(uids: readonly string[], profiles: unknown): Friend[] {
  if (!(profiles instanceof Map)) throw new Error('Invalid native profile map');
  const friends = new Map<string, Friend>();
  for (const uid of uids) {
    if (!Map.prototype.has.call(profiles, uid))
      throw new Error('Native buddy profiles are incomplete');
    const core = field(Map.prototype.get.call(profiles, uid), 'coreInfo');
    const actualUid = field(core, 'uid'),
      userId = field(core, 'uin'),
      nickname = field(core, 'nick'),
      remark = field(core, 'remark');
    if (
      typeof actualUid !== 'string' ||
      !actualUid.trim() ||
      actualUid !== uid ||
      typeof userId !== 'string' ||
      !/^\d+$/.test(userId) ||
      typeof remark !== 'string' ||
      (nickname !== undefined && typeof nickname !== 'string')
    )
      throw new Error('Invalid native buddy profile');
    friends.set(uid, { uid, userId, nickname: nickname ?? '', remark });
  }
  return [...friends.values()];
}

/** Category metadata and duplicate memberships retain their separate contract. */
export function projectFriendCategories(
  captured: CapturedFriendCategories,
  profiles: unknown,
): FriendCategory[] {
  const friends = new Map(
    projectFriends(captured.uniqueUIDs, profiles).map((friend) => [friend.uid, friend]),
  );
  return captured.categories.map((category) => ({
    categoryId: category.categoryId,
    sortId: category.sortId,
    name: category.name,
    memberCount: category.memberCount,
    onlineCount: category.onlineCount,
    friends: category.uids.map((uid) => ({ ...friends.get(uid)! })),
  }));
}

export function friendCategoryName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Friend category name must be a nonblank string');
  return value;
}

/** Category selectors inhabit the uint32 namespace; zero is not assumed mutable. */
export function captureFriendCategoryId(categoryId: unknown): number {
  if (
    typeof categoryId !== 'number' ||
    !Number.isInteger(categoryId) ||
    categoryId < 0 ||
    categoryId > 0xffff_ffff
  )
    throw new Error('Friend category ID must be a uint32 number');
  return categoryId;
}

export function captureRenameFriendCategory(categoryId: unknown, name: unknown) {
  return { categoryId: captureFriendCategoryId(categoryId), name: friendCategoryName(name) };
}

/** Capture every explicit row before acquisition. Names are preserved, never inferred or refreshed. */
export function captureFriendCategoryOrder(value: unknown): readonly FriendCategoryOrderEntry[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Friend category order must be a nonempty array');
  const ids = new Set<number>();
  const rows: FriendCategoryOrderEntry[] = [];
  const length = value.length;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor))
      throw new Error('Friend category order requires dense data rows');
    const row: unknown = descriptor.value;
    const categoryId = captureFriendCategoryId(field(row, 'categoryId'));
    const name = field(row, 'name');
    if (typeof name !== 'string') throw new Error('Friend category order requires string names');
    if (ids.has(categoryId)) throw new Error('Friend category order contains duplicate IDs');
    ids.add(categoryId);
    rows.push(Object.freeze({ categoryId, name }));
  }
  return Object.freeze(rows);
}

/** Capture public identity and measured category selector before UID lookup. */
export function captureFriendCategoryAssignment(userId: unknown, categoryId: unknown) {
  return { userId: sendUserId(userId), categoryId: captureFriendCategoryId(categoryId) };
}
