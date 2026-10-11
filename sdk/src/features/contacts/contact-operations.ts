/** Pinned primary contracts: NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076
 * apis/user.ts#L16-L22; apis/friend.ts#L14-L16 and #L46-L52;
 * services/NodeIKernelProfileService.ts#L16;
 * services/NodeIKernelBuddyService.ts#L49 and #L73-L83.
 * https://github.com/NapNeko/NapCatQQ/tree/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core
 */
import { nativeResultError } from '../../errors.ts';
import type { UserProfile } from '../../contracts/contacts.ts';
import { queryUserProfile } from './user-profile-query.ts';
import type { ContactProfilePort } from './user-profile-query.ts';
export type { ContactProfilePort } from './user-profile-query.ts';
export type { UserProfile as ContactProfile } from '../../contracts/contacts.ts';
import { captureContactOperation, type ContactOperation } from './contact-operation-input.ts';
export type { ContactOperation } from './contact-operation-input.ts';
export interface BuddyMutationPort {
  setBuddyRemark?: (request: { uid: string; remark: string }) => unknown;
  delBuddy?: (request: { friendUid: string; tempBlock: boolean; tempBothDel: boolean }) => unknown;
}
export interface ContactOperationsContext {
  getBuddyService(): BuddyMutationPort | null | undefined;
  getProfileService(): ContactProfilePort | null | undefined;
  resolveUid(id: string): Promise<string>;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
function checkResult(result: unknown, method: string, alive: () => void): void {
  // Upstream setBuddyRemark returns void, delBuddy Promise<unknown>. A void
  // return confirms dispatch only, not server acceptance of the mutation.
  if (result === undefined) return;
  const code =
    result && typeof result === 'object' && 'result' in result ? result.result : undefined;
  alive();
  if (code !== 0) {
    throw nativeResultError(`Native contact ${method} failed`, { result: code });
  }
}
/** Acquires only the contact methods needed by the selected operation.
 * The Session owns cancellation; mutation calls are never retried. */
export function createContactOperations(context: ContactOperationsContext) {
  const { getBuddyService, getProfileService, resolveUid, signal, awaitAlive } = context;
  const alive = () => signal.throwIfAborted();
  const setRemark = (uid: string, remark: string) => {
    alive();
    const service = getBuddyService();
    alive();
    const method = service?.setBuddyRemark;
    alive();
    if (typeof method !== 'function')
      throw new Error('Native Buddy service is missing setBuddyRemark');
    return Reflect.apply(method, service, [{ uid, remark }]) as unknown;
  };
  const deleteBuddy = (uid: string, block: boolean, both: boolean) => {
    alive();
    const service = getBuddyService();
    alive();
    const method = service?.delBuddy;
    alive();
    if (typeof method !== 'function') throw new Error('Native Buddy service is missing delBuddy');
    return Reflect.apply(method, service, [
      { friendUid: uid, tempBlock: block, tempBothDel: both },
    ]) as unknown;
  };
  async function invokeOperation(
    method: ContactOperation,
    payload: Record<string, unknown>,
  ): Promise<UserProfile | void> {
    alive();
    const captured = captureContactOperation(method, payload);
    alive();
    const id = captured.payload.userId;
    const uid = await awaitAlive(resolveUid(id));
    alive();
    if (typeof uid !== 'string' || !uid.trim())
      throw new Error('User UID resolution returned no UID');
    if (captured.method === 'getUserProfile')
      return queryUserProfile({ signal, awaitAlive, getProfileService }, id, uid);
    const result =
      captured.method === 'setFriendRemark'
        ? await awaitAlive(setRemark(uid, captured.payload.remark))
        : await awaitAlive(
            deleteBuddy(uid, captured.payload.options.block, captured.payload.options.both),
          );
    alive();
    checkResult(result, method, alive);
  }
  return { invokeOperation };
}
