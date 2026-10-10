import type { Friend, FriendCategory } from '../../contracts/contacts.ts';
import type { GroupMember } from '../../contracts/groups.ts';
import {
  captureFriendCategories,
  projectFriendCategories,
  projectFriends,
} from './friend-categories.ts';
import { nativeResultError } from '../../errors.ts';
export interface BuddyDirectoryPort {
  getBuddyListV2?: (category: string, refresh: boolean, source: number) => unknown;
}
export interface ProfileDirectoryPort {
  getCoreAndBaseInfo?: (store: string, uids: string[]) => unknown;
}
export interface UidDirectoryPort {
  getUid?: (ids: string[]) => unknown;
}
export interface ContactDirectoryContext {
  signal: AbortSignal;
  version: string;
  getBuddyService(): BuddyDirectoryPort | null | undefined;
  getProfileService(): ProfileDirectoryPort | null | undefined;
  getUidService(): UidDirectoryPort | null | undefined;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Owns validated contact identities for one Session. Failed batches never commit
 * partial entries, and converted identifiers are intentionally not cached.
 */
export function createContactDirectory(context: ContactDirectoryContext) {
  const { signal, version, getBuddyService, getProfileService, getUidService, awaitAlive } =
    context;
  let closed = false;
  const uidCache = new Map<string, string>();
  const alive = () => {
    signal.throwIfAborted();
    if (closed) throw new Error('Contact directory is closed');
  };
  const buddyList = () => {
    alive();
    const service = getBuddyService();
    alive();
    const method = service?.getBuddyListV2;
    alive();
    if (typeof method !== 'function') throw new Error('Native service is missing getBuddyListV2');
    return Reflect.apply(method, service, ['0', true, 0]) as unknown;
  };
  const coreProfiles = (uids: string[]) => {
    alive();
    const service = getProfileService();
    alive();
    const method = service?.getCoreAndBaseInfo;
    alive();
    if (typeof method !== 'function')
      throw new Error('Native service is missing getCoreAndBaseInfo');
    return Reflect.apply(method, service, ['nodeStore', uids]) as unknown;
  };
  const convertUid = (id: string) => {
    alive();
    const service = getUidService();
    alive();
    const method = service?.getUid;
    alive();
    if (typeof method !== 'function') throw new Error('Native service is missing getUid');
    return Reflect.apply(method, service, [[id]]) as unknown;
  };
  const uidFor = async (id: string): Promise<string> => {
    alive();
    if (id.startsWith('u_')) return id;
    if (uidCache.has(id)) return uidCache.get(id)!;
    const converted = await awaitAlive(convertUid(id));
    alive();
    const mapping = field(converted, 'uidInfo');
    if (!(mapping instanceof Map) || !Map.prototype.has.call(mapping, id))
      throw new Error('Could not resolve user identifier');
    const uid: unknown = Map.prototype.get.call(mapping, id);
    if (typeof uid !== 'string' || !uid || uid.includes('*'))
      throw new Error('Could not resolve user identifier');
    alive();
    return uid;
  };
  const listFriendCategories = async (): Promise<FriendCategory[]> => {
    alive();
    if (!['7.0.2-53644', '3.2.32-52194', '9.9.33-52230'].includes(version))
      throw new Error('Buddy list signature not verified for this native version');
    const raw = await awaitAlive(buddyList());
    alive();
    const captured = captureFriendCategories(raw);
    const profiles = await awaitAlive(coreProfiles([...captured.uniqueUIDs]));
    const categories = projectFriendCategories(captured, profiles);
    alive();
    for (const category of categories)
      for (const friend of category.friends) uidCache.set(friend.userId, friend.uid);
    return categories;
  };
  const listFriends = async (): Promise<Friend[]> => {
    alive();
    // Windows 9.9.33 uses the same three-argument V2 contract in the pinned
    // upstream implementation; account-level Windows validation is pending.
    if (!['7.0.2-53644', '3.2.32-52194', '9.9.33-52230'].includes(version))
      throw new Error('Buddy list signature not verified for this native version');
    const result = await awaitAlive(buddyList());
    alive();
    // Pinned getBuddyListV2 returns GeneralCallResult as well as data.
    // An empty data array does not establish a successful query.
    const status = field(result, 'result');
    if (status !== 0) throw nativeResultError('Native buddy list query failed', { result: status });
    const data = field(result, 'data');
    if (!Array.isArray(data)) throw new Error('Invalid native buddy list');
    // List friends requires only membership IDs, not categorized metadata.
    const requested = Array.from(data).flatMap((category) => {
      const members = field(category, 'buddyUids');
      if (!Array.isArray(members)) throw new Error('Invalid native buddy list');
      return Array.from(members);
    });
    if (!requested.every((uid): uid is string => typeof uid === 'string' && uid.length > 0))
      throw new Error('Invalid native buddy UID');
    const uids = [...new Set(requested)];
    const profiles = await awaitAlive(coreProfiles(uids));
    const friends = projectFriends(uids, profiles);
    // A rejected batch must not leave usable entries from an earlier row.
    alive();
    for (const friend of friends) uidCache.set(friend.userId, friend.uid);
    return friends;
  };
  return {
    uidFor,
    listFriends,
    listFriendCategories,
    rememberMembers(members: readonly GroupMember[]) {
      alive();
      for (const member of members) uidCache.set(member.userId, member.uid);
    },
    close() {
      closed = true;
      uidCache.clear();
    },
  };
}
