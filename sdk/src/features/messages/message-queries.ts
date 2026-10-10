import type { Message, Peer } from '../../contracts/messages.ts';
import type { NativeObject as Native } from '../../native/native-object.ts';
import type { NativePeer } from '../../native/message-contracts.ts';
import {
  normalizeMessageQuery,
  normalizeMessageBatchQuery,
  normalizeHistoryQuery,
} from './query-input.ts';
import {
  queryNativeMessage,
  queryNativeMessages,
  queryNativeHistory,
  type MessageQueryPort,
} from './message-query.ts';

export interface MessageQueriesContext {
  signal: AbortSignal;
  getMessageService(): MessageQueryPort;
  resolvePeer(peer: Peer): Promise<NativePeer>;
  decode(messages: Native[]): Promise<(Message | undefined)[]>;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

/** Own query orchestration and projection, while the account owns service handles
 * and cancellation. Capture caller input before any asynchronous resolution.
 * Native validators complete the entire response before decoding begins. No
 * missing item, native failure or cancellation is retried or partially returned.
 */
export function createMessageQueries(context: MessageQueriesContext) {
  const { signal, getMessageService, resolvePeer, decode, awaitAlive } = context;
  return {
    async getMessage(peer: unknown, messageId: unknown): Promise<Message | undefined> {
      const query = normalizeMessageQuery(peer, messageId);
      const raw = await awaitAlive(
        queryNativeMessage(getMessageService(), await resolvePeer(query.peer), query.messageId),
      );
      signal.throwIfAborted();
      return raw === undefined ? undefined : (await decode([raw]))[0];
    },
    async getMessages(peer: unknown, messageIds: unknown): Promise<(Message | undefined)[]> {
      const query = normalizeMessageBatchQuery(peer, messageIds);
      const raw = await awaitAlive(
        queryNativeMessages(getMessageService(), await resolvePeer(query.peer), query.messageIds),
      );
      signal.throwIfAborted();
      const present = raw.filter((message): message is Native => message !== undefined);
      const decoded = await decode(present);
      signal.throwIfAborted();
      const found = new Map<string, Message>();
      for (let index = 0; index < present.length; index++) {
        const message = decoded[index];
        if (!message || message.messageId !== present[index]!.msgId)
          throw new Error('Invalid decoded message query batch');
        found.set(message.messageId, message);
      }
      return query.messageIds.map((id) => found.get(id));
    },
    async getHistory(peerInput: unknown, options: unknown): Promise<Message[]> {
      const query = normalizeHistoryQuery(peerInput, options);
      const peer = await resolvePeer(query.peer);
      const messages = await awaitAlive(
        queryNativeHistory(getMessageService(), peer, query.before, query.count, query.reverse),
      );
      signal.throwIfAborted();
      return (await decode(messages)) as Message[];
    },
  };
}
