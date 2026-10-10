/** Pinned callback shapes and enums: NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076
 * listeners/NodeIKernelGroupListener.ts: onGroupListUpdate, onMemberInfoChange, onGroupDetailInfoChange;
 * types/group.ts: GroupListUpdateType, DataSource, NTGroupMemberRole, GroupDetailInfo.
 * These are metadata synchronization callbacks, not inferred join/kick events.
 */
import type {
  GroupChange,
  GroupListUpdate,
  GroupMemberChange,
  GroupMemberUpdate,
  GroupInfoUpdate,
} from '../../contracts/groups.ts';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
/** Capture only data properties so callback/query consumers share one atomic DTO. */
export function projectGroupInfo(value: unknown): GroupInfoUpdate {
  const raw = object(value);
  if (!raw) throw new Error('Invalid native group detail');
  const field = (key: string) => Object.getOwnPropertyDescriptor(raw, key)?.value;
  const groupId = field('groupCode'),
    name = field('groupName'),
    ownerUid = field('ownerUid'),
    ownerUserId = field('ownerUin');
  const description = field('fingerMemo'),
    memberCount = field('memberNum'),
    maxMemberCount = field('maxMemberNum');
  if (
    !decimal(groupId) ||
    typeof name !== 'string' ||
    typeof ownerUid !== 'string' ||
    !ownerUid.trim() ||
    !decimal(ownerUserId) ||
    typeof description !== 'string' ||
    typeof memberCount !== 'number' ||
    !Number.isSafeInteger(memberCount) ||
    memberCount < 0 ||
    typeof maxMemberCount !== 'number' ||
    !Number.isSafeInteger(maxMemberCount) ||
    maxMemberCount < 0
  ) {
    throw new Error('Invalid native group detail');
  }
  return { groupId, name, memberCount, maxMemberCount, ownerUid, ownerUserId, description };
}
function group(value: unknown): GroupChange | undefined {
  const raw = object(value);
  if (!raw) return;
  const groupCode = raw.groupCode;
  if (!decimal(groupCode)) return;
  const result: GroupChange = { groupId: groupCode };
  const groupName = raw.groupName;
  if (groupName !== undefined) {
    if (typeof groupName !== 'string') return;
    result.name = groupName;
  }
  for (const [input, output] of [
    ['memberCount', 'memberCount'],
    ['maxMember', 'maxMemberCount'],
  ] as const) {
    const value = raw[input];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return;
    result[output] = value;
  }
  return result;
}
function member(uid: unknown, value: unknown): GroupMemberChange | undefined {
  const raw = object(value);
  if (typeof uid !== 'string' || !uid.trim() || !raw) return;
  const explicitUid = raw.uid;
  if (explicitUid !== undefined && explicitUid !== uid) return;
  const result: GroupMemberChange = { uid };
  const uin = raw.uin;
  if (uin !== undefined) {
    if (!decimal(uin)) return;
    result.userId = uin;
  }
  for (const [input, output] of [
    ['nick', 'nickname'],
    ['cardName', 'card'],
  ] as const) {
    const value = raw[input];
    if (value === undefined) continue;
    if (typeof value !== 'string') return;
    result[output] = value;
  }
  const role = raw.role;
  if (role !== undefined) {
    const roles = ['unspecified', 'stranger', 'member', 'admin', 'owner'] as const;
    if (typeof role !== 'number' || !Number.isInteger(role) || role < 0 || role >= roles.length)
      return;
    result.role = roles[role];
  }
  for (const [input, output] of [
    ['isDelete', 'deleted'],
    ['isChangeRole', 'roleChanged'],
  ] as const) {
    const value = raw[input];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return;
    result[output] = value;
  }
  return result;
}
export function createGroupEvents(emit: (event: string, payload: unknown) => void) {
  const invalid = (stage: string) => emit('diagnostic', { stage });
  return {
    onGroupDetailInfoChange(value: unknown): void {
      let update: GroupInfoUpdate;
      try {
        update = projectGroupInfo(value);
      } catch {
        invalid('invalid-native-group-info-update');
        return;
      }
      emit('group-info-updated', update);
    },
    onGroupListUpdate(kind: unknown, values: unknown): void {
      const kinds = ['refresh', 'all', 'modified', 'removed'] as const;
      if (
        typeof kind !== 'number' ||
        !Number.isInteger(kind) ||
        kind < 0 ||
        kind >= kinds.length ||
        !Array.isArray(values)
      ) {
        invalid('invalid-native-group-list-update');
        return;
      }
      let groups: (GroupChange | undefined)[];
      try {
        groups = Array.from(values, group);
      } catch {
        invalid('invalid-native-group-list-update');
        return;
      }
      if (groups.some((value) => value === undefined)) {
        invalid('invalid-native-group-list-update');
        return;
      }
      const update: GroupListUpdate = { kind: kinds[kind], groups: groups as GroupChange[] };
      emit('group-list-updated', update);
    },
    onMemberInfoChange(groupId: unknown, source: unknown, values: unknown): void {
      if (!decimal(groupId) || (source !== 0 && source !== 1) || !(values instanceof Map)) {
        invalid('invalid-native-group-member-update');
        return;
      }
      let members: (GroupMemberChange | undefined)[];
      try {
        const entries: IterableIterator<[unknown, unknown]> = Map.prototype.entries.call(values);
        members = Array.from(entries, ([uid, value]) => member(uid, value));
      } catch {
        invalid('invalid-native-group-member-update');
        return;
      }
      if (members.some((value) => value === undefined)) {
        invalid('invalid-native-group-member-update');
        return;
      }
      const update: GroupMemberUpdate = {
        groupId,
        source: source === 0 ? 'local' : 'remote',
        members: members as GroupMemberChange[],
      };
      emit('group-members-updated', update);
    },
  };
}
