import type { Message, Peer } from '../../contracts/messages.ts';
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
  type QueriedNativeMessage,
} from './message-query.ts';

export interface MessageQueriesContext {
  signal: AbortSignal;
  getMessageService(): MessageQueryPort | null | undefined;
  resolvePeer(peer: Peer): Promise<NativePeer>;
  decode(messages: QueriedNativeMessage[]): Promise<(Message | undefined)[]>;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

/** Own query orchestration and projection, while the account owns service handles
 * and cancellation. Capture caller input before any asynchronous resolution.
 * Native validators complete the entire response before decoding begins. No
 * missing item, native failure or cancellation is retried or partially returned.
 */
export function createMessageQueries(context: MessageQueriesContext) {
  const { signal, getMessageService, resolvePeer, decode, awaitAlive } = context;
  const alive = () => signal.throwIfAborted();
  // Capture methods after peer resolution, matching the original query ABI order.
  function captureService(service: MessageQueryPort | null | undefined, history = false) {
    alive();
    if (history) {
      const method = service?.getMsgsIncludeSelf;
      alive();
      return {
        getMsgsIncludeSelf:
          typeof method === 'function'
            ? (...args: Parameters<NonNullable<MessageQueryPort['getMsgsIncludeSelf']>>) => {
                alive();
                return Reflect.apply(method, service, args) as unknown;
              }
            : undefined,
      };
    }
    const method = service?.getMsgsByMsgId;
    alive();
    return {
      getMsgsByMsgId:
        typeof method === 'function'
          ? (...args: Parameters<NonNullable<MessageQueryPort['getMsgsByMsgId']>>) => {
              alive();
              return Reflect.apply(method, service, args) as unknown;
            }
          : undefined,
    };
  }
  return {
    async getMessage(peer: unknown, messageId: unknown): Promise<Message | undefined> {
      const query = normalizeMessageQuery(peer, messageId);
      alive();
      const service = getMessageService();
      alive();
      const nativePeer = await awaitAlive(resolvePeer(query.peer));
      alive();
      const raw = await awaitAlive(
        queryNativeMessage(captureService(service), nativePeer, query.messageId),
      );
      signal.throwIfAborted();
      const decoded = raw === undefined ? undefined : (await awaitAlive(decode([raw])))[0];
      alive();
      return decoded;
    },
    async getMessages(peer: unknown, messageIds: unknown): Promise<(Message | undefined)[]> {
      const query = normalizeMessageBatchQuery(peer, messageIds);
      alive();
      const service = getMessageService();
      alive();
      const nativePeer = await awaitAlive(resolvePeer(query.peer));
      alive();
      const raw = await awaitAlive(
        queryNativeMessages(captureService(service), nativePeer, query.messageIds),
      );
      signal.throwIfAborted();
      const present = raw.filter(
        (message): message is QueriedNativeMessage => message !== undefined,
      );
      const decoded = await awaitAlive(decode(present));
      signal.throwIfAborted();
      const found = new Map<string, Message>();
      for (let index = 0; index < present.length; index++) {
        const message = decoded[index];
        if (!message || message.messageId !== present[index]!.msgId)
          throw new Error('Invalid decoded message query batch');
        found.set(message.messageId, message);
      }
      const result = query.messageIds.map((id) => found.get(id));
      alive();
      return result;
    },
    async getHistory(peerInput: unknown, options: unknown): Promise<Message[]> {
      const query = normalizeHistoryQuery(peerInput, options);
      alive();
      const nativePeer = await awaitAlive(resolvePeer(query.peer));
      alive();
      const service = getMessageService();
      alive();
      const messages = await awaitAlive(
        queryNativeHistory(
          captureService(service, true),
          nativePeer,
          query.before,
          query.count,
          query.reverse,
        ),
      );
      signal.throwIfAborted();
      const decoded = await awaitAlive(decode(messages));
      alive();
      return decoded as Message[];
    },
  };
}
