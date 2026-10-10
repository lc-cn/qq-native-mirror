import type { GroupFileEntry, GroupFilePage } from '../../contracts/groups.ts';
import {
  captureGroupFilePage,
  captureGroupFileList,
  type CapturedGroupFilePage,
  type GroupFileListParams,
} from './group-file-input.ts';
import {
  captureGroupFileCallback,
  type CapturedGroupFileCallback,
} from './group-file-page-codec.ts';

export interface GroupFilePagePort {
  getGroupFileList?: (groupId: string, params: GroupFileListParams) => unknown;
}

/** Worker-lifetime correlation ledger. Tokens are never evicted or reset when
 * accounts close: native callbacks have no account generation or request nonce.
 */
export class GroupFilePageHistory {
  #used = new Set<number>();
  #quarantined = false;
  #lease: symbol | undefined;
  acquire(): symbol {
    if (this.#quarantined) throw new Error('Group file request history is quarantined');
    if (this.#lease) throw new Error('Another group file page query is active');
    if (this.#used.size >= 100_000) {
      this.#quarantined = true;
      throw new Error('Group file request token budget exhausted');
    }
    return (this.#lease = Symbol('group-file-page'));
  }
  reserve(lease: symbol, token: number): void {
    if (this.#lease !== lease || this.#quarantined)
      throw new Error('Group file request history is quarantined');
    if (this.#used.has(token)) {
      this.#quarantined = true;
      throw new Error('Duplicate group file request token');
    }
    this.#used.add(token);
  }
  quarantine(): void {
    this.#quarantined = true;
  }
  release(lease: symbol): void {
    if (this.#lease === lease) this.#lease = undefined;
  }
}

export interface GroupFilePagesContext {
  readonly signal: AbortSignal;
  readonly getFilePageService: () => GroupFilePagePort | null | undefined;
  readonly supportsFilePage: () => boolean;
  readonly history: GroupFilePageHistory;
}

interface Request {
  captured: CapturedGroupFilePage;
  signal: AbortSignal;
  resolve(value: GroupFilePage): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  abort(): void;
  done: boolean;
  dispatched: boolean;
  token?: number;
  lease?: symbol;
  early: CapturedGroupFileCallback[];
}

/** Single-page callback association and per-page serialized dispatch. Completion
 * uses the first matching detached callback, not a complete/atomic folder snapshot.
 */
export function createGroupFilePages(context: GroupFilePagesContext) {
  const { signal, history, getFilePageService, supportsFilePage } = context;
  let closed = false;
  let active: Request | undefined;
  const queue: Request[] = [];
  const alive = (requestSignal = signal) => {
    requestSignal.throwIfAborted();
    signal.throwIfAborted();
    if (closed) throw new Error('Group file page owner is closed');
  };
  const finish = (request: Request, error?: { reason: unknown }, value?: GroupFilePage) => {
    if (request.done) return;
    request.done = true;
    clearTimeout(request.timer);
    request.signal.removeEventListener('abort', request.abort);
    if (request.dispatched && request.token === undefined) history.quarantine();
    if (request.lease) history.release(request.lease);
    const index = queue.indexOf(request);
    if (index !== -1) queue.splice(index, 1);
    if (active === request) active = undefined;
    if (error) request.reject(error.reason);
    else if (value) request.resolve(value);
    // Defer the next dispatch until the current native stack has unwound.
    queueMicrotask(pump);
  };
  const selected = (request: Request, callback: CapturedGroupFileCallback) => {
    if (request.done || callback.reqId !== request.token) return;
    try {
      alive(request.signal);
      if (performance.now() >= request.deadline) throw new Error('Group file page query timed out');
      if (!callback.outcome.ok) throw callback.outcome.error;
      const body = callback.outcome.body;
      if (body.items.some((item) => BigInt(item.groupId) !== BigInt(request.captured.groupId)))
        throw new Error('Invalid native group file page conversation');
      alive(request.signal);
      if (performance.now() >= request.deadline) throw new Error('Group file page query timed out');
      const { groupId, params } = request.captured;
      finish(request, undefined, {
        groupId,
        ...(params.folderId === undefined ? {} : { folderId: params.folderId }),
        startIndex: params.startIndex,
        fileCount: params.fileCount,
        ...body,
      });
    } catch (reason) {
      finish(request, { reason });
    }
  };
  function pump(): void {
    if (active || closed || signal.aborted) return;
    const request = queue.shift();
    if (!request || request.done) return;
    active = request;
    try {
      alive(request.signal);
      if (performance.now() >= request.deadline) throw new Error('Group file page query timed out');
      request.lease = history.acquire();
      const service = getFilePageService();
      alive(request.signal);
      const method = service?.getGroupFileList;
      alive(request.signal);
      if (performance.now() >= request.deadline) throw new Error('Group file page query timed out');
      if (typeof method !== 'function')
        throw new Error('Native service is missing getGroupFileList');
      request.dispatched = true;
      const returned: unknown = Reflect.apply(method, service, [
        request.captured.groupId,
        { ...request.captured.params },
      ]);
      // This ABI returns a synchronous uint32, including zero. Observe unexpected
      // promises/thenables, but never reinterpret them as a valid request token.
      if (
        typeof returned !== 'number' ||
        !Number.isInteger(returned) ||
        returned < 0 ||
        returned > 0xffff_ffff
      ) {
        Promise.resolve(returned).catch(() => {
          /* Observe a late proprietary rejection. */
        });
        history.quarantine();
        throw new Error('Invalid native group file request token');
      }
      if (request.done) {
        history.quarantine();
        return;
      }
      history.reserve(request.lease, returned);
      request.token = returned;
      alive(request.signal);
      const first = request.early.find((callback) => callback.reqId === returned);
      request.early.length = 0;
      if (first) selected(request, first);
    } catch (reason) {
      finish(request, { reason });
    }
  }
  const enqueue = (
    captured: CapturedGroupFilePage,
    requestSignal?: AbortSignal,
  ): Promise<GroupFilePage> => {
    const operationSignal =
      requestSignal && requestSignal !== signal ? AbortSignal.any([signal, requestSignal]) : signal;
    const deadline = performance.now() + 5000;
    alive(operationSignal);
    const supported = supportsFilePage();
    alive(operationSignal);
    if (performance.now() >= deadline) throw new Error('Group file page query timed out');
    if (!supported)
      throw Object.assign(
        new Error('Group file page contract is not verified for this native binary'),
        { code: 'unsupported-native-contract' },
      );
    return new Promise((resolve, reject) => {
      const request: Request = {
        captured,
        deadline,
        signal: operationSignal,
        resolve,
        reject,
        done: false,
        dispatched: false,
        early: [],
        timer: setTimeout(
          () => finish(request, { reason: new Error('Group file page query timed out') }),
          Math.max(0, deadline - performance.now()),
        ),
        abort: () => finish(request, { reason: new Error('Group file page query cancelled') }),
      };
      operationSignal.addEventListener('abort', request.abort, { once: true });
      queue.push(request);
      if (operationSignal.aborted || closed) request.abort();
      else pump();
    });
  };
  return {
    async getGroupFilePage(
      groupId: unknown,
      options?: unknown,
      requestSignal?: AbortSignal,
    ): Promise<GroupFilePage> {
      const captured = captureGroupFilePage(groupId, options);
      const operationSignal =
        requestSignal && requestSignal !== signal
          ? AbortSignal.any([signal, requestSignal])
          : signal;
      const deadline = performance.now() + 5000;
      const page = await enqueue(captured, operationSignal);
      alive(operationSignal);
      if (performance.now() >= deadline) throw new Error('Group file page query timed out');
      return page;
    },
    async listGroupFiles(
      groupId: unknown,
      options?: unknown,
      requestSignal?: AbortSignal,
    ): Promise<GroupFileEntry[]> {
      const captured = captureGroupFileList(groupId, options);
      const operationSignal =
        requestSignal && requestSignal !== signal
          ? AbortSignal.any([signal, requestSignal])
          : signal;
      const items: GroupFileEntry[] = [];
      let startIndex = 0;
      for (let pageIndex = 0; pageIndex < captured.maxPages; pageIndex++) {
        alive(operationSignal);
        const page = await enqueue(
          { groupId: captured.groupId, params: { ...captured.params, startIndex } },
          operationSignal,
        );
        alive(operationSignal);
        items.push(...page.items);
        if (page.isEnd) return items;
        if (page.nextIndex <= startIndex) throw new Error('Group file page cursor did not advance');
        startIndex = page.nextIndex;
      }
      throw new Error('Group file listing page budget exhausted before end');
    },
    receiveFileInfo(raw: unknown): void {
      if (closed || signal.aborted || !active) return;
      const request = active;
      const captured = captureGroupFileCallback(raw);
      if (!captured || request.done || closed || request.signal.aborted) return;
      if (request.token !== undefined) selected(request, captured);
      else {
        if (request.early.length >= 16) {
          history.quarantine();
          finish(request, { reason: new Error('Group file early callback budget exceeded') });
        } else request.early.push(captured);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      const requests = [...queue, ...(active ? [active] : [])];
      for (const request of requests)
        finish(request, { reason: new Error('Group file page owner is closed') });
    },
  };
}
