import { captureForwardPeer, forwardMessageId, captureForwardSubmission } from './forward-input.ts';
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
function check(result: unknown, method: string): asserts result is Record<string, unknown> {
  const status =
    result && typeof result === 'object' ? (result as Record<string, unknown>).result : undefined;
  if (!result || typeof result !== 'object' || status !== 0) {
    const code = typeof status === 'number' ? status : 'invalid-result';
    throw nativeResultError(`Native ${method} failed (code=${code})`, result);
  }
}

/** Capture only the read envelope; proprietary metadata and element bodies
 * remain opaque until their projectors inspect them. Descriptor traps on a
 * Proxy can still execute code, but selected accessors and iterators never run.
 */
function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor))
    throw new Error('Native getMultiMsg requires own data properties');
  return descriptor?.value;
}
function dense(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Native getMultiMsg returned an invalid message list');
  const length = field(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    throw new Error('Native getMultiMsg returned an invalid message list');
  const captured: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor))
      throw new Error('Native getMultiMsg returned invalid dense message data');
    captured.push(descriptor.value);
  }
  return captured;
}
function record(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native getMultiMsg returned an invalid message');
  return value;
}
function capturedMessages(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw nativeResultError('Native getMultiMsg failed (code=invalid-result)', undefined);
  const status = field(result, 'result');
  if (status !== 0)
    throw nativeResultError('Native getMultiMsg failed (invalid or rejected result)', {
      result: status,
    });
  // Forward contents may originate from different conversations. Capture the
  // whole batch before decoding, without imposing the root peer or a count cap.
  return dense(field(result, 'msgList')).map((value) => {
    const raw = record(value);
    const msgId = field(raw, 'msgId'),
      chatType = field(raw, 'chatType'),
      elements = field(raw, 'elements');
    if (typeof msgId !== 'string' || !/^\d+$/.test(msgId))
      throw new Error('Native getMultiMsg returned an invalid message ID');
    if (chatType !== 1 && chatType !== 2)
      throw new Error('Native forwarded message has an unsupported conversation type');
    const capturedElements = dense(elements).map(record);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    for (const [key, value] of Object.entries({ msgId, chatType, elements: capturedElements }))
      descriptors[key] = { value, enumerable: true };
    // This projection view copies descriptors, not metadata values. Only the
    // three envelope fields above have been validated; raw retains vendor identity.
    const message: Record<string, unknown> = Object.create(Object.getPrototypeOf(raw), descriptors);
    return { message, raw };
  });
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
    raw: object,
  ): Message | undefined | Promise<Message | undefined>;
  decodeMessages?(
    messages: Record<string, unknown>[],
    rawMessages: object[],
  ): Promise<(Message | undefined)[]>;
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
      const source = captureForwardPeer(payload.peer, 'peer');
      const root = forwardMessageId(payload.rootMessageId, 'rootMessageId');
      const parent = forwardMessageId(payload.parentMessageId, 'parentMessageId');
      const resolved = await alive(() => resolvePeer(source));
      const result = await alive(() => call('getMultiMsg', [resolved, root, parent]));
      checkAlive();
      const messages = capturedMessages(result);
      checkAlive();
      const decodedMessages = await alive(() =>
        decodeMessages
          ? decodeMessages(
              messages.map((value) => value.message),
              messages.map((value) => value.raw),
            )
          : Promise.all(
              messages.map((message) => {
                checkAlive();
                const pending = Promise.resolve(decodeMessage(message.message, message.raw));
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
    const { source, destination, messageIds } = captureForwardSubmission(payload);
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
