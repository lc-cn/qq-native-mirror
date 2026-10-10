import { captureElementBatches, decodeCapturedElements } from './inbound-mentions.ts';
import { nativeUid, positiveDecimal, resolveNativeUins } from './native-identities.ts';
import type { Message, MessageElement } from '../../types.ts';
import type { NativeObject as Native } from '../../native/native-object.ts';
const originalElements = new WeakMap<Native, unknown[]>();

function accountIdentity(uin: unknown, uid: unknown): { uin?: string; uid: string } {
  if (uid !== undefined && uid !== '' && !nativeUid(uid))
    throw new Error('Invalid native message user UID');
  if (positiveDecimal(uin)) return { uin, uid: typeof uid === 'string' ? uid : '' };
  if (uin !== undefined && uin !== '' && !(typeof uin === 'string' && /^0+$/.test(uin)))
    throw new Error('Invalid native message user identifier');
  if (!nativeUid(uid)) throw new Error('Native message identity requires a user UID');
  return { uid };
}
function metadata(message: Native) {
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    (message.chatType !== 1 && message.chatType !== 2)
  )
    throw new Error('Invalid native message conversation');
  if (
    !positiveDecimal(message.msgId) ||
    typeof message.msgSeq !== 'string' ||
    !/^\d+$/.test(message.msgSeq) ||
    typeof message.msgTime !== 'string' ||
    !/^\d+$/.test(message.msgTime) ||
    !Number.isSafeInteger(Number(message.msgTime))
  )
    throw new Error('Invalid native message receipt metadata');
  if (message.sendNickName !== undefined && typeof message.sendNickName !== 'string')
    throw new Error('Invalid native message nickname');
  const sender = accountIdentity(message.senderUin, message.senderUid);
  const peer =
    message.chatType === 1 ? accountIdentity(message.peerUin, message.peerUid) : undefined;
  if (message.chatType === 2 && !positiveDecimal(message.peerUid))
    throw new Error('Invalid native message group identifier');
  return {
    messageId: message.msgId as string,
    sequence: message.msgSeq as string,
    time: Number(message.msgTime),
    chatType: message.chatType as 1 | 2,
    peerUid: message.peerUid as string,
    peer,
    sender,
    nickname: message.sendNickName ?? '',
  };
}
export function messageIdentityUids(message: Native): string[] {
  const value = metadata(message);
  return [
    ...new Set(
      [
        value.peer?.uin === undefined ? value.peer?.uid : undefined,
        value.sender.uin === undefined ? value.sender.uid : undefined,
      ].filter((uid): uid is string => uid !== undefined),
    ),
  ];
}
/** Capture at callback receipt, including callbacks queued behind earlier lookups. */
export function captureNativeMessage(raw: Native): Native {
  metadata(raw);
  if (!Array.isArray(raw.elements)) throw new Error('Invalid native message elements');
  const elements = Array.from(raw.elements, (element) => {
    if (!element || typeof element !== 'object' || Array.isArray(element))
      throw new Error('Invalid native message element');
    const descriptors = Object.getOwnPropertyDescriptors(element);
    for (const field of [
      'textElement',
      'replyElement',
      'faceElement',
      'picElement',
      'fileElement',
      'videoElement',
      'pttElement',
      'arkElement',
      'multiForwardMsgElement',
    ]) {
      const descriptor = descriptors[field];
      if (!descriptor || !('value' in descriptor)) continue;
      const value = descriptor.value;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        descriptor.value = Object.create(
          Object.getPrototypeOf(value),
          Object.getOwnPropertyDescriptors(value),
        );
      }
    }
    return Object.create(Object.getPrototypeOf(element), descriptors);
  });
  const captured = { ...raw, elements };
  originalElements.set(captured, originalElements.get(raw) ?? Array.from(raw.elements));
  return captured;
}
export function projectNativeMessage(
  message: Native,
  elements: MessageElement[],
  uins: ReadonlyMap<string, string>,
  raw: unknown = message,
): Message {
  const value = metadata(message);
  const senderId = value.sender.uin ?? uins.get(value.sender.uid);
  const privateId =
    value.peer?.uin ?? (value.peer === undefined ? undefined : uins.get(value.peer.uid));
  if (!positiveDecimal(senderId) || (value.chatType === 1 && !positiveDecimal(privateId)))
    throw new Error('Unresolved native message account identity');
  const originals = originalElements.get(message);
  const projectedElements =
    originals === undefined
      ? elements
      : elements.map((element, index) =>
          element.type === 'unknown' ? { ...element, data: originals[index] } : element,
        );
  return {
    messageId: value.messageId,
    sequence: value.sequence,
    time: value.time,
    peer:
      value.chatType === 2
        ? { type: 'group', groupId: value.peerUid }
        : { type: 'private', userId: privateId! },
    sender: { userId: senderId, uid: value.sender.uid, nickname: value.nickname },
    elements: projectedElements,
    raw,
  };
}
export async function decodeNativeMessages(
  messages: Native[],
  rawMessages: unknown[],
  resolveUins: (uids: string[]) => Promise<ReadonlyMap<string, string>>,
  signal: AbortSignal,
  diagnostic: (stage: string) => void,
  live = false,
): Promise<(Message | undefined)[]> {
  signal.throwIfAborted();
  const snapshots = Array.from(messages, captureNativeMessage);
  const identities = snapshots.flatMap(messageIdentityUids);
  const captured = captureElementBatches(snapshots.map((message) => message.elements));
  const uins = await resolveNativeUins(
    [...identities, ...captured.uids],
    resolveUins,
    signal,
    diagnostic,
    identities.length ? 'native-message-identity-lookup-failed' : 'native-mention-lookup-failed',
    identities.length ? 'unresolved-native-message-identity' : 'unresolved-native-mention',
  );
  signal.throwIfAborted();
  const elements = decodeCapturedElements(captured, uins);
  return snapshots.map((message, index) => {
    try {
      return projectNativeMessage(message, elements[index], uins, rawMessages[index]);
    } catch (error) {
      if (!live) throw error;
      diagnostic('unresolved-native-message-identity');
      return undefined;
    }
  });
}
