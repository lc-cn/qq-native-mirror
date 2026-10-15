import type {
  Group,
  GroupInfoUpdate,
  GroupMutedMember,
  GroupMember,
} from '../../contracts/groups.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';
import { nativeResultError } from '../../errors.ts';
import { sendGroupId } from '../../validation/identifiers.ts';
import { projectGroupInfo } from './group-events.ts';
import { projectGroupMuteList } from './group-mute-list.ts';
import {
  captureGroupMemberList,
  captureGroupMemberQuery,
  groupMemberIdentity,
} from './group-member-query-input.ts';
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
export interface GroupQueryPort {
  getGroupDetailInfo?: (id: string, source: number) => unknown;
  getGroupShutUpMemberList?: (id: string) => unknown;
  getGroupList?: (refresh: unknown) => unknown;
  getAllMemberList?: (id: string, refresh: boolean) => unknown;
}
export interface GroupQueriesContext {
  signal: AbortSignal;
  getGroupService(): GroupQueryPort | null | undefined;
  eventCall: NativeEventChannel['call'];
  awaitAlive<T>(value: T | PromiseLike<T>, requestSignal?: AbortSignal): Promise<T>;
  commitMembers(members: readonly GroupMember[]): void;
}
/** Owns input validation, query coalescing and callback quarantine.
 * Closing retires this module's waits without closing the shared account channel.
 * Validated member batches commit atomically; construction makes no native calls.
 */
