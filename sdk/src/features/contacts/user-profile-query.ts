import type { UserProfile } from '../../contracts/contacts.ts';

export interface ContactProfilePort {
  getCoreAndBaseInfo?: (store: string, uids: string[]) => unknown;
}

export interface UserProfileQueryContext {
  getProfileService(): ContactProfilePort | null | undefined;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

/** Valid native getters remain supported. Their reads can synchronously retire
 * the account, including when they throw; retirement wins before validation or
 * another read. An active getter failure keeps its original identity.
 */
function capture<T>(signal: AbortSignal, read: () => T): T {
  signal.throwIfAborted();
  try {
    return read();
  } finally {
    signal.throwIfAborted();
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function projectProfile(
  signal: AbortSignal,
  profile: unknown,
  id: string,
  uid: string,
): UserProfile {
  if (!profile || typeof profile !== 'object' || capture(signal, () => Array.isArray(profile)))
    throw new Error('Native profile response is missing the requested user');
  const coreInfo = capture(signal, () => (profile as Record<string, unknown>).coreInfo);
  if (!coreInfo || typeof coreInfo !== 'object' || capture(signal, () => Array.isArray(coreInfo)))
    throw new Error('Native profile response is missing the requested user');
  const core = coreInfo as Record<string, unknown>;
  const profileUid = capture(signal, () => core.uid);
  const uin = capture(signal, () => core.uin);
  // A Map entry alone does not establish the requested native identity.
  if (
    typeof profileUid !== 'string' ||
    profileUid !== uid ||
    typeof uin !== 'string' ||
    !/^\d+$/.test(uin) ||
    uin !== id
  )
    throw new Error('Native profile identity does not match requested user');
  const nickname = text(capture(signal, () => core.nick) ?? '', 'native nickname');
  const remark = text(capture(signal, () => core.remark) ?? '', 'native remark');
  signal.throwIfAborted();
  return { userId: uin, uid: profileUid, nickname, remark, raw: profile };
}

/** Read one already-resolved contact through the pinned Profile port. The caller
 * owns input capture and UID resolution; this stateless module owns acquisition,
 * Map lookup and projection. It neither mutates contacts nor acquires a Session.
 * PC source: NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076,
 * apis/user.ts#L16-L22 and services/NodeIKernelProfileService.ts#L16.
 */
export async function queryUserProfile(
  context: UserProfileQueryContext,
  capturedUserId: string,
  uid: string,
): Promise<UserProfile> {
  const { signal, awaitAlive, getProfileService } = context;
  const service = capture(signal, () => getProfileService());
  const method = capture(signal, () => service?.getCoreAndBaseInfo);
  if (typeof method !== 'function')
    throw new Error('Native Profile service is missing getCoreAndBaseInfo');
  const profiles = await awaitAlive(
    Reflect.apply(method, service, ['nodeStore', [uid]]) as unknown,
  );
  signal.throwIfAborted();
  if (!capture(signal, () => profiles instanceof Map))
    throw new Error('Native profile response must be a Map');
  const map = profiles as Map<unknown, unknown>;
  const lookup = capture(signal, () => map.get);
  const profile: unknown = capture(signal, () => Reflect.apply(lookup, map, [uid]));
  return projectProfile(signal, profile, capturedUserId, uid);
}
