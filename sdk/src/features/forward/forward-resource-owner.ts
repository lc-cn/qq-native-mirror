import { captureMergedForward } from './merged-forward-input.ts';
import { sendCapturedMergedForward } from './merged-forward.ts';
import type { buildMergedForwardCard } from './merged-forward-card.ts';
import {
  createLongMessageResponseTransport,
  type LongMessageResponseService,
} from './long-message-response.ts';
import {
  createForwardResourceTransport,
  ForwardResourceError,
} from './forward-resource-transport.ts';
import { buildForwardResourceRequest } from './forward-resource-wire.ts';
import { normalizeForwardResourceId } from './forward-resource-input.ts';
import type { Peer, SentMessage } from '../../contracts/messages.ts';
import type { NativePeer } from '../../native/message-contracts.ts';

export interface ForwardResourceOwnerContext {
  selfUid: string;
  signal: AbortSignal;
  resolvePeer(peer: Peer): Promise<NativePeer>;
  getMessageService(): LongMessageResponseService;
  sendPrepared(
    peer: NativePeer,
    elements: [ReturnType<typeof buildMergedForwardCard>],
    onDispatch: () => void,
  ): Promise<SentMessage>;
  defer(cleanup: () => void): void;
}

/** Owns lazy forward transports for one Session. Teardown remains two distinct
 * entries in the account lifetime, preserving their order and error aggregation.
 * Neither construction nor cleanup acquires a service or retries native work.
 */
export function createForwardResourceOwner(context: ForwardResourceOwnerContext) {
  const uploadRetirement = new AbortController();
  const readRetirement = new AbortController();
  const uploadSignal = AbortSignal.any([context.signal, uploadRetirement.signal]);
  const readSignal = AbortSignal.any([context.signal, readRetirement.signal]);
  let upload: ReturnType<typeof createLongMessageResponseTransport> | undefined;
  let read: ReturnType<typeof createForwardResourceTransport> | undefined;
  context.defer(() => {
    uploadRetirement.abort(Error('Forward upload is closed'));
    upload?.close();
  });
  context.defer(() => {
    readRetirement.abort(new ForwardResourceError('lifecycle', 'Forward resource read is closed'));
    read?.close();
  });

  /** Also observes a late rejection when invocation synchronously retires the
   * lane. Each wait removes its own subscription after resolution or abort. */
  async function waitUpload<T>(value: T | PromiseLike<T>): Promise<T> {
    const pending = Promise.resolve(value);
    void pending.catch(() => {});
    let abort: (() => void) | undefined;
    // A synchronously returned, already rejected card result retains its native
    // code even if dispatch also retired the lane. A genuinely pending result
    // still loses to cancellation; success always passes the check below.
    const stopped = uploadSignal.aborted
      ? Promise.reject(uploadSignal.reason)
      : new Promise<never>((_, reject) => {
          abort = () => reject(uploadSignal.reason);
          uploadSignal.addEventListener('abort', abort, { once: true });
        });
    try {
      const result = await Promise.race([pending, stopped]);
      uploadSignal.throwIfAborted();
      return result;
    } finally {
      if (abort) uploadSignal.removeEventListener('abort', abort);
    }
  }

  function acquireService(signal: AbortSignal): LongMessageResponseService {
    signal.throwIfAborted();
    try {
      const method = context.getMessageService;
      signal.throwIfAborted();
      return Reflect.apply(method, context, []);
    } finally {
      signal.throwIfAborted();
    }
  }

  function uploadTransport() {
    uploadSignal.throwIfAborted();
    if (upload) return upload;
    const service = acquireService(uploadSignal);
    let created: ReturnType<typeof createLongMessageResponseTransport> | undefined;
    try {
      created = createLongMessageResponseTransport(service);
    } finally {
      // Constructor inspection can invoke a native method getter. Never retain
      // a candidate created after the lane's deferred cleanup already ran.
      if (uploadSignal.aborted) {
        created?.close();
        uploadSignal.throwIfAborted();
      }
    }
    upload = created;
    return upload;
  }

  return {
    async sendMerged(peer: unknown, nodes: unknown, options: unknown) {
      uploadSignal.throwIfAborted();
      let captured: ReturnType<typeof captureMergedForward>;
      try {
        captured = captureMergedForward(peer, nodes, options);
      } finally {
        uploadSignal.throwIfAborted();
      }
      let destination: NativePeer;
      try {
        const resolve = context.resolvePeer;
        uploadSignal.throwIfAborted();
        destination = await waitUpload(Reflect.apply(resolve, context, [captured.peer]));
      } finally {
        uploadSignal.throwIfAborted();
      }
      return sendCapturedMergedForward(
        captured,
        context.selfUid,
        uploadTransport,
        (card, onDispatch) => {
          uploadSignal.throwIfAborted();
          try {
            const send = context.sendPrepared;
            uploadSignal.throwIfAborted();
            return waitUpload(Reflect.apply(send, context, [destination, [card], onDispatch]));
          } catch (error) {
            uploadSignal.throwIfAborted();
            throw error;
          }
        },
        uploadSignal,
      );
    },
    readResource(value: unknown) {
      context.signal.throwIfAborted();
      const resourceId = normalizeForwardResourceId(value);
      buildForwardResourceRequest(context.selfUid, resourceId);
      context.signal.throwIfAborted();
      // Preserve the existing promise rejection for a locally closed read
      // transport, while account abort remains a synchronous preflight error.
      if (readRetirement.signal.aborted) return Promise.reject(readRetirement.signal.reason);
      if (!read) {
        const service = acquireService(readSignal);
        read = createForwardResourceTransport(service);
      }
      return read.read(context.selfUid, resourceId, { signal: readSignal });
    },
  };
}
