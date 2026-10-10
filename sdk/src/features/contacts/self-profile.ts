import { nativeResultError } from '../../errors.ts';
/** Fixed NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * action/go-cqhttp/SetQQProfile.ts; apis/user.ts81-95,130-131;
 * types/user.ts ModifyProfileParams, SimpleInfo and UserDetailInfoListenerArg;
 * services/NodeIKernelProfileService.ts17-23,44.
 * Nickname and signature updates preserve the other existing profile fields.
 */
import { withCleanupFailure } from '../../runtime/cleanup.ts';
export type SelfProfileOperation = 'setNickname' | 'setSignature';
export interface SelfProfileListener {
  onUserDetailInfoChanged(value: unknown): void;
}
export interface MiniProfileRequest {
  nick: string;
  longNick: string;
  sex: number;
  birthday: { birthday_year: string; birthday_month: string; birthday_day: string };
  location: undefined;
}
export interface SelfProfilePort {
  addKernelProfileListener?: (listener: SelfProfileListener) => unknown;
  removeKernelProfileListener?: (id: unknown) => unknown;
  fetchUserDetailInfo?: (
    store: string,
    uids: string[],
    source: number,
    fields: number[],
  ) => unknown;
  modifyDesktopMiniProfile?: (request: MiniProfileRequest) => unknown;
}
export interface SelfProfileContext {
  getProfileService(): SelfProfilePort | null | undefined;
  resolveSelfUid(): string | Promise<string>;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Owns the uncorrelated lookup and its temporary listener. Listener IDs remain
 * opaque: registration/removal keeps the native ABI without inventing an ID.
 * Removal is dispatched once; its proprietary return is not a completion proof.
 */
export function createSelfProfile(context: SelfProfileContext) {
  const { getProfileService, resolveSelfUid, awaitAlive } = context;
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  let busy = false;
  let closed = false;
  let queryInvalidated = false;
  let cancelLookup: (() => { error: unknown } | undefined) | undefined;
  const alive = () => {
    if (closed) throw new Error('Self profile module is closed');
    signal.throwIfAborted();
  };
  const wait = async <T>(value: T | PromiseLike<T>): Promise<T> => {
    const pending = Promise.resolve(value);
    if (signal.aborted) {
      void pending.catch(() => {});
      alive();
    }
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Self profile module is closed'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([awaitAlive(pending), stopped]);
      alive();
      return result;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
  async function invokeOperation(
    method: SelfProfileOperation,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (method !== 'setNickname' && method !== 'setSignature')
      throw new Error('Unsupported self profile operation');
    const selected = method === 'setNickname' ? payload.name : payload.text;
    if (method === 'setNickname' && (typeof selected !== 'string' || !selected.trim()))
      throw new Error('name must be a nonempty string');
    if (method === 'setSignature' && typeof selected !== 'string')
      throw new Error('text must be a string');
    alive();
    if (queryInvalidated)
      throw new Error('Self profile lookup is invalidated; recreate the Session');
    if (busy) throw new Error('A self profile update is already pending');
    busy = true;
    try {
      const uid = await wait(resolveSelfUid());
      alive();
      if (typeof uid !== 'string' || !uid) throw new Error('Self UID is unavailable');
      const service = getProfileService();
      alive();
      const detail = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let completed = false,
          requestDone = false,
          registrationDone = false;
        let profile: Record<string, unknown> | undefined;
        let failure: { error: unknown } | undefined;
        let listenerId: unknown;
        let acquired = false;
        const timer = setTimeout(() => finish(new Error('Self profile lookup timed out')), 10_000);
        const aborted = () => {
          finish(new Error('Self profile module is closed'));
        };
        const finish = (error?: unknown): { error: unknown } | undefined => {
          if (completed) return;
          if (error !== undefined && !failure) failure = { error };
          if (!registrationDone || (!failure && (!requestDone || !profile))) return;
          completed = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', aborted);
          cancelLookup = undefined;
          let cleanupFailure: { error: unknown } | undefined;
          if (acquired && listenerId !== undefined) {
            try {
              const remove = service?.removeKernelProfileListener;
              if (typeof remove !== 'function')
                throw new Error('Native service is missing removeKernelProfileListener');
              // Preserve legacy synchronous removal semantics; observe a returned
              // rejection, but do not await an undocumented cleanup promise.
              void Promise.resolve(Reflect.apply(remove, service, [listenerId])).catch(() => {});
            } catch (error) {
              cleanupFailure = { error };
            }
          }
          if (failure || cleanupFailure) {
            queryInvalidated = true;
            reject(
              failure && cleanupFailure
                ? withCleanupFailure(failure.error, cleanupFailure.error)
                : (failure ?? cleanupFailure)!.error,
            );
          } else resolve(profile!);
          return cleanupFailure;
        };
        cancelLookup = () => finish(new Error('Self profile module is closed'));
        signal.addEventListener('abort', aborted, { once: true });
        try {
          alive();
          const add = service?.addKernelProfileListener;
          alive();
          if (typeof add !== 'function')
            throw new Error('Native service is missing addKernelProfileListener');
          listenerId = Reflect.apply(add, service, [
            {
              onUserDetailInfoChanged(value: unknown) {
                if (completed) return;
                try {
                  const candidate = record(value);
                  if (candidate?.uid === uid) {
                    profile = candidate;
                    finish();
                  }
                } catch {
                  finish(new Error('Native self profile lookup failed'));
                }
              },
            } satisfies SelfProfileListener,
          ]);
          acquired = true;
          registrationDone = true;
          finish();
          if (completed) return;
          alive();
          const fetch = service?.fetchUserDetailInfo;
          alive();
          if (typeof fetch !== 'function')
            throw new Error('Native service is missing fetchUserDetailInfo');
          const result = Reflect.apply(fetch, service, ['BuddyProfileStore', [uid], 1, [0]]);
          Promise.resolve(result).then(
            (value) => {
              if (completed) return;
              try {
                if (record(value)?.result !== 0) {
                  finish(nativeResultError('Native self profile lookup failed', value));
                  return;
                }
                requestDone = true;
                finish();
              } catch {
                finish(new Error('Native self profile lookup failed'));
              }
            },
            () => finish(new Error('Native self profile lookup failed')),
          );
        } catch {
          registrationDone = true;
          finish(new Error('Native self profile lookup failed'));
        }
      });
      alive();
      const simple = record(detail.simpleInfo);
      const base = record(simple?.baseInfo);
      if (
        !base ||
        (method === 'setNickname' && typeof base.longNick !== 'string') ||
        ![0, 1, 2, 255].includes(base.sex as number) ||
        !['birthday_year', 'birthday_month', 'birthday_day'].every((key) =>
          Number.isInteger(base[key]),
        )
      )
        throw new Error('Self profile response lacks fields required to preserve existing profile');
      const nick = method === 'setNickname' ? selected : record(simple?.coreInfo)?.nick;
      if (typeof nick !== 'string' || !nick.trim())
        throw new Error(
          'Self profile response lacks the existing nickname required to preserve profile',
        );
      const request: MiniProfileRequest = {
        nick,
        longNick: (method === 'setSignature' ? selected : base.longNick) as string,
        sex: base.sex as number,
        birthday: {
          birthday_year: String(base.birthday_year),
          birthday_month: String(base.birthday_month),
          birthday_day: String(base.birthday_day),
        },
        location: undefined,
      };
      alive();
      const modify = service?.modifyDesktopMiniProfile;
      alive();
      if (typeof modify !== 'function')
        throw new Error('Native service is missing modifyDesktopMiniProfile');
      const result = await wait(Reflect.apply(modify, service, [request]));
      alive();
      if (record(result)?.result !== 0)
        throw nativeResultError(
          `Native ${method === 'setSignature' ? 'signature' : 'nickname'} update failed`,
          result,
        );
      alive();
    } finally {
      busy = false;
    }
  }
  return {
    invokeOperation,
    close() {
      if (closed) return;
      closed = true;
      const cleanupFailure = cancelLookup?.();
      controller.abort(new Error('Self profile module is closed'));
      if (cleanupFailure) throw cleanupFailure.error;
    },
  };
}
