import { captureMergedForward } from './merged-forward-input.ts';
import { sendCapturedMergedForward } from './merged-forward.ts';
import type { buildMergedForwardCard } from './merged-forward-card.ts';
import {
  createLongMessageResponseTransport,
  type LongMessageResponseService,
} from './long-message-response.ts';
import { createForwardResourceTransport } from './forward-resource-transport.ts';
import {
  buildForwardResourceRequest,
  normalizeForwardResourceId,
} from './forward-resource-wire.ts';
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
  let upload: ReturnType<typeof createLongMessageResponseTransport> | undefined;
  let read: ReturnType<typeof createForwardResourceTransport> | undefined;
  context.defer(() => upload?.close());
  context.defer(() => read?.close());
  return {
    async sendMerged(peer: unknown, nodes: unknown, options: unknown) {
      const captured = captureMergedForward(peer, nodes, options);
      const destination = await context.resolvePeer(captured.peer);
      context.signal.throwIfAborted();
      return sendCapturedMergedForward(
        captured,
        context.selfUid,
        () => (upload ??= createLongMessageResponseTransport(context.getMessageService())),
        (card, onDispatch) => context.sendPrepared(destination, [card], onDispatch),
        context.signal,
      );
    },
    readResource(value: unknown) {
      const resourceId = normalizeForwardResourceId(value);
      buildForwardResourceRequest(context.selfUid, resourceId);
      context.signal.throwIfAborted();
      return (read ??= createForwardResourceTransport(context.getMessageService())).read(
        context.selfUid,
        resourceId,
        { signal: context.signal },
      );
    },
  };
}
