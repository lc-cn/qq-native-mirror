import { nativeResultError } from '../../errors.ts';
import { createFriendEvents } from './friend-events.ts';
/** Pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/notify.ts#L136-L160
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/friend.ts#L87-L103
 * Buddy service declares getBuddyReq Promise<GeneralCallResult>, approvalFriendRequest Promise<void>.
 */
import type { NativeObject as Native } from '../../native/native-object.ts';
export type FriendRequestOperation = 'listFriendRequests' | 'handleFriendRequest';
export interface NativeFriendRequestDTO {
  uid: string;
  time: string;
  nickname: string;
  message: string;
  decided: boolean;
  unread: boolean;
  initiator: boolean;
  raw: unknown;
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must be a nonempty string`);
  return value;
}
function normalize(raw: unknown): NativeFriendRequestDTO {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid native friend request');
  const item = raw as Native;
  const uid = nonempty(item.friendUid, 'native friendUid');
  const time = nonempty(item.reqTime, 'native reqTime');
  if (!/^\d+$/.test(time)) throw new Error('Native request time must be a numeric string');
  if (
    typeof item.isDecide !== 'boolean' ||
    typeof item.isUnread !== 'boolean' ||
    (item.isInitiator !== undefined && typeof item.isInitiator !== 'boolean')
  )
    throw new Error('Invalid native friend request flags');
  if (typeof item.friendNick !== 'string' || typeof item.extWords !== 'string')
    throw new Error('Invalid native friend request text');
  return {
    uid,
    time,
    nickname: item.friendNick,
    message: item.extWords,
    decided: item.isDecide,
    unread: item.isUnread,
    initiator: item.isInitiator ?? false,
    raw,
  };
}
export interface FriendBuddyListener {
  onBuddyListChange(values: unknown): void;
  onBuddyReqChange(notification: unknown): void;
}
export interface FriendBuddyPort {
  addKernelBuddyListener?: (listener: FriendBuddyListener) => unknown;
  removeKernelBuddyListener?: (id: unknown) => unknown;
  getBuddyReq?: () => unknown;
  approvalFriendRequest?: (request: {
    friendUid: string;
    reqTime: string;
    accept: boolean;
  }) => unknown;
}
export interface FriendRequestsContext {
  getBuddyService(): FriendBuddyPort | null | undefined;
  emit(event: string, payload: unknown): void;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
export function createFriendRequests(context: FriendRequestsContext) {
  const { signal, awaitAlive } = context;
  let closed = false;
  const controller = new AbortController();
  const awaitValue = async <T>(value: T | PromiseLike<T>): Promise<T> => {
    const pending = Promise.resolve(value);
    if (controller.signal.aborted) {
      void pending.catch(() => {});
      throw controller.signal.reason;
    }
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([awaitAlive(pending), stopped]);
    } finally {
      controller.signal.removeEventListener('abort', abort);
    }
  };
  const alive = () => {
    signal.throwIfAborted();
    if (closed) throw new Error('Friend request service is closed');
  };
  alive();
  const service = context.getBuddyService();
  alive();
  const add = service?.addKernelBuddyListener;
  alive();
  if (typeof add !== 'function')
    throw new Error('Native Buddy service is missing addKernelBuddyListener');
  const emit = (event: string, payload: unknown) => {
    if (!closed && !signal.aborted) context.emit(event, payload);
  };
  const seen = new Set<string>();
  const waiters = new Set<{
    resolve: (requests: NativeFriendRequestDTO[]) => void;
    reject: (error: Error) => void;
  }>();
  let listing: Promise<NativeFriendRequestDTO[]> | undefined;
  let queryInvalidated = false;
  const friendEvents = createFriendEvents(emit);
  const listener = new Proxy(
    {
      onBuddyListChange(values: unknown) {
        if (!closed) friendEvents.onBuddyListChange(values);
      },
      onBuddyReqChange(notification: unknown) {
        if (closed || signal.aborted) return;
        try {
          if (
            !notification ||
            typeof notification !== 'object' ||
            !Array.isArray((notification as Native).buddyReqs)
          )
            throw new Error('Invalid native friend request notification');
          const requests = Array.from((notification as Native).buddyReqs, normalize);
          for (const request of requests) {
            if (closed || signal.aborted) return;
            if (request.decided || request.initiator) continue;
            const key = `${request.uid}:${request.time}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (seen.size > 5000) seen.delete(seen.values().next().value!);
            emit('friend-request', request);
          }
          for (const waiter of waiters) waiter.resolve(requests);
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error as Error);
        }
      },
    },
    { get: (object, key) => Reflect.get(object, key) ?? (() => {}) },
  );
  let listenerId: unknown;
  let registered = false;
  let removed = false;
  const remove = () => {
    if (!registered || removed) return;
    removed = true;
    const method = service?.removeKernelBuddyListener;
    if (typeof method === 'function') Reflect.apply(method, service, [listenerId]);
  };
  const callList = () => {
    alive();
    const method = service?.getBuddyReq;
    alive();
    if (typeof method !== 'function')
      throw new Error('Native Buddy service is missing getBuddyReq');
    return Reflect.apply(method, service, []) as unknown;
  };
  const callApproval = (request: { friendUid: string; reqTime: string; accept: boolean }) => {
    alive();
    const method = service?.approvalFriendRequest;
    alive();
    if (typeof method !== 'function')
      throw new Error('Native Buddy service is missing approvalFriendRequest');
    return Reflect.apply(method, service, [request]) as unknown;
  };
  signal.addEventListener('abort', retire, { once: true });
  try {
    listenerId = Reflect.apply(add, service, [listener]);
    registered = true;
    if (closed || signal.aborted) {
      close();
      remove();
      alive();
    }
  } catch (error) {
    signal.removeEventListener('abort', retire);
    throw error;
  }
  async function list(): Promise<NativeFriendRequestDTO[]> {
    if (listing) return listing;
    if (queryInvalidated)
      throw new Error(
        'Friend request query channel is invalid after a failed query; recreate the Session',
      );
    let waiter: {
      resolve: (requests: NativeFriendRequestDTO[]) => void;
      reject: (error: Error) => void;
    };
    const notification = new Promise<NativeFriendRequestDTO[]>((resolve, reject) => {
      waiter = { resolve, reject };
      waiters.add(waiter);
    });
    let timer: NodeJS.Timeout | undefined;
    listing = Promise.race([
      Promise.all([
        notification,
        Promise.resolve()
          .then(() => awaitValue(callList()))
          .then((result) => {
            if (
              !result ||
              typeof result !== 'object' ||
              (result as { result?: unknown }).result !== 0
            )
              throw nativeResultError(
                'Native getBuddyReq failed or returned an invalid result',
                result,
              );
            alive();
          }),
      ]).then(([requests]) => {
        alive();
        return requests;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native friend request notification timed out')),
          10_000,
        );
      }),
    ])
      .catch((error) => {
        // Buddy notifications have no request ID. A failed query can still emit a
        // late response, which must never complete a subsequent list operation.
        queryInvalidated = true;
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        waiters.delete(waiter!);
        listing = undefined;
      });
    return listing;
  }
  async function invokeOperation(
    method: FriendRequestOperation,
    payload: Record<string, unknown> = {},
  ): Promise<NativeFriendRequestDTO[] | void> {
    alive();
    if (method === 'listFriendRequests') {
      const requests = await list();
      alive();
      return requests;
    }
    if (method !== 'handleFriendRequest')
      throw new Error(`Unsupported friend request operation: ${method}`);
    const capturedRequest = payload.request;
    if (!capturedRequest || typeof capturedRequest !== 'object' || Array.isArray(capturedRequest))
      throw new Error('request must be an object');
    const request = capturedRequest as Native;
    const uid = nonempty(request.uid, 'request.uid');
    const time = nonempty(request.time, 'request.time');
    if (!/^\d+$/.test(time)) throw new Error('request.time must be a numeric string');
    const accept = payload.accept;
    if (typeof accept !== 'boolean') throw new Error('accept must be a boolean');
    alive();
    const result = await awaitValue(
      callApproval({
        friendUid: uid,
        reqTime: time,
        accept,
      }),
    );
    alive();
    // Upstream void confirms dispatch only. Explicit native errors still reject.
    if (
      result !== undefined &&
      (!result || typeof result !== 'object' || (result as { result?: unknown }).result !== 0)
    )
      throw nativeResultError(
        'Native approvalFriendRequest failed or returned an invalid result',
        result,
      );
    alive();
  }
  function retire() {
    if (closed) return;
    closed = true;
    controller.abort(
      signal.aborted ? signal.reason : new Error('Friend request service is closed'),
    );
    signal.removeEventListener('abort', retire);
    for (const waiter of waiters) waiter.reject(new Error('Friend request service is closed'));
    waiters.clear();
    seen.clear();
  }
  function close() {
    retire();
    remove();
  }
  return { invokeOperation, close };
}
