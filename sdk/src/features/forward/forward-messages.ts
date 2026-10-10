import { nativeResultError } from '../../errors.ts';
/** Pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/msg.ts#L45-L48
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/msg.ts#L282-L284
 * Native MsgService getMultiMsg/forwardMsg both declare GeneralCallResult.
 * Forwarding here forwards existing message IDs; it does not synthesize identities.
 */
import type { Message, Peer } from '../../contracts/messages.ts';

export type NativeForwardPeer = { chatType: 1 | 2; peerUid: string; guildId?: string };
export type ForwardOperation = 'getForwardMessages' | 'forwardMessages';
function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error(`${name} must be a numeric string`);
  return value;
}
function peer(value: unknown, name: string): Peer {
  if (!value || typeof value !== 'object') throw new Error(`${name} must be a peer`);
  const p = value as Record<string, unknown>;
  const type = p.type;
  if (type === 'private') return { type: 'private', userId: id(p.userId, `${name}.userId`) };
  if (type === 'group') return { type: 'group', groupId: id(p.groupId, `${name}.groupId`) };
  throw new Error(`${name}.type must be private or group`);
}
function check(result: unknown, method: string): asserts result is Record<string, unknown> {
  const status =
    result && typeof result === 'object' ? (result as Record<string, unknown>).result : undefined;
  if (!result || typeof result !== 'object' || status !== 0) {
    const code = typeof status === 'number' ? status : 'invalid-result';
    throw nativeResultError(`Native ${method} failed (code=${code})`, result);
  }
}
export interface ForwardMessagePort {
  getMultiMsg?: (peer: NativeForwardPeer, root: string, parent: string) => unknown;
  forwardMsg?: (
    ids: string[],
    source: NativeForwardPeer,
    destinations: NativeForwardPeer[],
    attributes: Map<unknown, unknown>,
  ) => unknown;
}
export interface ForwardMessagesContext {
  getMessageService(): ForwardMessagePort | null | undefined;
  resolvePeer(peer: Peer): Promise<NativeForwardPeer>;
  decodeMessage(
    message: Record<string, unknown>,
  ): Message | undefined | Promise<Message | undefined>;
  decodeMessages?(messages: Record<string, unknown>[]): Promise<(Message | undefined)[]>;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
export function createForwardMessages(context: ForwardMessagesContext) {
  const { resolvePeer, decodeMessage, decodeMessages, signal, awaitAlive } = context;
  let closed = false;
  const controller = new AbortController();
  const checkAlive = () => {
    signal.throwIfAborted();
    if (closed) throw new Error('Forward operation closed');
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    controller.abort(signal.aborted ? signal.reason : new Error('Forward operation closed'));
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  const call = <K extends keyof ForwardMessagePort>(
    name: K,
    args: Parameters<NonNullable<ForwardMessagePort[K]>>,
  ) => {
    checkAlive();
    const service = context.getMessageService();
    checkAlive();
    const method = service?.[name];
    checkAlive();
    if (typeof method !== 'function') throw new Error(`Native message service is missing ${name}`);
    return Reflect.apply(method, service, args) as unknown;
  };
  async function alive<T>(invoke: () => T | PromiseLike<T>): Promise<T> {
    checkAlive();
    const pending = Promise.resolve(invoke());
    if (controller.signal.aborted) {
      void pending.catch(() => {});
      throw controller.signal.reason;
    }
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([awaitAlive(pending), stopped]);
      checkAlive();
      return value;
    } finally {
      controller.signal.removeEventListener('abort', abort);
    }
  }
  async function invokeOperation(
    method: ForwardOperation,
    payload: Record<string, unknown>,
  ): Promise<Message[] | void> {
    checkAlive();
    if (method === 'getForwardMessages') {
      const source = peer(payload.peer, 'peer');
      const root = id(payload.rootMessageId, 'rootMessageId');
      const parent = id(payload.parentMessageId, 'parentMessageId');
      const resolved = await alive(() => resolvePeer(source));
      const result = await alive(() => call('getMultiMsg', [resolved, root, parent]));
      checkAlive();
      check(result, 'getMultiMsg');
      checkAlive();
      const rawList = result.msgList;
      if (!Array.isArray(rawList))
        throw new Error('Native getMultiMsg returned an invalid message list');
      // Merged contents may originate from different conversations. Validate the
      // complete batch without asserting that every record belongs to the root peer.
      const messages = Array.from(rawList, (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new Error('Native getMultiMsg returned an invalid message');
        const record = raw as Record<string, unknown>;
        const messageId = record.msgId,
          chatType = record.chatType,
          elements = record.elements;
        if (typeof messageId !== 'string' || !/^\d+$/.test(messageId))
          throw new Error('Native getMultiMsg returned an invalid message ID');
        if (chatType !== 1 && chatType !== 2)
          throw new Error('Native forwarded message has an unsupported conversation type');
        if (
          !Array.isArray(elements) ||
          Array.from(elements).some(
            (element) => !element || typeof element !== 'object' || Array.isArray(element),
          )
        )
          throw new Error('Native getMultiMsg returned invalid message elements');
        return record;
      });
      const decodedMessages = await alive(() =>
        decodeMessages
          ? decodeMessages(messages)
          : Promise.all(
              messages.map((message) => {
                checkAlive();
                const pending = Promise.resolve(decodeMessage(message));
                // A later synchronous decoder may retire or throw before Promise.all
                // is created; already-started decodes must still be observed.
                void pending.catch(() => {});
                return pending;
              }),
            ),
      );
      checkAlive();
      if (decodedMessages.length !== messages.length)
        throw new Error('Invalid decoded forwarded message batch');
      const projected = Array.from(decodedMessages, (decoded) => {
        if (!decoded)
          throw new Error('Native forwarded message has an unsupported conversation type');
        return decoded;
      });
      checkAlive();
      return projected;
    }
    if (method !== 'forwardMessages') throw new Error(`Unsupported forward operation: ${method}`);
    const source = peer(payload.source, 'source');
    const destination = peer(payload.destination, 'destination');
    const capturedIds = payload.messageIds;
    if (!Array.isArray(capturedIds) || !capturedIds.length)
      throw new Error('messageIds must be a nonempty array');
    const messageIds = Array.from(capturedIds, (value) => id(value, 'messageId'));
    const sourcePeer = await alive(() => resolvePeer(source));
    checkAlive();
    const destinationPeer = await alive(() => resolvePeer(destination));
    checkAlive();
    const result = await alive(() =>
      call('forwardMsg', [messageIds, sourcePeer, [destinationPeer], new Map()]),
    );
    checkAlive();
    check(result, 'forwardMsg');
    checkAlive();
    // Native acceptance does not establish destination receipt or expose new IDs.
  }
  return { invokeOperation, close };
}
