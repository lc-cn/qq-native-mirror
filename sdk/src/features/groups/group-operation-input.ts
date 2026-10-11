import type { KickOptions } from '../../contracts/groups.ts';

interface GroupPayloads {
  setGroupName: { groupId: string; name: string };
  setGroupRemark: { groupId: string; remark: string };
  setGroupMute: { groupId: string; enabled: boolean };
  setGroupMemberMute: { groupId: string; userId: string; seconds: number };
  setGroupMemberCard: { groupId: string; userId: string; card: string };
  setGroupAdmin: { groupId: string; userId: string; enabled: boolean };
  kickGroupMember: { groupId: string; userId: string; options: Required<KickOptions> };
  leaveGroup: { groupId: string };
}
export type GroupOperation = keyof GroupPayloads;
export type CapturedGroupOperation<K extends GroupOperation = GroupOperation> = {
  [P in K]: { method: P; payload: GroupPayloads[P] };
}[K];

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error(`${field} must be a numeric string`);
  return value;
}
function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()))
    throw new Error(`${field} must be ${allowEmpty ? 'a string' : 'a nonempty string'}`);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

/** Owns management input rules before IPC or UID resolution. This existing
 * decimal-string policy is distinct from uint64 file IDs and positive query IDs.
 * Only the selected operation's fields are read; options are detached copies.
 */
export function captureGroupOperation<K extends GroupOperation>(
  method: K,
  payload: Record<string, unknown>,
): CapturedGroupOperation<K>;
export function captureGroupOperation(
  method: GroupOperation,
  payload: Record<string, unknown>,
): CapturedGroupOperation {
  const groupId = id(payload.groupId, 'groupId');
  switch (method) {
    case 'setGroupName':
      return { method, payload: { groupId, name: text(payload.name, 'name') } };
    case 'setGroupRemark':
      return { method, payload: { groupId, remark: text(payload.remark, 'remark', true) } };
    case 'setGroupMute':
      return { method, payload: { groupId, enabled: boolean(payload.enabled, 'enabled') } };
    case 'setGroupMemberMute': {
      const userId = id(payload.userId, 'userId');
      const seconds = payload.seconds;
      if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0)
        throw new Error('seconds must be a nonnegative safe integer');
      return { method, payload: { groupId, userId, seconds } };
    }
    case 'setGroupMemberCard': {
      const userId = id(payload.userId, 'userId');
      return { method, payload: { groupId, userId, card: text(payload.card, 'card', true) } };
    }
    case 'setGroupAdmin': {
      const userId = id(payload.userId, 'userId');
      return {
        method,
        payload: { groupId, userId, enabled: boolean(payload.enabled, 'enabled') },
      };
    }
    case 'kickGroupMember': {
      const userId = id(payload.userId, 'userId');
      const supplied = payload.options;
      if (
        supplied !== undefined &&
        (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
      )
        throw new Error('options must be an object');
      const options = (supplied ?? {}) as Record<string, unknown>;
      const reject = options.rejectRejoin;
      const rejectRejoin = reject === undefined ? false : boolean(reject, 'rejectRejoin');
      const suppliedReason = options.reason;
      const reason = suppliedReason === undefined ? '' : text(suppliedReason, 'reason', true);
      return { method, payload: { groupId, userId, options: { rejectRejoin, reason } } };
    }
    case 'leaveGroup':
      return { method, payload: { groupId } };
    default:
      throw new Error(`Unsupported group operation: ${method}`);
  }
}
