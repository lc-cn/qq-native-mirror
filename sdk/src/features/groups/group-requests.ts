import type {
  GroupRequest,
  GroupRequestPage,
  GroupRequestParticipant,
} from '../../contracts/groups.ts';
import { nativeResultError } from '../../errors.ts';
import { FeatureLifetime } from '../../runtime/feature-lifetime.ts';
import { captureGroupRequestOperation, type GroupRequestOperation } from './group-request-input.ts';
export type { GroupRequestOperation } from './group-request-input.ts';
/** Fixed upstream NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L447-L459
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L524-L538
 * types/notify.ts defines type 1 invite, 5 invitation needing admin approval,
 * 7 join application; status 1 unhandled; operation 1 agree / 2 refuse.
 * Locally retained native service/listener contracts: .local/research/NodeIKernelGroup{Service,Listener}.ts.
 */
/** Compatibility names for SDK projections, not declarations of native notification carriers. */
export type NativeGroupRequest = GroupRequest;
export type NativeGroupRequestPage = GroupRequestPage;
function numeric(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error(`${name} must be a numeric string`);
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}
function requestType(value: unknown): 1 | 5 | 7 {
  if (value !== 1 && value !== 5 && value !== 7) throw new Error('Unsupported group request type');
  return value;
}
function ownData(raw: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(raw, key);
  return field && Object.hasOwn(field, 'value') ? field.value : undefined;
}
/** Optional display data must not invoke accessors or invalidate an otherwise
 * actionable notification. A failed nickname read preserves the captured UID.
 */
