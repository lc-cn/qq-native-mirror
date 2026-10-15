import type { MessageInput, Peer, SentMessage } from '../contracts/messages.ts';
import type { MessageEvent } from './events.ts';
import { captureSendInput, sendGroupId, sendUserId } from '../features/messages/send-input.ts';
import type { ContactContext } from './contacts/contact-context.ts';
import { FriendContact } from './contacts/friend-contact.ts';
import { GroupContact } from './contacts/group-contact.ts';
import { GroupMemberContact } from './contacts/group-member-contact.ts';

function snapshot(value: unknown): PropertyDescriptorMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  return Object.getOwnPropertyDescriptors(value);
}

function dataField(
  descriptors: Readonly<Record<string, PropertyDescriptor | undefined>>,
  key: string,
): unknown {
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

/** Text is a projection of received text elements, not a serialization of media.
 * Read data slots directly so caller accessors and iterators cannot supply text.
 */
function captureText(elements: unknown): string {
  if (!Array.isArray(elements)) return '';
  const slots = Object.getOwnPropertyDescriptors(elements);
  const length = dataField(slots, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return '';
  let text = '';
  // Descriptor keys enumerate array indices in order without traversing sparse
  // holes or consulting the source array's iterator.
  for (const key of Object.keys(slots)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) continue;
    const element = snapshot(dataField(slots, key));
    if (!element || dataField(element, 'type') !== 'text') continue;
    const value = dataField(element, 'text');
    if (typeof value === 'string') text += value;
  }
  return text;
}

/** Bind actions after IPC. Routing, text and contacts are captured before observers
 * can mutate DTO fields; the source never receives client or function references.
 */
export function createMessageEvent(
  message: unknown,
  context: ContactContext,
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
    const text = captureText(dataField(captured, 'elements'));
    // Reserve every live field, including aliases that do not belong to this
    // peer type. Worker data must not introduce a second destination or action.
    for (const name of ['reply', 'conversation', 'friend', 'group', 'member'])
      delete descriptors[name];
    descriptors.peer = { value: peer, enumerable: true, writable: false, configurable: false };
    descriptors.text = { value: text, enumerable: true, writable: false, configurable: false };
    if (peer.type === 'group') {
      const sender = snapshot(dataField(captured, 'sender'));
      const userId = sender && dataField(sender, 'userId');
      if (typeof userId !== 'string') return;
      const group = new GroupContact(context, peer.groupId);
      const member = new GroupMemberContact(context, peer.groupId, userId);
      descriptors.conversation = { value: group };
      descriptors.group = { value: group };
      descriptors.member = { value: member };
    } else {
      const friend = new FriendContact(context, peer.userId);
      descriptors.conversation = { value: friend };
      descriptors.friend = { value: friend };
    }
  } catch {
    // The same snapshot owns display and action identity. Descriptor failures or
    // unaddressable contact data reject presentation without leaking native data.
    return;
  }
  const event = Object.defineProperties({}, descriptors) as MessageEvent;
  Object.defineProperty(event, 'reply', {
    enumerable: false,
    value: async (content: MessageInput, quote = false): Promise<SentMessage> => {
      if (typeof quote !== 'boolean') throw new TypeError('quote must be a boolean');
      context.assertActive();
      const group = peer.type === 'group';
      const elements = captureSendInput(content, group);
      const input = quote
        ? captureSendInput([{ type: 'reply', messageId }, ...elements], group)
        : elements;
      // Input capture can execute Proxy traps; check the captured session afterwards.
      context.assertActive();
      return peer.type === 'group'
        ? context.invoke('sendGroupMessage', { groupId: peer.groupId, message: input })
        : context.invoke('sendPrivateMessage', { userId: peer.userId, message: input });
    },
  });
  return event;
}
