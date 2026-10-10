import type { NativeObject as Native } from '../../native/native-object.ts';
import type { NativePeer, NativeMessage } from '../../native/message-contracts.ts';
import type { MediaTools, RecordCodec, VideoCodec } from '../../runtime/media-contracts.ts';
import type { MessageIdQueryPort } from './message-query.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';
import { sentReceipt } from './send-input.ts';
import { createImageElement, createFileElement, createReplyElement } from './outbound-elements.ts';
import type { ImageStagingPort } from './outbound-elements.ts';
import { faceElement } from './face-input.ts';
import { createVideoElement } from '../media/media-send.ts';
import { createRecordElement } from '../media/media-record.ts';

export interface MessageSendPort extends MessageIdQueryPort, ImageStagingPort {
  generateMsgUniqueId?: (chatType: 1 | 2, serverTime: unknown) => unknown;
  sendMsg?: (
    id: string,
    peer: NativePeer & { guildId: string },
    elements: Native[],
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
  const elementsFor = async (input: unknown, peer: NativePeer): Promise<Native[]> => {
    alive();
    const elements = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    if (!Array.isArray(elements) || !elements.length)
      throw new Error('Message must contain elements');
    return Promise.all(
      elements.map(async (element: Native) => {
        alive();
        if (element.type === 'text') {
          if (typeof element.text !== 'string') throw new Error('Invalid text element');
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
          if (peer.chatType !== 2) throw new Error('Mentions require a group peer');
          const id = String(element.userId ?? element.id ?? '');
          if (!id) throw new Error('Mention requires userId');
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
        throw new Error(`Unsupported message element: ${String(element.type)}`);
      }),
    );
  };
  const sendPreparedElements = async (
    peer: NativePeer,
    elements: Native[],
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
