import type { Peer } from '../../contracts/messages.ts';
import type { NativePeer } from '../../native/message-contracts.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';
import { nativeResultError } from '../../errors.ts';
import { captureRecallPayload } from './recall-input.ts';

export interface RecallMessagePort {
  recallMsg?(peer: NativePeer, messageIds: string[]): unknown;
}
export interface RecallContext {
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T>;
  resolvePeer(value: Peer): Promise<NativePeer>;
  getMessageService(): RecallMessagePort | null | undefined;
  eventCall: NativeEventChannel['call'];
}
function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function succeeded(value: unknown): boolean {
  let result: unknown;
  try {
    result = Array.isArray(value) ? undefined : data(value, 'result');
  } catch {
    result = undefined;
  }
  if (result !== 0)
    throw nativeResultError('Native operation rejected: Msg/onMsgInfoListUpdate', { result });
  return true;
}
function matches(value: unknown, peer: NativePeer, id: string): boolean {
  try {
    if (!Array.isArray(value)) return false;
    const length = data(value, 'length');
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return false;
    for (let index = 0; index < length; index++) {
      const row = data(value, String(index));
      const chatType = data(row, 'chatType');
      const peerUid = data(row, 'peerUid');
      const msgId = data(row, 'msgId');
      const recallTime = data(row, 'recallTime');
      if (
        chatType === peer.chatType &&
        peerUid === peer.peerUid &&
        msgId === id &&
        typeof recallTime === 'string' &&
        /^\d+$/.test(recallTime) &&
        /[1-9]/.test(recallTime)
      )
        return true;
    }
  } catch {
    return false;
  }
  return false;
}
/** Own only recall cancellation; the shared callback channel remains with Session. */
export function createMessageRecalls(context: RecallContext) {
  const local = new AbortController();
  const signal = AbortSignal.any([context.signal, local.signal]);
  return {
    async recall(payload: unknown): Promise<void> {
      const captured = captureRecallPayload(payload);
      signal.throwIfAborted();
      const resolved = await context.awaitAlive(context.resolvePeer(captured.peer), signal);
      const chatType = data(resolved, 'chatType');
      const peerUid = data(resolved, 'peerUid');
      if (
        (chatType !== 1 && chatType !== 2) ||
        chatType !== (captured.peer.type === 'private' ? 1 : 2) ||
        typeof peerUid !== 'string' ||
        !peerUid.trim()
      )
        throw new Error('Native recall peer is invalid');
      const correlationPeer: NativePeer = { chatType, peerUid };
      const nativePeer: NativePeer = { chatType, peerUid };
      signal.throwIfAborted();
      const service = context.getMessageService();
      signal.throwIfAborted();
      const method = service?.recallMsg;
      signal.throwIfAborted();
      if (typeof method !== 'function') throw new Error('Native service is missing recallMsg');
      await context.eventCall(
        'Msg/onMsgInfoListUpdate',
        (updates: unknown) => matches(updates, correlationPeer, captured.messageId) || undefined,
        () => {
          signal.throwIfAborted();
          return Reflect.apply(method, service, [nativePeer, [captured.messageId]]);
        },
        10_000,
        succeeded,
        signal,
      );
      signal.throwIfAborted();
    },
    close(): void {
      if (!local.signal.aborted) local.abort(new Error('Message recalls are closed'));
    },
  };
}
