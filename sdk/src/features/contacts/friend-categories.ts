import { nativeResultError } from '../../errors.ts';
import type { Friend, FriendCategory } from '../../contracts/contacts.ts';

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

/** Validate every requested profile before constructing any category projection. */
export function projectFriendCategories(
  captured: CapturedFriendCategories,
  profiles: unknown,
): FriendCategory[] {
  if (!(profiles instanceof Map)) throw new Error('Invalid native profile map');
  const friends = new Map<string, Friend>();
  for (const uid of captured.uniqueUIDs) {
    if (!profiles.has(uid)) throw new Error('Native buddy profiles are incomplete');
    const core = field(profiles.get(uid), 'coreInfo');
    const actualUid = field(core, 'uid'),
      userId = field(core, 'uin'),
      nickname = field(core, 'nick'),
      remark = field(core, 'remark');
    if (
      actualUid !== uid ||
      typeof userId !== 'string' ||
      !/^\d+$/.test(userId) ||
      typeof remark !== 'string' ||
      (nickname !== undefined && typeof nickname !== 'string')
    )
      throw new Error('Invalid native buddy profile');
    friends.set(uid, { uid, userId, nickname: nickname ?? '', remark });
  }
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
export function captureRenameFriendCategory(categoryId: unknown, name: unknown) {
  if (
    typeof categoryId !== 'number' ||
    !Number.isInteger(categoryId) ||
    categoryId < 0 ||
    categoryId > 0xffff_ffff
  )
    throw new Error('Friend category ID must be a uint32 number');
  return { categoryId, name: friendCategoryName(name) };
}