function participant(raw: object, key: 'user1' | 'user2'): GroupRequestParticipant | undefined {
  let carrier: object;
  let uid: string;
  try {
    const value = ownData(raw, key);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const identifier = ownData(value, 'uid');
    if (typeof identifier !== 'string' || !identifier.trim()) return;
    carrier = value;
    uid = identifier;
  } catch {
    return;
  }
  try {
    const nickname = ownData(carrier, 'nickName');
    if (typeof nickname === 'string' && nickname.trim()) return { uid, nickname };
  } catch {
    // Optional nickname failure must not discard a valid participant identity.
  }
  return { uid };
}
function normalize(raw: unknown, doubt: boolean): NativeGroupRequest | undefined {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid native group notification');
  const value = raw as Record<string, unknown>;
  // Membership/admin notices are not actionable applications or invitations.
  const nativeType = value.type;
  if (nativeType !== 1 && nativeType !== 5 && nativeType !== 7) return undefined;
  const type = requestType(nativeType);
  const rawGroup = value.group;
  const group =
    rawGroup && typeof rawGroup === 'object' ? (rawGroup as Record<string, unknown>) : undefined;
  const groupId = numeric(group?.groupCode, 'native groupCode');
  const sequence = numeric(value.seq, 'native seq');
  const status = value.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 4)
    throw new Error('Invalid native group request status');
  const message = value.postscript;
  if (typeof message !== 'string') throw new Error('Invalid native group request message');
  // Native Group listener roles, not a universal user1/user2 convention:
  // pinned napcat-onebot/index.ts:486-546 handles only pending requests.
  const person = status === 1 ? participant(value, type === 1 ? 'user2' : 'user1') : undefined;
  return {
    groupId,
    sequence,
    type,
    kind: type === 1 ? 'invite' : type === 5 ? 'invite-approval' : 'join',
    doubt,
    status,
    message,
    ...(person ? (type === 1 ? { inviter: person } : { applicant: person }) : {}),
    raw,
  };
}
export interface GroupRequestListener {
  onGroupNotifiesUpdated(doubt: unknown, notifies: unknown): void;
  onGroupSingleScreenNotifies(doubt: unknown, next: unknown, notifies: unknown): void;
}
export interface GroupNotificationOperation {
  operateType: 1 | 2;
  targetMsg: { seq: string; type: 1 | 5 | 7; groupCode: string; postscript: string };
}
export interface GroupRequestPort {
  addKernelGroupListener?: (listener: GroupRequestListener) => unknown;
  removeKernelGroupListener?: (id: unknown) => unknown;
  getSingleScreenNotifies?: (doubt: boolean, before: string, limit: number) => unknown;
  operateSysNotify?: (doubt: boolean, request: GroupNotificationOperation) => unknown;
}
export interface GroupRequestsContext {
  getGroupService(): GroupRequestPort | null | undefined;
  emit(event: string, payload: unknown): void;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>, requestSignal?: AbortSignal): Promise<T>;
}
export function createGroupRequests(context: GroupRequestsContext) {
  const { signal, awaitAlive } = context;
  let closed = false;
  const lifetime = new FeatureLifetime({
    signal,
    awaitAlive,
    closedMessage: 'Group request service is closed',
  });
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
  const awaitValue = lifetime.wait;
  alive();
  const service = inspect(() => context.getGroupService());
  const add = inspect(() => service?.addKernelGroupListener);
  if (typeof add !== 'function')
    throw new Error('Native Group service is missing addKernelGroupListener');
  const emit = (event: string, payload: unknown) => {
    if (!closed && !signal.aborted) context.emit(event, payload);
  };
  let queue = Promise.resolve();
  let queryInvalidated = false;
  let pending:
    | {
        doubt: boolean;
        resolve: (page: NativeGroupRequestPage) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  const seen = new Set<string>();
  function requests(doubt: unknown, notifies: unknown): NativeGroupRequest[] {
    bool(doubt, 'native doubt');
    if (!Array.isArray(notifies)) throw new Error('Native group notifications must be an array');
    // Materialize holes so malformed batches cannot become successful empty or
    // partial pages. Validate every entry before emitting or recording any request.
    return Array.from(notifies, (raw) => normalize(raw, doubt as boolean)).filter(
      (value): value is NativeGroupRequest => value !== undefined,
    );
  }
  function events(values: NativeGroupRequest[]) {
    for (const request of values) {
      if (closed || signal.aborted) return;
      if (request.status !== 1) continue;
      const key = `${request.doubt}:${request.groupId}:${request.sequence}:${request.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 5000) seen.delete(seen.values().next().value!);
      emit('request.group', request);
    }
  }
  const listener = new Proxy(
    {
      onGroupNotifiesUpdated(doubt: unknown, notifies: unknown) {
        if (closed || signal.aborted) return;
        try {
          events(requests(doubt, notifies));
        } catch {
          /* An unsolicited update is not the pending list response. */
        }
      },
      onGroupSingleScreenNotifies(doubt: unknown, next: unknown, notifies: unknown) {
        if (closed || signal.aborted) return;
        try {
          const values = requests(doubt, notifies);
          if (typeof next !== 'string' || (next && !/^\d+$/.test(next)))
            throw new Error('Invalid native group notification cursor');
          events(values);
          if (closed || signal.aborted) return;
          if (pending && pending.doubt === doubt) pending.resolve({ requests: values, next });
        } catch (error) {
          if (pending && pending.doubt === doubt) pending.reject(error);
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
    const method = service?.removeKernelGroupListener;
    if (typeof method === 'function') {
      // Preserve legacy removal dispatch without inventing completion semantics.
      void Promise.resolve(Reflect.apply(method, service, [listenerId])).catch(() => {});
    }
  };
  const callList = (doubt: boolean, before: string, limit: number) => {
    alive();
    const method = inspect(() => service?.getSingleScreenNotifies);
    if (typeof method !== 'function')
      throw new Error('Native Group service is missing getSingleScreenNotifies');
    return Reflect.apply(method, service, [doubt, before, limit]) as unknown;
  };
  const callOperation = (doubt: boolean, request: GroupNotificationOperation) => {
    alive();
    const method = inspect(() => service?.operateSysNotify);
    if (typeof method !== 'function')
      throw new Error('Native Group service is missing operateSysNotify');
    return Reflect.apply(method, service, [doubt, request]) as unknown;
  };
  signal.addEventListener('abort', retire, { once: true });
  try {
    listenerId = Reflect.apply(add, service, [listener]);
    registered = true;
    if (closed || signal.aborted) {
      close();
      alive();
    }
  } catch (error) {
    retire();
    throw error;
  }
  async function list(
    doubt: boolean,
    before: string,
    limit: number,
  ): Promise<NativeGroupRequestPage> {
    // Native callbacks contain no request ID; serialize list calls so pages cannot
    // satisfy multiple simultaneous requests for different cursors.
    const operation = queue
      .catch(() => {})
      .then(async () => {
        alive();
        if (queryInvalidated)
          throw new Error(
            'Group request query channel is invalid after a failed query; recreate the Session',
          );
        const notification = new Promise<NativeGroupRequestPage>((resolve, reject) => {
          pending = { doubt, resolve, reject };
        });
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            Promise.all([
              notification,
              Promise.resolve()
                .then(() => awaitValue(callList(doubt, before, limit)))
                .then((result) => {
                  checkResult(
                    result,
                    'Native getSingleScreenNotifies failed or returned an invalid result',
                  );
                }),
            ]).then(([page]) => {
              alive();
              return page;
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                queryInvalidated = true;
                reject(
                  new Error(
                    'Native group request notification timed out; recreate the Session before querying again',
                  ),
                );
              }, 10_000);
            }),
          ]);
        } catch (error) {
          // With no request ID, any failed dispatched query may produce a late page.
          queryInvalidated = true;
          throw error;
        } finally {
          clearTimeout(timer);
          pending = undefined;
        }
      });
    queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  async function invokeOperation(
    method: GroupRequestOperation,
    payload: Record<string, unknown> = {},
  ): Promise<NativeGroupRequestPage | void> {
    alive();
    const captured = captureGroupRequestOperation(method, payload);
    alive();
    if (captured.method === 'listGroupRequests') {
      const { doubt, before, limit } = captured.payload.options;
      const page = await list(doubt, before ?? '', limit);
      alive();
      return page;
    }
    const { request, accept, reason } = captured.payload;
    const { groupId, sequence, type, doubt } = request;
    const result = await awaitValue(
      callOperation(doubt, {
        operateType: accept ? 1 : 2,
        targetMsg: { seq: sequence, type, groupCode: groupId, postscript: reason ?? ' ' },
      }),
    );
    alive();
    // Pinned native declaration is Promise<void>: dispatch is not server approval.
    checkResult(result, 'Native operateSysNotify failed or returned an invalid result', true);
  }
  function retire() {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', retire);
    lifetime.close(signal.aborted ? signal.reason : undefined);
    const current = pending;
    pending = undefined;
    seen.clear();
    current?.reject(lifetime.signal.reason);
  }
  function close() {
    retire();
    remove();
  }
  return { invokeOperation, close };
}
