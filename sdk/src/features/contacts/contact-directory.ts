import type { NativeObject as Native } from '../../native/native-object.ts';
import type { Friend, FriendCategory } from '../../contracts/contacts.ts';
import type { GroupMember } from '../../contracts/groups.ts';
import { captureFriendCategories, projectFriendCategories } from './friend-categories.ts';
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
    const converted = (await awaitAlive(convertUid(id))) as Native;
    alive();
    const uid = converted?.uidInfo?.get(id);
    if (typeof uid !== 'string' || !uid || uid.includes('*'))
      throw new Error('Could not resolve user identifier');
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
    const result = (await awaitAlive(buddyList())) as Native;
    alive();
    // Pinned getBuddyListV2 returns GeneralCallResult as well as data.
    // An empty data array does not establish a successful query.
    if (result?.result !== 0) throw nativeResultError('Native buddy list query failed', result);
    if (!Array.isArray(result?.data)) throw new Error('Invalid native buddy list');
    // Materialize holes before validation; flatMap/some would skip them.
    const categories = Array.from(result.data);
    if (categories.some((category) => !Array.isArray((category as Native)?.buddyUids)))
      throw new Error('Invalid native buddy list');
    const requested = categories.flatMap((category) => Array.from((category as Native).buddyUids));
    if (!requested.every((uid): uid is string => typeof uid === 'string' && uid.length > 0))
      throw new Error('Invalid native buddy UID');
    const uids = [...new Set<string>(requested)];
    const profiles = await awaitAlive(coreProfiles(uids));
    if (!(profiles instanceof Map)) throw new Error('Invalid native profile map');
    if (uids.some((uid) => !profiles.has(uid)))
      throw new Error('Native buddy profiles are incomplete');
    const friends = uids.map((uid): Friend => {
      const profile = profiles.get(uid);
      const core = profile?.coreInfo;
      if (
        !core ||
        typeof core !== 'object' ||
        Array.isArray(core) ||
        typeof core.uid !== 'string' ||
        !core.uid.trim() ||
        core.uid !== uid ||
        typeof core.uin !== 'string' ||
        !/^\d+$/.test(core.uin) ||
        typeof core.remark !== 'string' ||
        (core.nick !== undefined && typeof core.nick !== 'string')
      )
        throw new Error('Invalid native buddy profile');
      return { userId: core.uin, uid, nickname: core.nick ?? '', remark: core.remark };
    });
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
