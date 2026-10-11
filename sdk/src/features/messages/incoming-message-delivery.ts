import {
  captureIncomingNativeMessage,
  messageIdentityUids,
  type CapturedNativeMessage,
} from './inbound-messages.ts';
import { needsMentionLookup } from './inbound-mentions.ts';
import type { Message } from '../../contracts/messages.ts';

/** A system-message projector inspects the shared raw batch without acquiring
 * account services or participating in ordinary message lookup and delivery.
 */
export interface IncomingSystemMessagePort {
  hasCandidate(rawMessages: unknown[]): boolean;
  receive(rawMessages: unknown[]): void;
}

export interface IncomingMessageDeliveryContext {
  getSystemMessageHandlers?(): readonly IncomingSystemMessagePort[];
  resolveMessages(
    messages: CapturedNativeMessage[],
    rawMessages: unknown[],
    signal: AbortSignal,
  ): Promise<(Message | undefined)[]>;
  project(message: CapturedNativeMessage, raw: unknown): Message;
  emitMessage(message: Message): void;
  diagnostic(stage: string): void;
  dispatch(rawMessages: unknown[]): void;
}
/** Owns raw-batch ingress, callback snapshots, ordering and bounded deduplication.
 * Closing prevents new lookups and delivery, without pretending to cancel native work.
 * Projection retains the original raw object independently of the captured fields.
 */
export function createIncomingMessageDelivery(context: IncomingMessageDeliveryContext) {
  let closed = false;
  let queue: Promise<void> | undefined;
  const seen = new Set<string>();
  const lifetime = new AbortController();
  const resolve = async (messages: Received[]) => {
    const signal = lifetime.signal;
    signal.throwIfAborted();
    let rejectAbort!: (error: unknown) => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    void stopped.catch(() => {});
    const abort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const provider = context.resolveMessages(
        messages.map((value) => value.message),
        messages.map((value) => value.raw),
        signal,
      );
      return await Promise.race([provider, stopped]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
  const diagnostic = (stage: string) => {
    if (!closed) context.diagnostic(stage);
  };
  const key = (message: CapturedNativeMessage): string | undefined =>
    message.msgId && message.peerUid
      ? JSON.stringify([message.chatType, message.peerUid, message.msgId])
      : message.chatType === 1 && message.msgId && message.peerUin
        ? JSON.stringify([1, 'uin', message.peerUin, message.msgId])
        : undefined;
  type Received = { raw: unknown; message: CapturedNativeMessage; key?: string };
  const unseen = (messages: Received[]) =>
    messages.filter((value) => !value.key || !seen.has(value.key));
  const deliver = (messages: Received[], decoded: (Message | undefined)[]) => {
    if (closed) return;
    messages.forEach((value, index) => {
      if (closed) return;
      const message = decoded[index];
      if (!message || (value.key && seen.has(value.key))) return;
      if (value.key) {
        seen.add(value.key);
        if (seen.size > 10_000) seen.delete(seen.values().next().value!);
      }
      context.emitMessage(message);
    });
    if (!closed) context.dispatch(messages.map((value) => value.raw));
  };
  return {
    receive(input: unknown): void {
      if (closed) return;
      if (!Array.isArray(input)) {
        diagnostic('invalid-native-message-batch');
        return;
      }
      // System projectors consume the original batch before ordinary snapshots.
      // Their lazy binding preserves construction and cleanup order in the
      // composition root without giving it input or callback-dispatch policy.
      const getHandlers = context.getSystemMessageHandlers;
      if (closed) return;
      const handlers = getHandlers?.call(context) ?? [];
      if (closed) return;
      for (const handler of handlers) {
        if (closed) return;
        const matches = handler.hasCandidate;
        if (closed) return;
        const candidate = matches.call(handler, input);
        if (closed) return;
        if (!candidate) continue;
        const receive = handler.receive;
        if (closed) return;
        receive.call(handler, input);
        if (closed) return;
      }
      const messages: Received[] = [];
      for (const raw of Array.from(input)) {
        if (closed) return;
        try {
          const message = captureIncomingNativeMessage(raw);
          if (!message) continue;
          messages.push({ raw, message, key: key(message) });
        } catch {
          diagnostic('invalid-native-message');
        }
      }
      if (closed) return;
      if (
        !queue &&
        !messages.some(
          (value) =>
            messageIdentityUids(value.message).length || needsMentionLookup(value.message.elements),
        )
      ) {
        const values = unseen(messages);
        deliver(
          values,
          values.map((value) => context.project(value.message, value.raw)),
        );
        return;
      }
      const queued = (queue ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          if (closed) return;
          const values = unseen(messages);
          const decoded = await resolve(values);
          deliver(values, decoded);
        });
      queue = queued;
      void queued
        .catch(() => diagnostic('invalid-native-message'))
        .finally(() => {
          if (queue === queued) queue = undefined;
        });
    },
    close(): void {
      if (closed) return;
      closed = true;
      lifetime.abort();
      seen.clear();
    },
  };
}
