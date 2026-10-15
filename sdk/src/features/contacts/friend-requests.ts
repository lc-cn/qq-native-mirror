import type { FriendRequest } from '../../contracts/contacts.ts';
import { nativeResultError } from '../../errors.ts';
import { FeatureLifetime } from '../../runtime/feature-lifetime.ts';
import { createFriendEvents } from './friend-events.ts';
import { captureFriendRequest, type FriendRequestOperation } from './friend-request-input.ts';
export type { FriendRequestOperation } from './friend-request-input.ts';
/** Pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/notify.ts#L136-L160
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/friend.ts#L87-L103
 * Buddy service declares getBuddyReq Promise<GeneralCallResult>, approvalFriendRequest Promise<void>.
 */
/** Compatibility name for the SDK projection; proprietary native fields remain raw/unknown. */
export type NativeFriendRequestDTO = FriendRequest;
function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must be a nonempty string`);
  return value;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
function normalize(raw: unknown): NativeFriendRequestDTO {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid native friend request');
  const item = record(raw)!;
  const uid = nonempty(item.friendUid, 'native friendUid');
  const time = nonempty(item.reqTime, 'native reqTime');
  if (!/^\d+$/.test(time)) throw new Error('Native request time must be a numeric string');
  const decided = item.isDecide;
  const unread = item.isUnread;
  const initiator = item.isInitiator;
  if (
    typeof decided !== 'boolean' ||
    typeof unread !== 'boolean' ||
    (initiator !== undefined && typeof initiator !== 'boolean')
  )
    throw new Error('Invalid native friend request flags');
  const nickname = item.friendNick;
  const message = item.extWords;
  if (typeof nickname !== 'string' || typeof message !== 'string')
    throw new Error('Invalid native friend request text');
  return {
    uid,
    time,
    nickname,
    message,
    decided,
    unread,
    initiator: initiator ?? false,
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
  awaitAlive<T>(value: T | PromiseLike<T>, requestSignal?: AbortSignal): Promise<T>;
}
export function createFriendRequests(context: FriendRequestsContext) {
  const { signal, awaitAlive } = context;
  let closed = false;
  const lifetime = new FeatureLifetime({
    signal,
    awaitAlive,
    closedMessage: 'Friend request service is closed',
  });
  const awaitValue = lifetime.wait;
  const alive = lifetime.assertOpen;
  const inspect = lifetime.inspect;
  const checkResult = (result: unknown, message: string, allowVoid = false) => {
    alive();
    // Approval may acknowledge dispatch with void. Lists always require result zero.
    if (allowVoid && result === undefined) return;
    const code = inspect(() =>
      result && typeof result === 'object' ? (result as { result?: unknown }).result : undefined,
    );
    if (code !== 0) throw nativeResultError(message, { result: code });
  };
  alive();
  const service = inspect(() => context.getBuddyService());
  const add = inspect(() => service?.addKernelBuddyListener);
  if (typeof add !== 'function')
    throw new Error('Native Buddy service is missing addKernelBuddyListener');
  const emit = (event: string, payload: unknown) => {
    if (!closed && !signal.aborted) context.emit(event, payload);
  };
  const seen = new Set<string>();
  const waiters = new Set<{
    resolve: (requests: NativeFriendRequestDTO[]) => void;
    reject: (error: unknown) => void;
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
          const rows = record(notification)?.buddyReqs;
          if (!Array.isArray(rows)) throw new Error('Invalid native friend request notification');
          const requests = Array.from(rows, normalize);
          if (closed || signal.aborted) return;
          for (const request of requests) {
            if (closed || signal.aborted) return;
            if (request.decided || request.initiator) continue;
            const key = `${request.uid}:${request.time}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (seen.size > 5000) seen.delete(seen.values().next().value!);
            emit('request.friend', request);
          }
          for (const waiter of waiters) waiter.resolve(requests);
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error);
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
    const method = inspect(() => service?.getBuddyReq);
    if (typeof method !== 'function')
      throw new Error('Native Buddy service is missing getBuddyReq');
    return Reflect.apply(method, service, []) as unknown;
  };
  const callApproval = (request: { friendUid: string; reqTime: string; accept: boolean }) => {
    alive();
    const method = inspect(() => service?.approvalFriendRequest);
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
      reject: (error: unknown) => void;
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
            checkResult(result, 'Native getBuddyReq failed or returned an invalid result');
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
    const { request, accept } = captureFriendRequest(payload);
    alive();
    const result = await awaitValue(
      callApproval({
        friendUid: request.uid,
        reqTime: request.time,
        accept,
      }),
    );
    alive();
    // Upstream void confirms dispatch only, never server acceptance.
    checkResult(result, 'Native approvalFriendRequest failed or returned an invalid result', true);
  }
  function retire() {
    if (closed) return;
    closed = true;
    lifetime.close(signal.aborted ? signal.reason : undefined);
    signal.removeEventListener('abort', retire);
    for (const waiter of waiters) waiter.reject(lifetime.signal.reason);
    waiters.clear();
    seen.clear();
  }
  function close() {
    retire();
    remove();
  }
  return { invokeOperation, close };
}
