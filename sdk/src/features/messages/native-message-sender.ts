import type { NativePeer } from '../../native/message-contracts.ts';
import type { SentMessage } from '../../contracts/messages.ts';
import type {
  PreparedMessageElement,
  PreparedSendElement,
} from '../../native/prepared-message-contracts.ts';
import type {
  MediaTools,
  RecordCodec,
  VideoCodec,
  MediaStagingPort,
} from '../../runtime/media-contracts.ts';
import type { MessageIdQueryPort } from './message-query.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';
import { captureSendInput, capturePrivateMessage, captureGroupMessage } from './send-input.ts';
import { createImageElement, createFileElement, createReplyElement } from './outbound-elements.ts';
import { faceElement } from './face-input.ts';
import { createVideoElement } from '../media/media-send.ts';
import { createRecordElement } from '../media/media-record.ts';

function record(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Native callback fields must be own data. An accessor cannot stand in for an
 * absent optional field or replace a validated receipt between reads. */
function data(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !('value' in descriptor))
    throw new Error('Invalid native sent message receipt data');
  return descriptor?.value;
}
function sentReceipt(message: object): SentMessage {
  const messageId = data(message, 'msgId');
  const sequence = data(message, 'msgSeq');
  const rawTime = data(message, 'msgTime');
  if (
    typeof messageId !== 'string' ||
    !/^\d+$/.test(messageId) ||
    !/[1-9]/.test(messageId) ||
    typeof sequence !== 'string' ||
    !/^\d+$/.test(sequence) ||
    typeof rawTime !== 'string' ||
    !/^\d+$/.test(rawTime)
  )
    throw new Error('Invalid native sent message receipt metadata');
  const time = Number(rawTime);
  if (!Number.isSafeInteger(time) || time < 0)
    throw new Error('Invalid native sent message receipt time');
  return { messageId, sequence, time };
}
function sendUpdateReceipt(
  updates: unknown,
  uniqueId: string,
  peer: NativePeer,
): SentMessage | undefined {
  if (!Array.isArray(updates)) throw new Error('Invalid native send update batch');
  const length = data(updates, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    throw new Error('Invalid native send update batch');
  const matching: { message: object; status: unknown }[] = [];
  for (let index = 0; index < length; index++) {
    const message = data(updates, String(index));
    if (!record(message)) throw new Error('Invalid native send update row');
    if (data(message, 'guildId') !== uniqueId) continue;
    const chatType = data(message, 'chatType');
    if (chatType !== undefined && chatType !== peer.chatType) continue;
    const peerUid = data(message, 'peerUid');
    if (peerUid !== undefined && peerUid !== peer.peerUid) continue;
    matching.push({ message, status: data(message, 'sendStatus') });
  }
  // Keep the existing batch policy: a matching terminal success takes precedence
  // over matching failure rows, and the first success supplies the receipt.
  const success = matching.find(({ status }) => status === 2);
  if (success) return sentReceipt(success.message);
  if (matching.some(({ status }) => status === 0)) throw new Error('Native message send failed');
  return undefined;
}

export interface MessageSendPort extends MessageIdQueryPort, MediaStagingPort {
  generateMsgUniqueId?: (chatType: 1 | 2, serverTime: unknown) => unknown;
  sendMsg?: (
    id: string,
    peer: NativePeer & { guildId: string },
    elements: PreparedSendElement[],
    attributes: Map<unknown, unknown>,
  ) => unknown;
}
export interface ServerTimePort {
  getServerTime?: () => unknown;
}

export interface NativeMessageSenderContext {
  signal: AbortSignal;
  getMessageService(): MessageSendPort | null | undefined;
  getServerTimeService(): ServerTimePort | null | undefined;
  awaitAlive<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T>;
  uidFor(id: string): Promise<string>;
  eventCall: NativeEventChannel['call'];
  media?: { tools?: MediaTools; recordCodec?: RecordCodec; videoCodec?: VideoCodec };
}
/** Owns element preparation and send correlation, never account state or retries.
 * Uses the Session's shared callback channel so send/recall subscription order is stable.
 * Construction performs no native work. Its local abort cancels only its waits;
 * the Session retains ownership of the shared channel. Close clears reserved IDs.
 */
export function createNativeMessageSender(context: NativeMessageSenderContext) {
  const { getMessageService, getServerTimeService, awaitAlive, uidFor, eventCall } = context;
  const local = new AbortController();
  const signal = AbortSignal.any([context.signal, local.signal]);
  const { tools: mediaTools, recordCodec, videoCodec } = context.media ?? {};
  const usedSendIds = new Set<string>();
  const alive = () => {
    signal.throwIfAborted();
  };
  const isChannelClosedError = (error: unknown): boolean => {
    try {
      if (!error || typeof error !== 'object') return false;
      const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
      return (
        !!descriptor &&
        'value' in descriptor &&
        descriptor.value === 'Client closed during native operation'
      );
    } catch {
      // Opaque native failures, including revoked proxies, retain their identity.
      return false;
    }
  };
  const nativeCallSucceeded = (value: unknown) =>
    (value as { result?: unknown } | null | undefined)?.result === 0;
  const elementMessageService = (method: string): MessageIdQueryPort & MediaStagingPort => {
    const service = getMessageService();
    alive();
    if (!service) throw new Error(`Native service is missing ${method}`);
    // These two ports preserve each constructor's property-access order. A late
    // FS/codec completion may continue, but cannot enter native staging after close.
    return {
      get getRichMediaFilePathForGuild() {
        alive();
        const member = service.getRichMediaFilePathForGuild;
        alive();
        if (typeof member !== 'function') return member;
        return (
          request: Parameters<NonNullable<MediaStagingPort['getRichMediaFilePathForGuild']>>[0],
        ) => {
          alive();
          return Reflect.apply(member, service, [request]) as unknown;
        };
      },
      get getMsgsByMsgId() {
        alive();
        const member = service.getMsgsByMsgId;
        alive();
        if (typeof member !== 'function') return member;
        return (peer: NativePeer, ids: string[]) => {
          alive();
          return Reflect.apply(member, service, [peer, ids]) as unknown;
        };
      },
    };
  };
  const elementsFor = async (
    input: unknown,
    peer: NativePeer,
  ): Promise<PreparedMessageElement[]> => {
    alive();
    // Capture the complete caller batch before any asynchronous preparation.
    // Constructors then consume the same discriminated contract as the facade.
    const elements = captureSendInput(input, peer.chatType === 2);
    return awaitAlive(
      Promise.all(
        elements.map(async (element): Promise<PreparedMessageElement> => {
          alive();
          if (element.type === 'text') {
            return {
              elementType: 1,
              elementId: '',
              textElement: {
                content: element.text,
                atType: 0,
                atUid: '',
                atTinyId: '',
                atNtUid: '',
              },
            };
          }
          if (element.type === 'at') {
            const id = element.userId;
            const all = id === 'all';
            return {
              elementType: 1,
              elementId: '',
              textElement: {
                content: `@${element.text ?? (all ? '全体成员' : id)}`,
                atType: all ? 1 : 2,
                atUid: id,
                atTinyId: '',
                atNtUid: all ? 'all' : await awaitAlive(uidFor(id), signal),
              },
            };
          }
          if (element.type === 'face') return faceElement(element.id);
          if (element.type === 'image')
            return createImageElement(
              element.file,
              elementMessageService('getRichMediaFilePathForGuild'),
            );
          if (element.type === 'video')
            return createVideoElement(
              element.file,
              elementMessageService('getRichMediaFilePathForGuild'),
              mediaTools,
              videoCodec,
              signal,
            );
          if (element.type === 'record')
            return createRecordElement(
              element.file,
              elementMessageService('getRichMediaFilePathForGuild'),
              recordCodec,
            );
          if (element.type === 'file') return createFileElement(element.file, element.name);
          if (element.type === 'reply')
            return createReplyElement(
              element.messageId,
              peer,
              elementMessageService('getMsgsByMsgId'),
            );
          const unsupported: never = element;
          throw new Error(`Unsupported message element: ${String(unsupported)}`);
        }),
      ),
      signal,
    );
  };
  const sendPreparedElements = async (
    peer: NativePeer,
    elements: PreparedSendElement[],
    onDispatch?: () => void,
  ) => {
    alive();
    const messages = getMessageService();
    alive();
    const msf = getServerTimeService();
    alive();
    const getServerTime = msf?.getServerTime;
    alive();
    if (typeof getServerTime !== 'function')
      throw new Error('Native service is missing getServerTime');
    const serverTime: unknown = Reflect.apply(getServerTime, msf, []);
    alive();
    const generateMsgUniqueId = messages?.generateMsgUniqueId;
    alive();
    if (typeof generateMsgUniqueId !== 'function')
      throw new Error('Native service is missing generateMsgUniqueId');
    const generated: unknown = Reflect.apply(generateMsgUniqueId, messages, [
      peer.chatType,
      serverTime,
    ]);
    const uniqueId = await awaitAlive(generated, signal);
    alive();
    if (typeof uniqueId !== 'string' || !uniqueId.trim())
      throw new Error('Invalid native send correlation identifier');
    if (usedSendIds.has(uniqueId)) throw new Error('Duplicate native send correlation identifier');
    usedSendIds.add(uniqueId);
    const destination = { ...peer, guildId: uniqueId };
    // Vendor code receives a mutable destination. It cannot change which
    // conversation the callback must acknowledge by rewriting that argument.
    const correlation = { chatType: destination.chatType, peerUid: destination.peerUid };
    let dispatched = false;
    try {
      const sent = await eventCall(
        'Msg/onMsgInfoListUpdate',
        (updates: unknown) => {
          try {
            return sendUpdateReceipt(updates, uniqueId, correlation);
          } finally {
            alive();
          }
        },
        () => {
          alive();
          onDispatch?.();
          alive();
          const sendMsg = messages?.sendMsg;
          alive();
          if (typeof sendMsg !== 'function') throw new Error('Native service is missing sendMsg');
          dispatched = true;
          return Reflect.apply(sendMsg, messages, [
            '0',
            destination,
            elements,
            new Map(),
          ]) as unknown;
        },
        10_000,
        nativeCallSucceeded,
        signal,
      );
      alive();
      return sent;
    } catch (error) {
      // Preserve native failures and validation errors. Only cancellation after
      // the actual write invocation changes to the unknown-effect completion.
      if (
        dispatched &&
        signal.aborted &&
        (error === signal.reason || (context.signal.aborted && isChannelClosedError(error)))
      )
        throw new Error('Native message sender is closed after dispatch; remote effect unknown', {
          cause: error,
        });
      throw error;
    }
  };
  const send = async (peer: NativePeer, input: unknown) =>
    sendPreparedElements(peer, await elementsFor(input, peer));
  return {
    send,
    async sendPrivateMessage(userId: unknown, message: unknown) {
      const captured = capturePrivateMessage(userId, message);
      alive();
      const uid = await awaitAlive(uidFor(captured.userId), signal);
      alive();
      if (typeof uid !== 'string' || !uid.trim()) throw new Error('Invalid native peer UID');
      return send({ chatType: 1, peerUid: uid }, captured.message);
    },
    async sendGroupMessage(groupId: unknown, message: unknown) {
      const captured = captureGroupMessage(groupId, message);
      alive();
      return send({ chatType: 2, peerUid: captured.groupId }, captured.message);
    },
    sendPrepared: sendPreparedElements,
    close() {
      if (!local.signal.aborted) local.abort(new Error('Native message sender is closed'));
      usedSendIds.clear();
    },
  };
}
