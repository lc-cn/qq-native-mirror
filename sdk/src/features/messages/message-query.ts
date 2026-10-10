import { messageIds } from './query-input.ts';
export {
  normalizeMessageQuery,
  normalizeMessageBatchQuery,
  normalizeHistoryQuery,
} from './query-input.ts';
import { nativeResultError } from '../../errors.ts';

export interface QueriedNativeMessage extends Record<string, unknown> {
  msgId: string;
  chatType: 1 | 2;
  peerUid: string;
  elements: Record<string, unknown>[];
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

/** Reject a malformed queried batch before projecting or dropping any record. */
function queriedMessage(
  value: unknown,
  peer: NativePeer,
  method: string,
  expectedId?: string,
): QueriedNativeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Native ${method} returned an invalid message`);
  const message = value as QueriedNativeMessage;
  if (typeof message.msgId !== 'string' || !/^\d+$/.test(message.msgId))
    throw new Error(`Native ${method} returned an invalid message ID`);
  if (
    (expectedId !== undefined && message.msgId !== expectedId) ||
    message.chatType !== peer.chatType ||
    message.peerUid !== peer.peerUid
  )
    throw new Error(`Native ${method} returned a mismatched message or conversation`);
  if (
    !Array.isArray(message.elements) ||
    Array.from(message.elements).some(
      (element: unknown) => !element || typeof element !== 'object' || Array.isArray(element),
    )
  )
    throw new Error(`Native ${method} returned invalid message elements`);
  return message;
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
  if (
    !peer ||
    (peer.chatType !== 1 && peer.chatType !== 2) ||
    typeof peer.peerUid !== 'string' ||
    !peer.peerUid
  )
    throw new Error('Invalid native message query peer');
  if (typeof msgService?.getMsgsByMsgId !== 'function')
    throw new Error('Native service is missing getMsgsByMsgId');
  const value = await msgService.getMsgsByMsgId(peer, [messageId]);
  const result = value as Record<string, unknown> | null | undefined;
  if (!result || typeof result !== 'object' || result.result !== 0)
    throw nativeResultError('Native getMsgsByMsgId failed (invalid or rejected result)', result);
  if (!Array.isArray(result.msgList))
    throw new Error('Native getMsgsByMsgId returned an invalid message list');
  if (result.msgList.length > 1)
    throw new Error(
      'Native getMsgsByMsgId returned an invalid message list: multiple records for one ID',
    );
  const message = result.msgList[0];
  if (result.msgList.length === 0) return undefined;
  return queriedMessage(message, peer, 'getMsgsByMsgId', messageId);
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
  if (
    !peer ||
    (peer.chatType !== 1 && peer.chatType !== 2) ||
    typeof peer.peerUid !== 'string' ||
    !peer.peerUid
  )
    throw new Error('Invalid native message query peer');
  const expectedPeer = { chatType: peer.chatType, peerUid: peer.peerUid };
  if (typeof msgService?.getMsgsByMsgId !== 'function')
    throw new Error('Native service is missing getMsgsByMsgId');
  const value = await msgService.getMsgsByMsgId({ ...expectedPeer }, [...captured]);
  const result = value as Record<string, unknown> | null | undefined;
  if (!result || typeof result !== 'object' || result.result !== 0)
    throw nativeResultError('Native getMsgsByMsgId failed (invalid or rejected result)', result);
  if (!Array.isArray(result.msgList))
    throw new Error('Native getMsgsByMsgId returned an invalid message list');
  const requested = new Set(captured),
    found = new Map<string, QueriedNativeMessage>();
  for (const raw of result.msgList) {
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
  if (
    !peer ||
    typeof peer !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(peer))
  )
    throw new Error('Invalid native history query peer');
  const chatType = Object.getOwnPropertyDescriptor(peer, 'chatType'),
    peerUid = Object.getOwnPropertyDescriptor(peer, 'peerUid');
  if (
    !chatType ||
    !('value' in chatType) ||
    (chatType.value !== 1 && chatType.value !== 2) ||
    !peerUid ||
    !('value' in peerUid) ||
    typeof peerUid.value !== 'string' ||
    !peerUid.value
  )
    throw new Error('Invalid native history query peer');
  const expectedPeer: NativePeer = { chatType: chatType.value, peerUid: peerUid.value };
  if (typeof before !== 'string' || !/^\d+$/.test(before))
    throw new Error('History before must be a numeric string');
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error('History count must be an integer between 1 and 100');
  if (typeof reverse !== 'boolean') throw new Error('History reverse must be a boolean');
  if (typeof msgService?.getMsgsIncludeSelf !== 'function')
    throw new Error('Native service is missing getMsgsIncludeSelf');
  const value = await msgService.getMsgsIncludeSelf({ ...expectedPeer }, before, count, reverse);
  const result = value as Record<string, unknown> | null | undefined;
  if (result?.result !== 0)
    throw nativeResultError(
      'Native getMsgsIncludeSelf failed (invalid or rejected result)',
      result,
    );
  if (!Array.isArray(result.msgList))
    throw new Error('Native getMsgsIncludeSelf returned an invalid message list');
  return Array.from(result.msgList, (message) =>
    queriedMessage(message, expectedPeer, 'getMsgsIncludeSelf'),
  );
}
