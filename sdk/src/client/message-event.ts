import type {
  Message,
  MessageEvent,
  MessageInput,
  Peer,
  SentMessage,
} from '../contracts/messages.ts';
import { captureSendInput, sendGroupId, sendUserId } from '../features/messages/send-input.ts';

export interface MessageReplyContext {
  assertActive(): void;
  sendPrivateMessage(userId: string, content: MessageInput): Promise<SentMessage>;
  sendGroupMessage(groupId: string, content: MessageInput): Promise<SentMessage>;
}

function dataField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Bind actions after IPC. Routing is captured before observers can mutate event fields;
 * the source DTO remains serializable and never receives a client or function reference.
 */
export function createMessageEvent(message: Message, context: MessageReplyContext): MessageEvent {
  const sourcePeer = dataField(message, 'peer');
  const type = dataField(sourcePeer, 'type');
  const destination = dataField(sourcePeer, type === 'group' ? 'groupId' : 'userId');
  const peer: Peer | undefined =
    typeof destination === 'string'
      ? type === 'group'
        ? { type, groupId: destination }
        : type === 'private'
          ? { type, userId: destination }
          : undefined
      : undefined;
  const messageId = dataField(message, 'messageId');
  const descriptors = Object.getOwnPropertyDescriptors(message);
  delete descriptors.reply;
  const event = Object.defineProperties({}, descriptors) as MessageEvent;
  Object.defineProperty(event, 'reply', {
    enumerable: false,
    value: async (content: MessageInput, quote = false): Promise<SentMessage> => {
      if (typeof quote !== 'boolean') throw new TypeError('quote must be a boolean');
      context.assertActive();
      if (!peer) throw new Error('Message has no replyable conversation');
      const group = peer.type === 'group';
      const destination =
        peer.type === 'group' ? sendGroupId(peer.groupId) : sendUserId(peer.userId);
      const elements = captureSendInput(content, group);
      const input = quote
        ? captureSendInput([{ type: 'reply', messageId }, ...elements], group)
        : elements;
      // Input capture can execute Proxy traps; check the captured session afterwards.
      context.assertActive();
      return peer.type === 'group'
        ? context.sendGroupMessage(destination, input)
        : context.sendPrivateMessage(destination, input);
    },
  });
  return event;
}
