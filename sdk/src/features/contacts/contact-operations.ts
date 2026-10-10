/** Pinned primary contracts: NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076
 * apis/user.ts#L16-L22; apis/friend.ts#L14-L16 and #L46-L52;
 * services/NodeIKernelProfileService.ts#L16;
 * services/NodeIKernelBuddyService.ts#L49 and #L73-L83.
 * https://github.com/NapNeko/NapCatQQ/tree/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core
 */
import { nativeResultError } from '../../errors.ts';
export type ContactOperation = 'getUserProfile' | 'setFriendRemark' | 'deleteFriend';
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
function userId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error('userId must be a numeric string');
  return value;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}
function flag(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}
function checkResult(result: unknown, method: string): void {
  // Upstream setBuddyRemark returns void, delBuddy Promise<unknown>. A void
  // return confirms dispatch only, not server acceptance of the mutation.
  if (result === undefined) return;
  if (!result || typeof result !== 'object' || !('result' in result) || result.result !== 0) {
    throw nativeResultError(`Native contact ${method} failed`, result);
  }
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
    const id = userId(payload.userId);
    // Validate all mutation arguments before even resolving the account UID.
    let remark: string | undefined;
    let block = false;
    let both = false;
    if (method === 'setFriendRemark') remark = string(payload.remark, 'remark');
    else if (method === 'deleteFriend') {
      if (
        payload.options !== undefined &&
        (!payload.options || typeof payload.options !== 'object' || Array.isArray(payload.options))
      )
        throw new Error('options must be an object');
      const options = (payload.options ?? {}) as Record<string, unknown>;
      if (options.block !== undefined) block = flag(options.block, 'block');
      if (options.both !== undefined) both = flag(options.both, 'both');
    } else if (method !== 'getUserProfile')
      throw new Error(`Unsupported contact operation: ${method}`);
    alive();
    const uid = await awaitAlive(resolveUid(id));
    alive();
    if (typeof uid !== 'string' || !uid.trim())
      throw new Error('User UID resolution returned no UID');
    if (method === 'getUserProfile') {
      const profiles = await awaitAlive(readProfile(uid));
      alive();
      if (!(profiles instanceof Map)) throw new Error('Native profile response must be a Map');
      const profile: unknown = profiles.get(uid);
      const row = profile as Record<string, unknown> | null | undefined;
      if (
        !profile ||
        typeof profile !== 'object' ||
        Array.isArray(profile) ||
        !row?.coreInfo ||
        typeof row?.coreInfo !== 'object' ||
        Array.isArray(row?.coreInfo)
      )
        throw new Error('Native profile response is missing the requested user');
      const core = row!.coreInfo as Record<string, unknown>;
      // CoreInfo declares both identifiers as strings. A Map entry alone cannot
      // validate a missing or contradictory native identity for the requested user.
      const { uid: profileUid, uin } = core;
      if (
        typeof profileUid !== 'string' ||
        profileUid !== uid ||
        typeof uin !== 'string' ||
        !/^\d+$/.test(uin) ||
        uin !== id
      )
        throw new Error('Native profile identity does not match requested user');
      return {
        userId: uin,
        uid: profileUid,
        nickname: string(core.nick ?? '', 'native nickname'),
        remark: string(core.remark ?? '', 'native remark'),
        raw: profile,
      };
    }
    const result =
      method === 'setFriendRemark'
        ? await awaitAlive(setRemark(uid, remark!))
        : await awaitAlive(deleteBuddy(uid, block, both));
    alive();
    checkResult(result, method);
  }
  return { invokeOperation };
}
