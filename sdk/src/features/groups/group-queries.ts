import type { NativeObject as Native } from '../../native/native-object.ts';
import type {
  Group,
  GroupInfoUpdate,
  GroupMutedMember,
  GroupMember,
} from '../../contracts/groups.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';
import { nativeResultError } from '../../errors.ts';
import { projectGroupInfo } from './group-events.ts';
import { projectGroupMuteList } from './group-mute-list.ts';
export interface GroupQueriesContext {
  signal: AbortSignal;
  service(name: string): Native;
  call(object: Native, name: string, ...args: unknown[]): unknown;
  eventCall: NativeEventChannel['call'];
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
  commitMembers(members: readonly GroupMember[]): void;
}
/** Owns query coalescing and quarantine for callbacks without request nonces.
 * Validated member batches commit atomically; no native calls occur during construction.
 * The composition aborts its Session signal before closing this module.
 */
export function createGroupQueries(context: GroupQueriesContext) {
  const { signal, service, call: invoke, eventCall, awaitAlive, commitMembers } = context;
  let closed = false;
  const alive = () => {
    signal.throwIfAborted();
    if (closed) throw new Error('Group queries are closed');
  };
  const call = (object: Native, name: string, ...args: unknown[]) => {
    alive();
    return invoke(object, name, ...args);
  };
  const nativeCallSucceeded = (value: unknown) =>
    (value as { result?: unknown } | null | undefined)?.result === 0;
  let groupListRequest: Promise<Group[]> | undefined;
  let groupListInvalidated = false;
  const groupInfoQueries = new Map<string, Promise<GroupInfoUpdate>>();
  const invalidGroupInfoQueries = new Set<string>();
  const getGroupInfo = async (id: string): Promise<GroupInfoUpdate> => {
    alive();
    if (invalidGroupInfoQueries.has(id))
      throw new Error('Group detail query channel is invalid; recreate the Session');
    let pending = groupInfoQueries.get(id);
    if (!pending) {
      pending = eventCall(
        'Group/onGroupDetailInfoChange',
        (raw: unknown) => {
          if (
            raw === null ||
            typeof raw !== 'object' ||
            Object.getOwnPropertyDescriptor(raw, 'groupCode')?.value !== id
          )
            return;
          return projectGroupInfo(raw);
        },
        () => call(service('Group'), 'getGroupDetailInfo', id, 2),
        5000,
        nativeCallSucceeded,
      )
        .catch((error) => {
          invalidGroupInfoQueries.add(id);
          throw error;
        })
        .finally(() => {
          groupInfoQueries.delete(id);
        });
      groupInfoQueries.set(id, pending);
    }
    const value = await pending;
    alive();
    return { ...value };
  };
  const groupMuteQueries = new Map<string, Promise<GroupMutedMember[]>>();
  const invalidGroupMuteQueries = new Set<string>();
  const listGroupMutedMembers = async (id: string): Promise<GroupMutedMember[]> => {
    alive();
    if (invalidGroupMuteQueries.has(id))
      throw new Error('Group mute-list query channel is invalid; recreate the Session');
    let pending = groupMuteQueries.get(id);
    if (!pending) {
      pending = eventCall(
        'Group/onShutUpMemberListChanged',
        (groupId: unknown, members: unknown) => {
          if (groupId !== id) return;
          return projectGroupMuteList(members);
        },
        () => call(service('Group'), 'getGroupShutUpMemberList', id),
        5000,
        nativeCallSucceeded,
      )
        .catch((error) => {
          invalidGroupMuteQueries.add(id);
          throw error;
        })
        .finally(() => {
          groupMuteQueries.delete(id);
        });
      groupMuteQueries.set(id, pending);
    }
    const value = await pending;
    alive();
    return value.map((member) => ({ ...member }));
  };
  const listGroups = async (refresh: unknown = true): Promise<Group[]> => {
    alive();
    if (groupListInvalidated)
      throw new Error('Group list query channel invalidated; create a new Session');
    if (groupListRequest) {
      const value = await groupListRequest;
      alive();
      return value;
    }
    const request = eventCall(
      'Group/onGroupListUpdate',
      (update: number, groups: Native[]) => {
        // Source: NapCatQQ packages/napcat-core/types/group.ts GroupListUpdateType.
        // REFRESHALL=0 and GETALL=1 are full lists; MODIFIED/REMOVE and new native
        // update kinds can carry partial or empty deltas. Never return those.
        if (update !== 0 && update !== 1) return undefined;
        if (!Array.isArray(groups)) throw new Error('Invalid native group list');
        return Array.from(groups, (group): Group => {
          if (
            !group ||
            typeof group !== 'object' ||
            Array.isArray(group) ||
            typeof group.groupCode !== 'string' ||
            !/^\d+$/.test(group.groupCode) ||
            typeof group.groupName !== 'string' ||
            !Number.isSafeInteger(group.memberCount) ||
            group.memberCount < 0 ||
            !Number.isSafeInteger(group.maxMember) ||
            group.maxMember < 0
          )
            throw new Error('Invalid native group list');
          return {
            groupId: group.groupCode,
            name: group.groupName,
            memberCount: group.memberCount,
            maxMemberCount: group.maxMember,
          };
        });
      },
      () => call(service('Group'), 'getGroupList', refresh ?? true),
      10_000,
      nativeCallSucceeded,
    );
    groupListRequest = request;
    try {
      const value = await request;
      alive();
      return value;
    } catch (error) {
      groupListInvalidated = true;
      throw error;
    } finally {
      if (groupListRequest === request) groupListRequest = undefined;
    }
  };
  const getGroupMembers = async (
    groupId: string,
    refresh: unknown = false,
  ): Promise<GroupMember[]> => {
    alive();
    refresh = refresh ?? false;
    if (typeof refresh !== 'boolean') throw new Error('refresh must be a boolean');
    const result = (await awaitAlive(
      call(service('Group'), 'getAllMemberList', groupId, refresh),
    )) as Native;
    // Pinned NodeIKernelGroupService.getAllMemberList reports errCode and
    // finish:true. A Map alone does not establish a successful full list.
    if (result?.errCode !== 0)
      throw nativeResultError('Native group member query failed', result, 'errCode');
    const infos = result?.result?.infos;
    if (!(infos instanceof Map)) throw new Error('Invalid native group member map');
    if (result.result.finish !== true)
      throw Object.assign(new Error('Native group member list is incomplete'), {
        code: 'incomplete-result',
      });
    const members = [...infos.entries()].map(([uid, member]): GroupMember => {
      // Pinned GroupMember identity and display fields are strings. Do not
      // invent an identity by coercing a number/object or substituting keys.
      if (
        typeof uid !== 'string' ||
        !uid.trim() ||
        !member ||
        typeof member !== 'object' ||
        Array.isArray(member) ||
        member.uid !== uid ||
        typeof member.uin !== 'string' ||
        !/^\d+$/.test(member.uin) ||
        typeof member.nick !== 'string' ||
        typeof member.cardName !== 'string'
      )
        throw new Error('Invalid native group member');
      if (typeof member.role !== 'number') throw new Error('Unknown native group member role');
      const role = ({ 4: 'owner', 3: 'admin', 2: 'member' } as const)[member.role as 2 | 3 | 4];
      if (!role) throw new Error('Unknown native group member role');
      return {
        userId: member.uin,
        uid,
        nickname: member.nick,
        card: member.cardName,
        role,
      };
    });
    // Commit only a complete validated query; failures leave no partial cache.
    alive();
    commitMembers(members);
    return members;
  };
  return {
    listGroups,
    getGroupInfo,
    listGroupMutedMembers,
    getGroupMembers,
    close() {
      closed = true;
      groupListRequest = undefined;
      groupInfoQueries.clear();
      invalidGroupInfoQueries.clear();
      groupMuteQueries.clear();
      invalidGroupMuteQueries.clear();
    },
  };
}
