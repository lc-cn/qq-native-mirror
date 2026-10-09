import { nativeResultError } from './errors.ts';
/** Pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/notify.ts#L136-L160
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/friend.ts#L87-L103
 * Buddy service declares getBuddyReq Promise<GeneralCallResult>, approvalFriendRequest Promise<void>.
 */
type Native = Record<string, any>;
export type FriendRequestOperation = 'listFriendRequests' | 'handleFriendRequest';
export interface NativeFriendRequestDTO {
  uid: string; time: string; nickname: string; message: string;
  decided: boolean; unread: boolean; initiator: boolean; raw: unknown;
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function normalize(raw: unknown): NativeFriendRequestDTO {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid native friend request');
  const item = raw as Native;
  const uid = nonempty(item.friendUid, 'native friendUid');
  const time = nonempty(item.reqTime, 'native reqTime');
  if (!/^\d+$/.test(time)) throw new Error('Native request time must be a numeric string');
  if (typeof item.isDecide !== 'boolean' || typeof item.isUnread !== 'boolean' || (item.isInitiator !== undefined && typeof item.isInitiator !== 'boolean')) throw new Error('Invalid native friend request flags');
  if (typeof item.friendNick !== 'string' || typeof item.extWords !== 'string') throw new Error('Invalid native friend request text');
  return { uid, time, nickname: item.friendNick, message: item.extWords, decided: item.isDecide, unread: item.isUnread, initiator: item.isInitiator ?? false, raw };
}
export function createFriendRequests(session: Native, emit: (event: string, payload: unknown) => void) {
  if (typeof session.getBuddyService !== 'function') throw new Error('Native service is missing getBuddyService');
  const service = session.getBuddyService();
  if (!service || typeof service.addKernelBuddyListener !== 'function') throw new Error('Native Buddy service is missing addKernelBuddyListener');
  let closed = false;
  const seen = new Set<string>();
  const waiters = new Set<{ resolve: (requests: NativeFriendRequestDTO[]) => void; reject: (error: Error) => void }>();
  let listing: Promise<NativeFriendRequestDTO[]> | undefined;
  let queryInvalidated = false;
  const listener = new Proxy({
    onBuddyReqChange(notification: unknown) {
      if (closed) return;
      try {
        if (!notification || typeof notification !== 'object' || !Array.isArray((notification as Native).buddyReqs)) throw new Error('Invalid native friend request notification');
        const requests = (notification as Native).buddyReqs.map(normalize) as NativeFriendRequestDTO[];
        for (const request of requests) {
          if (request.decided || request.initiator) continue;
          const key = `${request.uid}:${request.time}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > 5000) seen.delete(seen.values().next().value!);
          emit('friend-request', request);
        }
        for (const waiter of waiters) waiter.resolve(requests);
      } catch (error) { for (const waiter of waiters) waiter.reject(error as Error); }
    },
  }, { get: (object, key) => Reflect.get(object, key) ?? (() => {}) });
  const listenerId = service.addKernelBuddyListener(listener);
  const call = (method: string, ...args: unknown[]) => {
    if (closed) throw new Error('Friend request service is closed');
    if (typeof service[method] !== 'function') throw new Error(`Native Buddy service is missing ${method}`);
    return service[method](...args);
  };
  async function list(): Promise<NativeFriendRequestDTO[]> {
    if (listing) return listing;
    if (queryInvalidated) throw new Error('Friend request query channel is invalid after a failed query; recreate the Session');
    let waiter: { resolve: (requests: NativeFriendRequestDTO[]) => void; reject: (error: Error) => void };
    const notification = new Promise<NativeFriendRequestDTO[]>((resolve, reject) => { waiter = { resolve, reject }; waiters.add(waiter); });
    let timer: NodeJS.Timeout | undefined;
    listing = Promise.race([
      Promise.all([
        notification,
        Promise.resolve().then(() => call('getBuddyReq')).then(result => {
          if (!result || result.result !== 0) throw nativeResultError('Native getBuddyReq failed or returned an invalid result',result);
        }),
      ]).then(([requests]) => requests),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native friend request notification timed out')), 10_000); }),
    ]).catch(error => {
      // Buddy notifications have no request ID. A failed query can still emit a
      // late response, which must never complete a subsequent list operation.
      queryInvalidated = true;
      throw error;
    }).finally(() => { clearTimeout(timer); waiters.delete(waiter!); listing = undefined; });
    return listing;
  }
  async function invokeOperation(method: FriendRequestOperation, payload: Record<string, unknown> = {}): Promise<NativeFriendRequestDTO[] | void> {
    if (closed) throw new Error('Friend request service is closed');
    if (method === 'listFriendRequests') return list();
    if (method !== 'handleFriendRequest') throw new Error(`Unsupported friend request operation: ${method}`);
    if (!payload.request || typeof payload.request !== 'object' || Array.isArray(payload.request)) throw new Error('request must be an object');
    const request = payload.request as Native;
    const uid = nonempty(request.uid, 'request.uid');
    const time = nonempty(request.time, 'request.time');
    if (!/^\d+$/.test(time)) throw new Error('request.time must be a numeric string');
    if (typeof payload.accept !== 'boolean') throw new Error('accept must be a boolean');
    const result = await call('approvalFriendRequest', { friendUid: uid, reqTime: time, accept: payload.accept });
    // Upstream void confirms dispatch only. Explicit native errors still reject.
    if (result !== undefined && (!result || typeof result !== 'object' || result.result !== 0)) throw nativeResultError('Native approvalFriendRequest failed or returned an invalid result',result);
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const waiter of waiters) waiter.reject(new Error('Friend request service is closed'));
    waiters.clear(); seen.clear();
    if (typeof service.removeKernelBuddyListener === 'function') service.removeKernelBuddyListener(listenerId);
  }
  return { invokeOperation, close };
}
