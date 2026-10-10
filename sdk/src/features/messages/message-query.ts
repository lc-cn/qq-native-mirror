import { nativeResultError } from '../../errors.ts';
import type { Peer } from '../../types.ts';

import type { NativeObject as Native } from '../../native/native-object.ts';
type NativePeer = { chatType: 1 | 2; peerUid: string };

export function normalizeMessageQuery(
  peer: unknown,
  messageId: unknown,
): { peer: Peer; messageId: string } {
  if (typeof messageId !== 'string' || !/^\d+$/.test(messageId))
    throw new Error('messageId must be a numeric string');
  if (!peer || typeof peer !== 'object' || Array.isArray(peer))
    throw new Error('Message query requires a peer');
  const p = peer as Record<string, unknown>;
  if (p.type === 'private' && typeof p.userId === 'string' && /^\d+$/.test(p.userId))
    return { peer: { type: 'private', userId: p.userId }, messageId };
  if (p.type === 'group' && typeof p.groupId === 'string' && /^\d+$/.test(p.groupId))
    return { peer: { type: 'group', groupId: p.groupId }, messageId };
  throw new Error('Message query peer requires a private userId or group groupId numeric string');
}

/** Capture history aliases before UID resolution or any native access. */
export function normalizeHistoryQuery(
  peer: unknown,
  options: unknown = {},
): { peer: Peer; before: string; count: number; reverse: boolean } {
  if (
    !options ||
    typeof options !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw new Error('History options must be a plain object');
  const values: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    if (
      typeof key !== 'string' ||
      !['before', 'messageId', 'limit', 'count', 'reverse'].includes(key)
    )
      throw new Error('Unsupported history option');
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !('value' in descriptor))
      throw new Error('History options require own data properties');
    if (descriptor.value !== undefined) values[key] = descriptor.value;
  }
  if (
    values.before !== undefined &&
    values.messageId !== undefined &&
    values.before !== values.messageId
  )
    throw new Error('Conflicting history cursor aliases');
  if (values.limit !== undefined && values.count !== undefined && values.limit !== values.count)
    throw new Error('Conflicting history count aliases');
  const before =
    values.before !== undefined
      ? values.before
      : values.messageId !== undefined
        ? values.messageId
        : '0';
  const count =
    values.limit !== undefined ? values.limit : values.count !== undefined ? values.count : 20;
  const reverse = values.reverse !== undefined ? values.reverse : false;
  if (typeof before !== 'string' || !/^\d+$/.test(before))
    throw new Error('History before must be a numeric string');
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100)
    throw new Error('History count must be an integer between 1 and 100');
  if (typeof reverse !== 'boolean') throw new Error('History reverse must be a boolean');
  if (
    !peer ||
    typeof peer !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(peer))
  )
    throw new Error('History query requires a peer');
  const capturedPeer: Record<string, unknown> = {};
  for (const key of ['type', 'userId', 'groupId']) {
    const descriptor = Object.getOwnPropertyDescriptor(peer, key);
    if (descriptor) {
      if (!('value' in descriptor)) throw new Error('History peer requires own data properties');
      capturedPeer[key] = descriptor.value;
    }
  }
  return { peer: normalizeMessageQuery(capturedPeer, before).peer, before, count, reverse };
}

function messageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new Error('messageIds requires between 1 and 100 IDs');
  const ids = Array.from(value, (id) => {
    if (typeof id !== 'string' || !/^\d+$/.test(id))
      throw new Error('messageIds must contain numeric strings');
    return id;
  });
  if (new Set(ids).size !== ids.length)
    throw new Error('messageIds must not contain duplicate IDs');
  return ids;
}

export function normalizeMessageBatchQuery(
  peer: unknown,
  ids: unknown,
): { peer: Peer; messageIds: string[] } {
  const captured = messageIds(ids);
  return { peer: normalizeMessageQuery(peer, captured[0]).peer, messageIds: captured };
}

/** Reject a malformed queried batch before projecting or dropping any record. */
function queriedMessage(
  value: unknown,
  peer: NativePeer,
  method: string,
  expectedId?: string,
): Native {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Native ${method} returned an invalid message`);
  const message = value as Native;
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
  msgService: Native,
  peer: NativePeer,
  messageId: string,
): Promise<Native | undefined> {
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
  const result = await msgService.getMsgsByMsgId(peer, [messageId]);
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
  msgService: Native,
  peer: NativePeer,
  ids: unknown,
): Promise<(Native | undefined)[]> {
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
  const result = await msgService.getMsgsByMsgId({ ...expectedPeer }, [...captured]);
  if (!result || typeof result !== 'object' || result.result !== 0)
    throw nativeResultError('Native getMsgsByMsgId failed (invalid or rejected result)', result);
  if (!Array.isArray(result.msgList))
    throw new Error('Native getMsgsByMsgId returned an invalid message list');
  const requested = new Set(captured),
    found = new Map<string, Native>();
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
  msgService: Native,
  peer: NativePeer,
  before: string,
  count: number,
  reverse: boolean,
): Promise<Native[]> {
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
  const result = await msgService.getMsgsIncludeSelf({ ...expectedPeer }, before, count, reverse);
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
