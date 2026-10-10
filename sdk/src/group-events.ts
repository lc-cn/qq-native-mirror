/** Pinned callback shapes and enums: NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076
 * listeners/NodeIKernelGroupListener.ts: onGroupListUpdate, onMemberInfoChange, onGroupDetailInfoChange;
 * types/group.ts: GroupListUpdateType, DataSource, NTGroupMemberRole, GroupDetailInfo.
 * These are metadata synchronization callbacks, not inferred join/kick events.
 */
import type { GroupChange, GroupListUpdate, GroupMemberChange, GroupMemberUpdate, GroupInfoUpdate } from './types.ts';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function decimal(value: unknown): value is string { return typeof value === 'string' && /^\d+$/.test(value); }
/** Capture only data properties so callback/query consumers share one atomic DTO. */
export function projectGroupInfo(value: unknown): GroupInfoUpdate {
  const raw = object(value);
  if (!raw) throw new Error('Invalid native group detail');
  const field = (key: string) => Object.getOwnPropertyDescriptor(raw, key)?.value;
  const groupId = field('groupCode'), name = field('groupName'), ownerUid = field('ownerUid'), ownerUserId = field('ownerUin');
  const description = field('fingerMemo'), memberCount = field('memberNum'), maxMemberCount = field('maxMemberNum');
  if (!decimal(groupId) || typeof name !== 'string' || typeof ownerUid !== 'string' || !ownerUid.trim()
    || !decimal(ownerUserId) || typeof description !== 'string'
    || typeof memberCount !== 'number' || !Number.isSafeInteger(memberCount) || memberCount < 0
    || typeof maxMemberCount !== 'number' || !Number.isSafeInteger(maxMemberCount) || maxMemberCount < 0) {
    throw new Error('Invalid native group detail');
  }
  return { groupId, name, memberCount, maxMemberCount, ownerUid, ownerUserId, description };
}
function group(value: unknown): GroupChange | undefined {
  const raw = object(value);
  if (!raw || !decimal(raw.groupCode)) return;
  const result: GroupChange = { groupId: raw.groupCode };
  if (raw.groupName !== undefined) {
    if (typeof raw.groupName !== 'string') return;
    result.name = raw.groupName;
  }
  for (const [input, output] of [['memberCount', 'memberCount'], ['maxMember', 'maxMemberCount']] as const) {
    if (raw[input] === undefined) continue;
    if (typeof raw[input] !== 'number' || !Number.isSafeInteger(raw[input]) || raw[input] < 0) return;
    result[output] = raw[input];
  }
  return result;
}
function member(uid: unknown, value: unknown): GroupMemberChange | undefined {
  const raw = object(value);
  if (typeof uid !== 'string' || !uid.trim() || !raw || (raw.uid !== undefined && raw.uid !== uid)) return;
  const result: GroupMemberChange = { uid };
  if (raw.uin !== undefined) {
    if (!decimal(raw.uin)) return;
    result.userId = raw.uin;
  }
  for (const [input, output] of [['nick', 'nickname'], ['cardName', 'card']] as const) {
    if (raw[input] === undefined) continue;
    if (typeof raw[input] !== 'string') return;
    result[output] = raw[input];
  }
  if (raw.role !== undefined) {
    const roles = ['unspecified', 'stranger', 'member', 'admin', 'owner'] as const;
    if (typeof raw.role !== 'number' || !Number.isInteger(raw.role) || raw.role < 0 || raw.role >= roles.length) return;
    result.role = roles[raw.role];
  }
  for (const [input, output] of [['isDelete', 'deleted'], ['isChangeRole', 'roleChanged']] as const) {
    if (raw[input] === undefined) continue;
    if (typeof raw[input] !== 'boolean') return;
    result[output] = raw[input];
  }
  return result;
}
export function createGroupEvents(emit: (event: string, payload: unknown) => void) {
  const invalid = (stage: string) => emit('diagnostic', { stage });
  return {
    onGroupDetailInfoChange(value: unknown): void {
      let update: GroupInfoUpdate;
      try { update = projectGroupInfo(value); }
      catch { invalid('invalid-native-group-info-update'); return; }
      emit('group-info-updated', update);
    },
    onGroupListUpdate(kind: unknown, values: unknown): void {
      const kinds = ['refresh', 'all', 'modified', 'removed'] as const;
      if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind >= kinds.length || !Array.isArray(values)) {
        invalid('invalid-native-group-list-update'); return;
      }
      const groups = Array.from(values, group);
      if (groups.some(value => value === undefined)) { invalid('invalid-native-group-list-update'); return; }
      const update: GroupListUpdate = { kind: kinds[kind], groups: groups as GroupChange[] };
      emit('group-list-updated', update);
    },
    onMemberInfoChange(groupId: unknown, source: unknown, values: unknown): void {
      if (!decimal(groupId) || (source !== 0 && source !== 1) || !(values instanceof Map)) {
        invalid('invalid-native-group-member-update'); return;
      }
      const members = [...values].map(([uid, value]) => member(uid, value));
      if (members.some(value => value === undefined)) { invalid('invalid-native-group-member-update'); return; }
      const update: GroupMemberUpdate = { groupId, source: source === 0 ? 'local' : 'remote', members: members as GroupMemberChange[] };
      emit('group-members-updated', update);
    },
  };
}
