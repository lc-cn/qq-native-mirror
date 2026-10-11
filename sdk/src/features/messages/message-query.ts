import { messageIds } from './query-input.ts';
export {
  normalizeMessageQuery,
  normalizeMessageBatchQuery,
  normalizeHistoryQuery,
} from './query-input.ts';
import { nativeResultError } from '../../errors.ts';

/** Validated query envelope, separate from opaque projection data and its
 * original vendor object. This is not a declaration of the complete native ABI. */
export interface QueriedNativeMessage {
  readonly msgId: string;
  readonly chatType: 1 | 2;
  readonly peerUid: string;
  readonly elements: object[];
  readonly message: object;
  readonly raw: object;
}
type NativePeer = { chatType: 1 | 2; peerUid: string };

/** Only the two query ABI methods cross this port; results remain unknown until
 * the existing response validators have checked status and every message.
 * Optional members retain the explicit missing-method failure contract.
 */
export interface MessageIdQueryPort {
  getMsgsByMsgId?: (peer: NativePeer, ids: string[]) => unknown;
}
export interface MessageHistoryQueryPort {
  getMsgsIncludeSelf?: (
    peer: NativePeer,
    before: string,
    count: number,
    reverse: boolean,
  ) => unknown;
}
export type MessageQueryPort = MessageIdQueryPort & MessageHistoryQueryPort;

function record(value: unknown, label: string): object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Native ${label} returned an invalid message result`);
  return value;
}
function field(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor))
    throw new Error(`Native ${label} requires own data properties`);
  return descriptor?.value;
}
function dense(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Native ${label} returned an invalid message list`);
  const length = field(value, 'length', label);
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    throw new Error(`Native ${label} returned an invalid message list`);
  const values: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor))
      throw new Error(`Native ${label} returned invalid dense message data`);
    values.push(descriptor.value);
  }
  return values;
}
function capturePeer(value: NativePeer, history = false): NativePeer {
  const label = history ? 'history query peer' : 'message query peer';
  const peer = record(value, label);
  if (history && ![Object.prototype, null].includes(Object.getPrototypeOf(peer)))
    throw new Error('Invalid native history query peer');
  const chatType = field(peer, 'chatType', label),
    peerUid = field(peer, 'peerUid', label);
  if ((chatType !== 1 && chatType !== 2) || typeof peerUid !== 'string' || !peerUid)
    throw new Error(`Invalid native ${label}`);
  return { chatType, peerUid };
}
function response(value: unknown, method: string): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw nativeResultError(`Native ${method} failed (invalid or rejected result)`, undefined);
  const code = field(value, 'result', method);
  if (code !== 0)
    throw nativeResultError(`Native ${method} failed (invalid or rejected result)`, {
      result: code,
    });
  return dense(field(value, 'msgList', method), method);
}

/** Validate the entire batch before projection. Selected fields are captured
 * once; caller iterators and accessors cannot supply correlation data. Other
 * native metadata and element bodies remain opaque for their own projectors.
 * Proxy descriptor traps are not assumed side-effect free. */
function queriedMessage(
  value: unknown,
  peer: NativePeer,
  method: string,
  expectedId?: string,
): QueriedNativeMessage {
  const raw = record(value, method);
  const msgId = field(raw, 'msgId', method),
    chatType = field(raw, 'chatType', method),
    peerUid = field(raw, 'peerUid', method);
  if (typeof msgId !== 'string' || !/^\d+$/.test(msgId))
    throw new Error(`Native ${method} returned an invalid message ID`);
  if (
    (expectedId !== undefined && msgId !== expectedId) ||
    chatType !== peer.chatType ||
    peerUid !== peer.peerUid
  )
    throw new Error(`Native ${method} returned a mismatched message or conversation`);
  const elements = dense(field(raw, 'elements', method), `${method} elements`).map((element) =>
    record(element, `${method} element`),
  );
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  for (const [key, captured] of Object.entries({ msgId, chatType, peerUid, elements }))
    descriptors[key] = { value: captured, enumerable: true };
  const message: object = Object.create(Object.getPrototypeOf(raw), descriptors);
  return { msgId, chatType: peer.chatType, peerUid: peer.peerUid, elements, message, raw };
}

/** NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * NodeIKernelMsgService.ts:195 and apis/msg.ts:55-59.
 * getMsgsByMsgId(peer, ids) returns GeneralCallResult & {msgList: RawMessage[]}.
 * Empty successful lists mean absent; errors and mismatched records do not.
 */
export async function queryNativeMessage(
  msgService: MessageIdQueryPort,
  peer: NativePeer,
  messageId: string,
): Promise<QueriedNativeMessage | undefined> {
  if (typeof messageId !== 'string' || !/^\d+$/.test(messageId))
    throw new Error('messageId must be a numeric string');
  const expectedPeer = capturePeer(peer);
  const method = msgService?.getMsgsByMsgId;
  if (typeof method !== 'function') throw new Error('Native service is missing getMsgsByMsgId');
  const messages = response(
    await Reflect.apply(method, msgService, [{ ...expectedPeer }, [messageId]]),
    'getMsgsByMsgId',
  );
  if (messages.length > 1)
    throw new Error(
      'Native getMsgsByMsgId returned an invalid message list: multiple records for one ID',
    );
  return messages.length === 0
    ? undefined
    : queriedMessage(messages[0], expectedPeer, 'getMsgsByMsgId', messageId);
}

/** Same pinned getMsgsByMsgId contract, queried once. Ordering, the 100-ID
 * ceiling and duplicate refusal are SDK policy, not native ordering claims.
 * A missing item means absent from this successful response only.
 */
export async function queryNativeMessages(
  msgService: MessageIdQueryPort,
  peer: NativePeer,
  ids: unknown,
): Promise<(QueriedNativeMessage | undefined)[]> {
  const captured = messageIds(ids);
  const expectedPeer = capturePeer(peer);
  const method = msgService?.getMsgsByMsgId;
  if (typeof method !== 'function') throw new Error('Native service is missing getMsgsByMsgId');
  const messages = response(
    await Reflect.apply(method, msgService, [{ ...expectedPeer }, [...captured]]),
    'getMsgsByMsgId',
  );
  const requested = new Set(captured),
    found = new Map<string, QueriedNativeMessage>();
  for (const raw of messages) {
    const message = queriedMessage(raw, expectedPeer, 'getMsgsByMsgId');
    if (!requested.has(message.msgId) || found.has(message.msgId))
      throw new Error('Native getMsgsByMsgId returned an unexpected or duplicate message ID');
    found.set(message.msgId, message);
  }
  return captured.map((id) => found.get(id));
}

/** Pinned getMsgsIncludeSelf returns GeneralCallResult & {msgList: RawMessage[]}.
 * Keep native ordering; an error or malformed record is not an empty history.
 */
export async function queryNativeHistory(
  msgService: MessageHistoryQueryPort,
  peer: NativePeer,
  before: string,
  count: number,
  reverse: boolean,
): Promise<QueriedNativeMessage[]> {
  const expectedPeer = capturePeer(peer, true);
  if (typeof before !== 'string' || !/^\d+$/.test(before))
    throw new Error('History before must be a numeric string');
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error('History count must be an integer between 1 and 100');
  if (typeof reverse !== 'boolean') throw new Error('History reverse must be a boolean');
  const method = msgService?.getMsgsIncludeSelf;
  if (typeof method !== 'function') throw new Error('Native service is missing getMsgsIncludeSelf');
  const messages = response(
    await Reflect.apply(method, msgService, [{ ...expectedPeer }, before, count, reverse]),
    'getMsgsIncludeSelf',
  );
  return messages.map((message) => queriedMessage(message, expectedPeer, 'getMsgsIncludeSelf'));
}
