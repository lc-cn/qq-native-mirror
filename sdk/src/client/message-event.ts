import type { MessageEvent, MessageInput, Peer, SentMessage } from '../contracts/messages.ts';
import { captureSendInput, sendGroupId, sendUserId } from '../features/messages/send-input.ts';

export interface MessageReplyContext {
  assertActive(): void;
  sendPrivateMessage(userId: string, content: MessageInput): Promise<SentMessage>;
  sendGroupMessage(groupId: string, content: MessageInput): Promise<SentMessage>;
}

function snapshot(value: unknown): PropertyDescriptorMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  return Object.getOwnPropertyDescriptors(value);
}

function dataField(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Only an explicit, addressable conversation can become a typed message event. */
function capturePeer(descriptors: PropertyDescriptorMap): Readonly<Peer> | undefined {
  const source = snapshot(dataField(descriptors, 'peer'));
  if (!source) return;
  const type = dataField(source, 'type');
  if (type === 'group')
    return Object.freeze({ type, groupId: sendGroupId(dataField(source, 'groupId')) });
  if (type === 'private')
    return Object.freeze({ type, userId: sendUserId(dataField(source, 'userId')) });
}

/** Bind actions after IPC. Routing is captured before observers can mutate event fields;
 * the source DTO remains serializable and never receives a client or function reference.
 */
export function createMessageEvent(
  message: unknown,
  context: MessageReplyContext,
): MessageEvent | undefined {
  let descriptors: PropertyDescriptorMap;
  let peer: Readonly<Peer>;
  let messageId: unknown;
  try {
    const captured = snapshot(message);
    if (!captured) return;
    const capturedPeer = capturePeer(captured);
    if (!capturedPeer) return;
    descriptors = captured;
    peer = capturedPeer;
    messageId = dataField(captured, 'messageId');
  } catch {
    // The same snapshot owns display and reply identity. Any descriptor failure
    // rejects presentation without leaking native details or invoking observers.
    return;
  }
  delete descriptors.reply;
  descriptors.peer = { value: peer, enumerable: true, writable: false, configurable: false };
  const event = Object.defineProperties({}, descriptors) as MessageEvent;
  Object.defineProperty(event, 'reply', {
    enumerable: false,
    value: async (content: MessageInput, quote = false): Promise<SentMessage> => {
      if (typeof quote !== 'boolean') throw new TypeError('quote must be a boolean');
      context.assertActive();
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