export function createGroupQueries(context: GroupQueriesContext) {
  const { signal, getGroupService, eventCall, awaitAlive, commitMembers } = context;
  const controller = new AbortController();
  const querySignal = AbortSignal.any([signal, controller.signal]);
  let closed = false;
  const alive = () => {
    querySignal.throwIfAborted();
    if (closed) throw new Error('Group queries are closed');
  };
  // The account wait port still observes native completion. This local race
  // lets the query owner retire even if that completion never arrives.
  const waitForMembers = async <T>(value: T | PromiseLike<T>): Promise<T> => {
    const pending = Promise.resolve(value);
    void pending.catch(() => {});
    alive();
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(querySignal.reason);
      querySignal.addEventListener('abort', abort, { once: true });
    });
    void stopped.catch(() => {});
    try {
      const result = await Promise.race([awaitAlive(pending, controller.signal), stopped]);
      alive();
      return result;
    } finally {
      querySignal.removeEventListener('abort', abort);
    }
  };
  const groupService = () => {
    alive();
    const group = getGroupService();
    alive();
    return group;
  };
  const requestDetail = (id: string) => {
    const group = groupService();
    const method = group?.getGroupDetailInfo;
    alive();
    if (typeof method !== 'function')
      throw new Error('Native service is missing getGroupDetailInfo');
    return Reflect.apply(method, group, [id, 2]) as unknown;
  };
  const requestMuteList = (id: string) => {
    const group = groupService();
    const method = group?.getGroupShutUpMemberList;
    alive();
    if (typeof method !== 'function')
      throw new Error('Native service is missing getGroupShutUpMemberList');
    return Reflect.apply(method, group, [id]) as unknown;
  };
  const requestGroupList = (refresh: unknown) => {
    const group = groupService();
    const method = group?.getGroupList;
    alive();
    if (typeof method !== 'function') throw new Error('Native service is missing getGroupList');
    return Reflect.apply(method, group, [refresh]) as unknown;
  };
  const requestMembers = (id: string, refresh: boolean) => {
    const group = groupService();
    const method = group?.getAllMemberList;
    alive();
    if (typeof method !== 'function') throw new Error('Native service is missing getAllMemberList');
    return Reflect.apply(method, group, [id, refresh]) as unknown;
  };
  const nativeCallSucceeded = (value: unknown) => record(value)?.result === 0;
  let groupListRequest: Promise<Group[]> | undefined;
  let groupListInvalidated = false;
  const groupInfoQueries = new Map<string, Promise<GroupInfoUpdate>>();
  const invalidGroupInfoQueries = new Set<string>();
  const getGroupInfo = async (groupId: unknown): Promise<GroupInfoUpdate> => {
    alive();
    const id = sendGroupId(groupId);
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
        () => requestDetail(id),
        5000,
        nativeCallSucceeded,
        querySignal,
      )
        .catch((error) => {
          if (!querySignal.aborted) invalidGroupInfoQueries.add(id);
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
  const listGroupMutedMembers = async (groupId: unknown): Promise<GroupMutedMember[]> => {
    alive();
    const id = sendGroupId(groupId);
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
        () => requestMuteList(id),
        5000,
        nativeCallSucceeded,
        querySignal,
      )
        .catch((error) => {
          if (!querySignal.aborted) invalidGroupMuteQueries.add(id);
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
      (update: unknown, groups: unknown) => {
        // Source: NapCatQQ packages/napcat-core/types/group.ts GroupListUpdateType.
        // REFRESHALL=0 and GETALL=1 are full lists; MODIFIED/REMOVE and new native
        // update kinds can carry partial or empty deltas. Never return those.
        if (update !== 0 && update !== 1) return undefined;
        if (!Array.isArray(groups)) throw new Error('Invalid native group list');
        return Array.from(groups, (group): Group => {
          if (!group || typeof group !== 'object' || Array.isArray(group))
            throw new Error('Invalid native group list');
          const row = record(group)!;
          const groupId = row.groupCode;
          const name = row.groupName;
          const memberCount = row.memberCount;
          const maxMemberCount = row.maxMember;
          if (
            typeof groupId !== 'string' ||
            !/^\d+$/.test(groupId) ||
            typeof name !== 'string' ||
            typeof memberCount !== 'number' ||
            !Number.isSafeInteger(memberCount) ||
            memberCount < 0 ||
            typeof maxMemberCount !== 'number' ||
            !Number.isSafeInteger(maxMemberCount) ||
            maxMemberCount < 0
          )
            throw new Error('Invalid native group list');
          return { groupId, name, memberCount, maxMemberCount };
        });
      },
      () => requestGroupList(refresh ?? true),
      10_000,
      nativeCallSucceeded,
      querySignal,
    );
    groupListRequest = request;
    try {
      const value = await request;
      alive();
      return value;
    } catch (error) {
      if (!querySignal.aborted) groupListInvalidated = true;
      throw error;
    } finally {
      if (groupListRequest === request) groupListRequest = undefined;
    }
  };
  const getGroupMembers = async (
    groupId: unknown,
    refresh: unknown = false,
  ): Promise<GroupMember[]> => {
    alive();
    const captured = captureGroupMemberList(groupId, { refresh: refresh ?? false });
    alive();
    const result: unknown = await waitForMembers(
      requestMembers(captured.groupId, captured.refresh ?? false),
    );
    try {
      // Pinned NodeIKernelGroupService.getAllMemberList reports errCode and
      // finish:true. A Map alone does not establish a successful full list.
      const errCode = record(result)?.errCode;
      if (errCode !== 0)
        throw nativeResultError('Native group member query failed', { errCode }, 'errCode');
      const response = record(record(result)?.result);
      const infos = response?.infos;
      if (!(infos instanceof Map)) throw new Error('Invalid native group member map');
      if (response?.finish !== true)
        throw Object.assign(new Error('Native group member list is incomplete'), {
          code: 'incomplete-result',
        });
      const entries: IterableIterator<[unknown, unknown]> = Map.prototype.entries.call(infos);
      const identities = new Set<string>();
      const members = Array.from(entries, ([uid, member]): GroupMember => {
        if (
          typeof uid !== 'string' ||
          !uid.trim() ||
          !member ||
          typeof member !== 'object' ||
          Array.isArray(member)
        )
          throw new Error('Invalid native group member');
        const row = record(member)!;
        const memberUid = row.uid;
        const userId = row.uin;
        const nickname = row.nick;
        const card = row.cardName;
        const nativeRole = row.role;
        if (
          memberUid !== uid ||
          typeof userId !== 'string' ||
          !/^\d+$/.test(userId) ||
          !/[1-9]/.test(userId) ||
          typeof nickname !== 'string' ||
          typeof card !== 'string'
        )
          throw new Error('Invalid native group member');
        const role =
          nativeRole === 4
            ? 'owner'
            : nativeRole === 3
              ? 'admin'
              : nativeRole === 2
                ? 'member'
                : undefined;
        if (!role) throw new Error('Unknown native group member role');
        const identity = groupMemberIdentity(userId);
        if (identities.has(identity))
          throw new Error('Duplicate native group member account identity');
        identities.add(identity);
        return { userId, uid, nickname, card, role };
      });
      // Commit only a complete validated query; failures leave no partial cache.
      alive();
      commitMembers(members);
      alive();
      return members;
    } finally {
      alive();
    }
  };
  const getGroupMember = async (
    groupId: unknown,
    userId: unknown,
    refresh: unknown = false,
  ): Promise<GroupMember | undefined> => {
    alive();
    const captured = captureGroupMemberQuery(groupId, userId, { refresh });
    alive();
    const members = await getGroupMembers(captured.groupId, captured.refresh);
    alive();
    const identity = groupMemberIdentity(captured.userId);
    return members.find((member) => groupMemberIdentity(member.userId) === identity);
  };
  return {
    listGroups,
    getGroupInfo,
    listGroupMutedMembers,
    getGroupMembers,
    getGroupMember,
    close() {
      if (closed) return;
      closed = true;
      controller.abort(new Error('Group queries are closed'));
      groupListRequest = undefined;
      groupInfoQueries.clear();
      invalidGroupInfoQueries.clear();
      groupMuteQueries.clear();
      invalidGroupMuteQueries.clear();
    },
  };
}
