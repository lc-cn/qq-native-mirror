/** Pinned primary contracts: NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076
 * apis/user.ts#L16-L22; apis/friend.ts#L14-L16 and #L46-L52;
 * services/NodeIKernelProfileService.ts#L16;
 * services/NodeIKernelBuddyService.ts#L49 and #L73-L83.
 * https://github.com/NapNeko/NapCatQQ/tree/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core
 */
import { nativeResultError } from '../../errors.ts';
import { captureContactOperation, type ContactOperation } from './contact-operation-input.ts';
export type { ContactOperation } from './contact-operation-input.ts';
export interface ContactProfile {
  userId: string;
  uid: string;
  nickname: string;
  remark: string;
  raw: unknown;
}
export interface BuddyMutationPort {
  setBuddyRemark?: (request: { uid: string; remark: string }) => unknown;
  delBuddy?: (request: { friendUid: string; tempBlock: boolean; tempBothDel: boolean }) => unknown;
}
export interface ContactProfilePort {
  getCoreAndBaseInfo?: (store: string, uids: string[]) => unknown;
}
export interface ContactOperationsContext {
  getBuddyService(): BuddyMutationPort | null | undefined;
  getProfileService(): ContactProfilePort | null | undefined;
  resolveUid(id: string): Promise<string>;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
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
/** Project one captured native profile; raw retains the original carrier identity. */
function projectProfile(profile: unknown, id: string, uid: string): ContactProfile {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile))
    throw new Error('Native profile response is missing the requested user');
  const coreInfo = (profile as Record<string, unknown>).coreInfo;
  if (!coreInfo || typeof coreInfo !== 'object' || Array.isArray(coreInfo))
    throw new Error('Native profile response is missing the requested user');
  const core = coreInfo as Record<string, unknown>;
  const { uid: profileUid, uin } = core;
  // A Map entry alone does not establish that the native identity matches the request.
  if (
    typeof profileUid !== 'string' ||
    profileUid !== uid ||
    typeof uin !== 'string' ||
    !/^\d+$/.test(uin) ||
    uin !== id
  )
    throw new Error('Native profile identity does not match requested user');
  const nickname = string(core.nick ?? '', 'native nickname');
  const remark = string(core.remark ?? '', 'native remark');
  return {
    userId: uin,
    uid: profileUid,
    nickname,
    remark,
    raw: profile,
  };
}
/** Acquires only the contact methods needed by the selected operation.
 * The Session owns cancellation; mutation calls are never retried. */
export function createContactOperations(context: ContactOperationsContext) {
  const { getBuddyService, getProfileService, resolveUid, signal, awaitAlive } = context;
  const alive = () => signal.throwIfAborted();
  const readProfile = (uid: string) => {
    alive();
    const service = getProfileService();
    alive();
    const method = service?.getCoreAndBaseInfo;
    alive();
    if (typeof method !== 'function')
      throw new Error('Native Profile service is missing getCoreAndBaseInfo');
    return Reflect.apply(method, service, ['nodeStore', [uid]]) as unknown;
  };
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
  ): Promise<ContactProfile | void> {
    alive();
    const captured = captureContactOperation(method, payload);
    alive();
    const id = captured.payload.userId;
    const uid = await awaitAlive(resolveUid(id));
    alive();
    if (typeof uid !== 'string' || !uid.trim())
      throw new Error('User UID resolution returned no UID');
    if (captured.method === 'getUserProfile') {
      const profiles = await awaitAlive(readProfile(uid));
      alive();
      if (!(profiles instanceof Map)) throw new Error('Native profile response must be a Map');
      const lookup = profiles.get;
      alive();
      const profile: unknown = Reflect.apply(lookup, profiles, [uid]);
      alive();
      const projected = projectProfile(profile, id, uid);
      alive();
      return projected;
    }
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
