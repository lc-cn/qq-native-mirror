import { nativeResultError } from './errors.ts';
/** Fixed upstream NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L447-L459
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L524-L538
 * types/notify.ts defines type 1 invite, 5 invitation needing admin approval,
 * 7 join application; status 1 unhandled; operation 1 agree / 2 refuse.
 * Locally retained native service/listener contracts: .local/research/NodeIKernelGroup{Service,Listener}.ts.
 */
type Native = Record<string, any>;
export type GroupRequestOperation = 'listGroupRequests' | 'handleGroupRequest';
export interface NativeGroupRequest {
  groupId: string; sequence: string; type: 1 | 5 | 7;
  kind: 'invite' | 'invite-approval' | 'join'; doubt: boolean; status: number; message: string; raw: unknown;
}
export interface NativeGroupRequestPage { requests: NativeGroupRequest[]; next: string }
function numeric(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${name} must be a numeric string`);
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
function normalize(raw: unknown, doubt: boolean): NativeGroupRequest | undefined {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid native group notification');
  const value = raw as Native;
  // Membership/admin notices are not actionable applications or invitations.
  if (![1, 5, 7].includes(value.type)) return undefined;
  const type = requestType(value.type);
  const groupId = numeric(value.group?.groupCode, 'native groupCode');
  const sequence = numeric(value.seq, 'native seq');
  if (!Number.isInteger(value.status) || value.status < 0 || value.status > 4) throw new Error('Invalid native group request status');
  if (typeof value.postscript !== 'string') throw new Error('Invalid native group request message');
  return { groupId, sequence, type, kind: type === 1 ? 'invite' : type === 5 ? 'invite-approval' : 'join', doubt, status: value.status, message: value.postscript, raw };
}
export function createGroupRequests(session: Native, emit: (event: string, payload: unknown) => void) {
  if (typeof session.getGroupService !== 'function') throw new Error('Native service is missing getGroupService');
  const service = session.getGroupService();
  if (!service || typeof service.addKernelGroupListener !== 'function') throw new Error('Native Group service is missing addKernelGroupListener');
  let closed = false;
  let queue = Promise.resolve();
  let queryInvalidated = false;
  let pending: { doubt: boolean; resolve: (page: NativeGroupRequestPage) => void; reject: (error: Error) => void } | undefined;
  const seen = new Set<string>();
  function requests(doubt: unknown, notifies: unknown): NativeGroupRequest[] {
    bool(doubt, 'native doubt');
    if (!Array.isArray(notifies)) throw new Error('Native group notifications must be an array');
    return notifies.map(raw => normalize(raw, doubt as boolean)).filter((value): value is NativeGroupRequest => value !== undefined);
  }
  function events(values: NativeGroupRequest[]) {
    for (const request of values) {
      if (request.status !== 1) continue;
      const key = `${request.doubt}:${request.groupId}:${request.sequence}:${request.type}`;
      if (seen.has(key)) continue;
      seen.add(key); if (seen.size > 5000) seen.delete(seen.values().next().value!);
      emit('request.group', request);
    }
  }
  const listener = new Proxy({
    onGroupNotifiesUpdated(doubt: unknown, notifies: unknown) {
      if (closed) return;
      try { events(requests(doubt, notifies)); }
      catch { /* An unsolicited update is not the pending list response. */ }
    },
    onGroupSingleScreenNotifies(doubt: unknown, next: unknown, notifies: unknown) {
      if (closed) return;
      try {
        const values = requests(doubt, notifies);
        if (typeof next !== 'string' || (next && !/^\d+$/.test(next))) throw new Error('Invalid native group notification cursor');
        events(values);
        if (pending && pending.doubt === doubt) pending.resolve({ requests: values, next });
      } catch (error) { if (pending && pending.doubt === doubt) pending.reject(error as Error); }
    },
  }, { get: (object, key) => Reflect.get(object, key) ?? (() => {}) });
  const listenerId = service.addKernelGroupListener(listener);
  const call = (method: string, ...args: unknown[]) => {
    if (closed) throw new Error('Group request service is closed');
    if (typeof service[method] !== 'function') throw new Error(`Native Group service is missing ${method}`);
    return service[method](...args);
  };
  async function list(doubt: boolean, before: string, limit: number): Promise<NativeGroupRequestPage> {
    // Native callbacks contain no request ID; serialize list calls so pages cannot
    // satisfy multiple simultaneous requests for different cursors.
    const operation = queue.catch(() => {}).then(async () => {
      if (closed) throw new Error('Group request service is closed');
      if (queryInvalidated) throw new Error('Group request query channel is invalid after a failed query; recreate the Session');
      const notification = new Promise<NativeGroupRequestPage>((resolve, reject) => { pending = { doubt, resolve, reject }; });
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          Promise.all([notification, Promise.resolve().then(() => call('getSingleScreenNotifies', doubt, before, limit)).then(result => {
            if (!result || result.result !== 0) throw nativeResultError('Native getSingleScreenNotifies failed or returned an invalid result',result);
          })]).then(([page]) => page),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { queryInvalidated = true; reject(new Error('Native group request notification timed out; recreate the Session before querying again')); }, 10_000); }),
        ]);
      } catch (error) {
        // With no request ID, any failed dispatched query may produce a late page.
        queryInvalidated = true;
        throw error;
      } finally { clearTimeout(timer); pending = undefined; }
    });
    queue = operation.then(() => {}, () => {});
    return operation;
  }
  async function invokeOperation(method: GroupRequestOperation, payload: Record<string, unknown> = {}): Promise<NativeGroupRequestPage | void> {
    if (closed) throw new Error('Group request service is closed');
    if (method === 'listGroupRequests') {
      if (payload.options !== undefined && (!payload.options || typeof payload.options !== 'object' || Array.isArray(payload.options))) throw new Error('options must be an object');
      const options = (payload.options ?? {}) as Native;
      const doubt = options.doubt === undefined ? false : bool(options.doubt, 'doubt');
      const before = options.before === undefined ? '' : numeric(options.before, 'before');
      const limit = options.limit ?? 20;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer between 1 and 100');
      return list(doubt, before, limit);
    }
    if (method !== 'handleGroupRequest') throw new Error(`Unsupported group request operation: ${method}`);
    if (!payload.request || typeof payload.request !== 'object' || Array.isArray(payload.request)) throw new Error('request must be an object');
    const request = payload.request as Native;
    const groupId = numeric(request.groupId, 'request.groupId');
    const sequence = numeric(request.sequence, 'request.sequence');
    const type = requestType(request.type);
    const doubt = bool(request.doubt, 'request.doubt');
    const accept = bool(payload.accept, 'accept');
    if (payload.reason !== undefined && typeof payload.reason !== 'string') throw new Error('reason must be a string');
    const result = await call('operateSysNotify', doubt, { operateType: accept ? 1 : 2, targetMsg: { seq: sequence, type, groupCode: groupId, postscript: payload.reason ?? ' ' } });
    // Pinned native declaration is Promise<void>: dispatch is not server approval.
    if (result !== undefined && (!result || typeof result !== 'object' || result.result !== 0)) throw nativeResultError('Native operateSysNotify failed or returned an invalid result',result);
  }
  function close() {
    if (closed) return;
    closed = true; pending?.reject(new Error('Group request service is closed')); seen.clear();
    if (typeof service.removeKernelGroupListener === 'function') service.removeKernelGroupListener(listenerId);
  }
  return { invokeOperation, close };
}
