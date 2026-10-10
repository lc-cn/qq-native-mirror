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
import type { NativeObject as Native } from '../../native/native-object.ts';
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
export function createContactOperations(
  session: Native,
  resolveUid: (id: string) => Promise<string>,
) {
  const call = (family: string, method: string, ...args: unknown[]) => {
    if (typeof session[`get${family}Service`] !== 'function')
      throw new Error(`Native service is missing get${family}Service`);
    const service = session[`get${family}Service`]();
    if (!service || typeof service[method] !== 'function')
      throw new Error(`Native ${family} service is missing ${method}`);
    return service[method](...args);
  };
  async function invokeOperation(
    method: ContactOperation,
    payload: Record<string, unknown>,
  ): Promise<ContactProfile | void> {
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
    const uid = await resolveUid(id);
    if (typeof uid !== 'string' || !uid.trim())
      throw new Error('User UID resolution returned no UID');
    if (method === 'getUserProfile') {
      const profiles = await call('Profile', 'getCoreAndBaseInfo', 'nodeStore', [uid]);
      if (!(profiles instanceof Map)) throw new Error('Native profile response must be a Map');
      const profile = profiles.get(uid);
      if (
        !profile ||
        typeof profile !== 'object' ||
        Array.isArray(profile) ||
        !profile.coreInfo ||
        typeof profile.coreInfo !== 'object' ||
        Array.isArray(profile.coreInfo)
      )
        throw new Error('Native profile response is missing the requested user');
      const core = profile.coreInfo;
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
        ? await call('Buddy', 'setBuddyRemark', { uid, remark })
        : await call('Buddy', 'delBuddy', { friendUid: uid, tempBlock: block, tempBothDel: both });
    checkResult(result, method);
  }
  return { invokeOperation };
}
