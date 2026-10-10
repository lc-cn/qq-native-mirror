/** Native contracts verified against NapCatQQ commit 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L541-L567
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/group.ts#L554-L560
 * These contracts are fake-tested; no real group mutation is part of verification.
 */
import { nativeResultError } from './errors.ts';
export type GroupOperation = 'setGroupName' | 'setGroupRemark' | 'setGroupMute' | 'setGroupMemberMute' | 'setGroupMemberCard' | 'setGroupAdmin' | 'kickGroupMember' | 'leaveGroup';
// Pinned NodeIKernelGroupService declares void/Promise<void> for these four.
// A void return acknowledges submission only, not remote permission or effect.
const voidOperations = new Set<GroupOperation>(['setGroupMemberCard', 'setGroupAdmin', 'kickGroupMember', 'leaveGroup']);
type Native = Record<string, any>;
function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${field} must be a numeric string`);
  return value;
}
function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${field} must be ${allowEmpty ? 'a string' : 'a nonempty string'}`);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}
export function createGroupOperations(session: Native, resolveUid: (id: string) => Promise<string>) {
  const memberUid = async (userId: string): Promise<string> => text(await resolveUid(userId), 'resolved UID');
  async function invokeOperation(method: GroupOperation, payload: Record<string, unknown>): Promise<void> {
    const groupId = id(payload.groupId, 'groupId');
    let nativeMethod: string;
    let args: unknown[];
    switch (method) {
      case 'setGroupName': nativeMethod = 'modifyGroupName'; args = [groupId, text(payload.name, 'name'), false]; break;
      case 'setGroupRemark': nativeMethod = 'modifyGroupRemark'; args = [groupId, text(payload.remark, 'remark', true)]; break;
      case 'setGroupMute': nativeMethod = 'setGroupShutUp'; args = [groupId, boolean(payload.enabled, 'enabled')]; break;
      case 'setGroupMemberMute': {
        const userId = id(payload.userId, 'userId');
        const seconds = payload.seconds;
        if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0) throw new Error('seconds must be a nonnegative safe integer');
        nativeMethod = 'setMemberShutUp'; args = [groupId, [{ uid: await memberUid(userId), timeStamp: seconds }]]; break;
      }
      case 'setGroupMemberCard': {
        const userId = id(payload.userId, 'userId');
        const card = text(payload.card, 'card', true);
        nativeMethod = 'modifyMemberCardName'; args = [groupId, await memberUid(userId), card]; break;
      }
      case 'setGroupAdmin': {
        const userId = id(payload.userId, 'userId');
        const enabled = boolean(payload.enabled, 'enabled');
        nativeMethod = 'modifyMemberRole'; args = [groupId, await memberUid(userId), enabled ? 3 : 2]; break;
      }
      case 'kickGroupMember': {
        const userId = id(payload.userId, 'userId');
        if (payload.options !== undefined && (!payload.options || typeof payload.options !== 'object' || Array.isArray(payload.options))) throw new Error('options must be an object');
        const options = (payload.options ?? {}) as Record<string, unknown>;
        const rejectRejoin = options.rejectRejoin === undefined ? false : boolean(options.rejectRejoin, 'rejectRejoin');
        const reason = options.reason === undefined ? '' : text(options.reason, 'reason', true);
        nativeMethod = 'kickMember'; args = [groupId, [await memberUid(userId)], rejectRejoin, reason]; break;
      }
      case 'leaveGroup': nativeMethod = 'quitGroup'; args = [groupId]; break;
      default: throw new Error(`Unsupported group operation: ${method}`);
    }
    if (typeof session.getGroupService !== 'function') throw new Error('Native service is missing getGroupService');
    const service = session.getGroupService();
    if (!service || typeof service[nativeMethod] !== 'function') throw new Error(`Native group service is missing ${nativeMethod}`);
    const result = await service[nativeMethod](...args);
    if (result === undefined && voidOperations.has(method)) return;
    // GeneralCallResult methods require result zero; explicit failure or malformed
    // returns also reject for void methods. No mutation is retried.
    if (!result || typeof result !== 'object' || result.result !== 0) {
      throw nativeResultError(`Native group ${method} failed`, result);
    }
  }
  return { invokeOperation };
}
