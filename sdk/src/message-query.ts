import { nativeResultError } from './errors.ts';
import type { Peer } from './types.ts';

type Native = Record<string, any>;
type NativePeer = { chatType: 1 | 2; peerUid: string };

export function normalizeMessageQuery(peer: unknown, messageId: unknown): { peer: Peer; messageId: string } {
  if (typeof messageId !== 'string' || !/^\d+$/.test(messageId)) throw new Error('messageId must be a numeric string');
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)) throw new Error('Message query requires a peer');
  const p = peer as Record<string, unknown>;
  if (p.type === 'private' && typeof p.userId === 'string' && /^\d+$/.test(p.userId)) return { peer: { type: 'private', userId: p.userId }, messageId };
  if (p.type === 'group' && typeof p.groupId === 'string' && /^\d+$/.test(p.groupId)) return { peer: { type: 'group', groupId: p.groupId }, messageId };
  throw new Error('Message query peer requires a private userId or group groupId numeric string');
}

/** NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * NodeIKernelMsgService.ts:195 and apis/msg.ts:55-59.
 * getMsgsByMsgId(peer, ids) returns GeneralCallResult & {msgList: RawMessage[]}.
 * Empty successful lists mean absent; errors and mismatched records do not.
 */
export async function queryNativeMessage(msgService: Native, peer: NativePeer, messageId: string): Promise<Native | undefined> {
  if (typeof messageId !== 'string' || !/^\d+$/.test(messageId)) throw new Error('messageId must be a numeric string');
  if (!peer || (peer.chatType !== 1 && peer.chatType !== 2) || typeof peer.peerUid !== 'string' || !peer.peerUid) throw new Error('Invalid native message query peer');
  if (typeof msgService?.getMsgsByMsgId !== 'function') throw new Error('Native service is missing getMsgsByMsgId');
  const result = await msgService.getMsgsByMsgId(peer, [messageId]);
  if (!result || typeof result !== 'object' || result.result !== 0) throw nativeResultError('Native getMsgsByMsgId failed (invalid or rejected result)', result);
  if (!Array.isArray(result.msgList)) throw new Error('Native getMsgsByMsgId returned an invalid message list');
  if (result.msgList.length > 1) throw new Error('Native getMsgsByMsgId returned an invalid message list: multiple records for one ID');
  const message = result.msgList[0];
  if (result.msgList.length === 0) return undefined;
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Native getMsgsByMsgId returned an invalid message');
  if (message.msgId !== messageId || message.chatType !== peer.chatType || message.peerUid !== peer.peerUid) throw new Error('Native getMsgsByMsgId returned a mismatched message or conversation');
  if (!Array.isArray(message.elements) || message.elements.some((element: unknown) => !element || typeof element !== 'object' || Array.isArray(element))) throw new Error('Native getMsgsByMsgId returned invalid message elements');
  return message;
}
