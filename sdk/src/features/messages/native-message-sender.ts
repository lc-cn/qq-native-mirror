import type { NativePeer, NativeMessage } from '../../native/message-contracts.ts';
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
import { captureSendInput, sentReceipt } from './send-input.ts';
import { createImageElement, createFileElement, createReplyElement } from './outbound-elements.ts';
import { faceElement } from './face-input.ts';
import { createVideoElement } from '../media/media-send.ts';
import { createRecordElement } from '../media/media-record.ts';

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
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
  uidFor(id: string): Promise<string>;
  eventCall: NativeEventChannel['call'];
  media?: { tools?: MediaTools; recordCodec?: RecordCodec; videoCodec?: VideoCodec };
}
/** Owns element preparation and send correlation, never account state or retries.
 * Uses the Session's shared callback channel so send/recall subscription order is stable.
 * Construction performs no native work. The Session aborts the shared channel
 * before cleanup; sender close then invalidates future use and clears reserved IDs.
 */
export function createNativeMessageSender(context: NativeMessageSenderContext) {
  const { signal, getMessageService, getServerTimeService, awaitAlive, uidFor, eventCall } =
    context;
  const { tools: mediaTools, recordCodec, videoCodec } = context.media ?? {};
  let closed = false;
  const usedSendIds = new Set<string>();
  const alive = () => {
    signal.throwIfAborted();
    if (closed) throw new Error('Native message sender is closed');
  };
  const nativeCallSucceeded = (value: unknown) =>
    (value as { result?: unknown } | null | undefined)?.result === 0;
  const elementMessageService = (method: string): MessageSendPort => {
    const service = getMessageService();
    alive();
    if (!service) throw new Error(`Native service is missing ${method}`);
    return service;
  };
  const elementsFor = async (
    input: unknown,
    peer: NativePeer,
  ): Promise<PreparedMessageElement[]> => {
    alive();
    // Capture the complete caller batch before any asynchronous preparation.
    // Constructors then consume the same discriminated contract as the facade.
    const elements = captureSendInput(input, peer.chatType === 2);
    return Promise.all(
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
              atNtUid: all ? 'all' : await uidFor(id),
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
    const uniqueId = await awaitAlive(generated);
    alive();
    if (typeof uniqueId !== 'string' || !uniqueId.trim())
      throw new Error('Invalid native send correlation identifier');
    if (usedSendIds.has(uniqueId)) throw new Error('Duplicate native send correlation identifier');
    usedSendIds.add(uniqueId);
    const destination = { ...peer, guildId: uniqueId };
    const sent = await eventCall(
      'Msg/onMsgInfoListUpdate',
      (updates: NativeMessage[]) => {
        const matching = updates.filter(
          (message) =>
            message.guildId === uniqueId &&
            (message.chatType === undefined || message.chatType === peer.chatType) &&
            (message.peerUid === undefined || message.peerUid === peer.peerUid),
        );
        const message = matching.find((message) => message.sendStatus === 2);
        if (message) return sentReceipt(message);
        if (matching.some((message) => message.sendStatus === 0))
          throw new Error('Native message send failed');
        return undefined;
      },
      () => {
        alive();
        onDispatch?.();
        alive();
        const sendMsg = messages?.sendMsg;
        alive();
        if (typeof sendMsg !== 'function') throw new Error('Native service is missing sendMsg');
        return Reflect.apply(sendMsg, messages, ['0', destination, elements, new Map()]) as unknown;
      },
      10_000,
      nativeCallSucceeded,
    );
    alive();
    return sent;
  };
  const send = async (peer: NativePeer, input: unknown) =>
    sendPreparedElements(peer, await elementsFor(input, peer));
  return {
    send,
    sendPrepared: sendPreparedElements,
    close() {
      closed = true;
      usedSendIds.clear();
    },
  };
}
