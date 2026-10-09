import { nativeResultError } from './errors.ts';
/** Fixed NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * action/go-cqhttp/SetQQProfile.ts; apis/user.ts81-95,130-131;
 * types/user.ts246-252,362-370; services/NodeIKernelProfileService.ts17-23,44.
 * Only nickname is exposed; other fields are preserved, never defaulted away.
 */
type Native = Record<string, any>;
export type SelfProfileOperation = 'setNickname';
export function createSelfProfile(session: Native, resolveSelfUid: () => string | Promise<string>) {
  let busy = false;
  let closed = false;
  let queryInvalidated = false;
  let cancelLookup: (() => void) | undefined;
  async function invokeOperation(method: SelfProfileOperation, payload: Record<string, unknown>): Promise<void> {
    if (method !== 'setNickname') throw new Error('Unsupported self profile operation');
    if (typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('name must be a nonempty string');
    if (closed) throw new Error('Self profile module is closed');
    if (queryInvalidated) throw new Error('Self profile lookup is invalidated; recreate the Session');
    if (busy) throw new Error('A self profile update is already pending');
    busy = true;
    try {
      const uid = await resolveSelfUid();
      if (closed) throw new Error('Self profile module is closed');
      if (typeof uid !== 'string' || !uid) throw new Error('Self UID is unavailable');
      const service = session.getProfileService();
      const detail: Native = await new Promise((resolve, reject) => {
        let completed = false;
        let requestDone = false;
        let profile: Native | undefined;
        const timer = setTimeout(() => finish(new Error('Self profile lookup timed out')), 10_000);
        let listenerId: number | undefined;
        const finish = (error?: Error) => {
          if (completed) return;
          if (!error && (!requestDone || !profile)) return;
          completed = true;
          clearTimeout(timer);
          if (listenerId !== undefined) service.removeKernelProfileListener(listenerId);
          cancelLookup = undefined;
          if (error) { queryInvalidated = true; reject(error); } else resolve(profile!);
        };
        cancelLookup = () => finish(new Error('Self profile module is closed'));
        try {
          listenerId = service.addKernelProfileListener({ onUserDetailInfoChanged: (value: Native) => { if (value?.uid === uid) { profile = value; finish(); } } });
          Promise.resolve(service.fetchUserDetailInfo('BuddyProfileStore', [uid], 1, [0])).then((result: Native) => {
            if (result?.result !== 0) return finish(nativeResultError('Native self profile lookup failed',result));
            requestDone = true; finish();
          }, () => finish(new Error('Native self profile lookup failed')));
        } catch { finish(new Error('Native self profile lookup failed')); }
      });
      if (closed) throw new Error('Self profile module is closed');
      const base = detail.simpleInfo?.baseInfo;
      if (!base || typeof base.longNick !== 'string' || ![0, 1, 2, 255].includes(base.sex) || !['birthday_year', 'birthday_month', 'birthday_day'].every((key) => Number.isInteger(base[key]))) throw new Error('Self profile response lacks fields required to preserve existing profile');
      const result = await service.modifyDesktopMiniProfile({ nick: payload.name, longNick: base.longNick, sex: base.sex, birthday: { birthday_year: String(base.birthday_year), birthday_month: String(base.birthday_month), birthday_day: String(base.birthday_day) }, location: undefined });
      if (result?.result !== 0) throw nativeResultError('Native nickname update failed',result);
    } finally { busy = false; }
  }
  return { invokeOperation, close() { closed = true; cancelLookup?.(); } };
}
