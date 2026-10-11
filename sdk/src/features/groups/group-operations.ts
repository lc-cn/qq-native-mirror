/** Native contracts verified against NapCatQQ commit 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L541-L567
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/group.ts#L554-L560
 * These contracts are fake-tested; no real group mutation is part of verification.
 */
import { nativeResultError } from '../../errors.ts';
import { captureGroupOperation, type GroupOperation } from './group-operation-input.ts';
export type { GroupOperation } from './group-operation-input.ts';
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
function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()))
    throw new Error(`${field} must be ${allowEmpty ? 'a string' : 'a nonempty string'}`);
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
    const captured = captureGroupOperation(method, payload);
    alive();
    const groupId = captured.payload.groupId;
    let call: NativeGroupCall;
    switch (captured.method) {
      case 'setGroupName':
        call = { method: 'modifyGroupName', args: [groupId, captured.payload.name, false] };
        break;
      case 'setGroupRemark':
        call = {
          method: 'modifyGroupRemark',
          args: [groupId, captured.payload.remark],
        };
        break;
      case 'setGroupMute':
        call = { method: 'setGroupShutUp', args: [groupId, captured.payload.enabled] };
        break;
      case 'setGroupMemberMute': {
        const { userId, seconds } = captured.payload;
        call = {
          method: 'setMemberShutUp',
          args: [groupId, [{ uid: await memberUid(userId), timeStamp: seconds }]],
        };
        break;
      }
      case 'setGroupMemberCard': {
        const { userId, card } = captured.payload;
        call = { method: 'modifyMemberCardName', args: [groupId, await memberUid(userId), card] };
        break;
      }
      case 'setGroupAdmin': {
        const { userId, enabled } = captured.payload;
        call = {
          method: 'modifyMemberRole',
          args: [groupId, await memberUid(userId), enabled ? 3 : 2],
        };
        break;
      }
      case 'kickGroupMember': {
        const { userId, options } = captured.payload;
        call = {
          method: 'kickMember',
          args: [groupId, [await memberUid(userId)], options.rejectRejoin, options.reason],
        };
        break;
      }
      case 'leaveGroup':
        call = { method: 'quitGroup', args: [groupId] };
        break;
    }
    alive();
    const service = context.getGroupService();
    alive();
    const capturedMethod = service?.[call.method];
    alive();
    if (typeof capturedMethod !== 'function')
      throw new Error(`Native group service is missing ${call.method}`);
    const result: unknown = await awaitAlive(Reflect.apply(capturedMethod, service, call.args));
    alive();
    if (result === undefined && voidOperations.has(method)) return;
    // GeneralCallResult methods require result zero; explicit failure or malformed
    // returns also reject for void methods. No mutation is retried.
    let code: unknown;
    try {
      code =
        result && typeof result === 'object' ? (result as { result?: unknown }).result : undefined;
    } finally {
      // A native accessor may both retire the account and throw. Check lifetime
      // before interpreting its status, while preserving active getter failures.
      alive();
    }
    if (code !== 0) {
      throw nativeResultError(`Native group ${method} failed`, { result: code });
    }
  }
  return { invokeOperation };
}
