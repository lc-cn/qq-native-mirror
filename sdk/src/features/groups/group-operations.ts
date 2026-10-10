/** Native contracts verified against NapCatQQ commit 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L541-L567
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/group.ts#L554-L560
 * These contracts are fake-tested; no real group mutation is part of verification.
 */
import { nativeResultError } from '../../errors.ts';
export type GroupOperation =
  | 'setGroupName'
  | 'setGroupRemark'
  | 'setGroupMute'
  | 'setGroupMemberMute'
  | 'setGroupMemberCard'
  | 'setGroupAdmin'
  | 'kickGroupMember'
  | 'leaveGroup';
// Pinned NodeIKernelGroupService declares void/Promise<void> for these four.
// A void return acknowledges submission only, not remote permission or effect.
const voidOperations = new Set<GroupOperation>([
  'setGroupMemberCard',
  'setGroupAdmin',
  'kickGroupMember',
  'leaveGroup',
]);
export interface GroupMutationPort {
  modifyGroupName?: (id: string, name: string, flag: boolean) => unknown;
  modifyGroupRemark?: (id: string, remark: string) => unknown;
  setGroupShutUp?: (id: string, enabled: boolean) => unknown;
  setMemberShutUp?: (id: string, members: { uid: string; timeStamp: number }[]) => unknown;
  modifyMemberCardName?: (id: string, uid: string, card: string) => unknown;
  modifyMemberRole?: (id: string, uid: string, role: number) => unknown;
  kickMember?: (id: string, uids: string[], reject: boolean, reason: string) => unknown;
  quitGroup?: (id: string) => unknown;
}
type NativeGroupCall = {
  [K in keyof GroupMutationPort]-?: {
    method: K;
    args: Parameters<NonNullable<GroupMutationPort[K]>>;
  };
}[keyof GroupMutationPort];
export interface GroupOperationsContext {
  getGroupService(): GroupMutationPort | null | undefined;
  resolveUid(id: string): Promise<string>;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
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
export function createGroupOperations(context: GroupOperationsContext) {
  const { resolveUid, signal, awaitAlive } = context;
  const alive = () => signal.throwIfAborted();
  const memberUid = async (userId: string): Promise<string> => {
    alive();
    const value = await awaitAlive(resolveUid(userId));
    alive();
    return text(value, 'resolved UID');
  };
  async function invokeOperation(
    method: GroupOperation,
    payload: Record<string, unknown>,
  ): Promise<void> {
    alive();
    const groupId = id(payload.groupId, 'groupId');
    let call: NativeGroupCall;
    switch (method) {
      case 'setGroupName':
        call = { method: 'modifyGroupName', args: [groupId, text(payload.name, 'name'), false] };
        break;
      case 'setGroupRemark':
        call = {
          method: 'modifyGroupRemark',
          args: [groupId, text(payload.remark, 'remark', true)],
        };
        break;
      case 'setGroupMute':
        call = { method: 'setGroupShutUp', args: [groupId, boolean(payload.enabled, 'enabled')] };
        break;
      case 'setGroupMemberMute': {
        const userId = id(payload.userId, 'userId');
        const seconds = payload.seconds;
        if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0)
          throw new Error('seconds must be a nonnegative safe integer');
        call = {
          method: 'setMemberShutUp',
          args: [groupId, [{ uid: await memberUid(userId), timeStamp: seconds }]],
        };
        break;
      }
      case 'setGroupMemberCard': {
        const userId = id(payload.userId, 'userId');
        const card = text(payload.card, 'card', true);
        call = { method: 'modifyMemberCardName', args: [groupId, await memberUid(userId), card] };
        break;
      }
      case 'setGroupAdmin': {
        const userId = id(payload.userId, 'userId');
        const enabled = boolean(payload.enabled, 'enabled');
        call = {
          method: 'modifyMemberRole',
          args: [groupId, await memberUid(userId), enabled ? 3 : 2],
        };
        break;
      }
      case 'kickGroupMember': {
        const userId = id(payload.userId, 'userId');
        if (
          payload.options !== undefined &&
          (!payload.options ||
            typeof payload.options !== 'object' ||
            Array.isArray(payload.options))
        )
          throw new Error('options must be an object');
        const options = (payload.options ?? {}) as Record<string, unknown>;
        const rejectRejoin =
          options.rejectRejoin === undefined
            ? false
            : boolean(options.rejectRejoin, 'rejectRejoin');
        const reason = options.reason === undefined ? '' : text(options.reason, 'reason', true);
        call = {
          method: 'kickMember',
          args: [groupId, [await memberUid(userId)], rejectRejoin, reason],
        };
        break;
      }
      case 'leaveGroup':
        call = { method: 'quitGroup', args: [groupId] };
        break;
      default:
        throw new Error(`Unsupported group operation: ${method}`);
    }
    alive();
    const service = context.getGroupService();
    alive();
    const captured = service?.[call.method];
    alive();
    if (typeof captured !== 'function')
      throw new Error(`Native group service is missing ${call.method}`);
    const result: unknown = await awaitAlive(Reflect.apply(captured, service, call.args));
    alive();
    if (result === undefined && voidOperations.has(method)) return;
    // GeneralCallResult methods require result zero; explicit failure or malformed
    // returns also reject for void methods. No mutation is retried.
    if (!result || typeof result !== 'object' || (result as { result?: unknown }).result !== 0) {
      throw nativeResultError(`Native group ${method} failed`, result);
    }
  }
  return { invokeOperation };
}
