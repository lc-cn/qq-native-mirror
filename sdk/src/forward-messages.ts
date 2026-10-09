import { nativeResultError } from './errors.ts';
/** Pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/msg.ts#L45-L48
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/msg.ts#L282-L284
 * Native MsgService getMultiMsg/forwardMsg both declare GeneralCallResult.
 * Forwarding here forwards existing message IDs; it does not synthesize identities.
 */
import type { Message, Peer } from './types.ts';
type Native = Record<string, any>;
type NativePeer = { chatType: 1 | 2; peerUid: string; guildId?: string };
export type ForwardOperation = 'getForwardMessages' | 'forwardMessages';
function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${name} must be a numeric string`);
  return value;
}
function peer(value: unknown, name: string): Peer {
  if (!value || typeof value !== 'object') throw new Error(`${name} must be a peer`);
  const p = value as Native;
  if (p.type === 'private') return { type: 'private', userId: id(p.userId, `${name}.userId`) };
  if (p.type === 'group') return { type: 'group', groupId: id(p.groupId, `${name}.groupId`) };
  throw new Error(`${name}.type must be private or group`);
}
function check(result: unknown, method: string): asserts result is Native {
  if (!result || typeof result !== 'object' || !('result' in result) || result.result !== 0) {
    const code = result && typeof result === 'object' && 'result' in result && typeof result.result === 'number' ? result.result : 'invalid-result';
    throw nativeResultError(`Native ${method} failed (code=${code})`,result);
  }
}
export function createForwardMessages(
  session: Native,
  resolvePeer: (peer: Peer) => Promise<NativePeer>,
  decodeMessage: (message: Native) => Message | undefined,
) {
  const call = (method: string, ...args: unknown[]) => {
    if (typeof session.getMsgService !== 'function') throw new Error('Native service is missing getMsgService');
    const service = session.getMsgService();
    if (!service || typeof service[method] !== 'function') throw new Error(`Native message service is missing ${method}`);
    return service[method](...args);
  };
  async function invokeOperation(method: ForwardOperation, payload: Record<string, unknown>): Promise<Message[] | void> {
    if (method === 'getForwardMessages') {
      const source = peer(payload.peer, 'peer');
      const root = id(payload.rootMessageId, 'rootMessageId');
      const parent = id(payload.parentMessageId, 'parentMessageId');
      const result = await call('getMultiMsg', await resolvePeer(source), root, parent);
      check(result, 'getMultiMsg');
      if (!Array.isArray(result.msgList)) throw new Error('Native getMultiMsg returned an invalid message list');
      return result.msgList.map((raw: unknown) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Native getMultiMsg returned an invalid message');
        const decoded = decodeMessage(raw);
        if (!decoded) throw new Error('Native forwarded message has an unsupported conversation type');
        return decoded;
      });
    }
    if (method !== 'forwardMessages') throw new Error(`Unsupported forward operation: ${method}`);
    const source = peer(payload.source, 'source');
    const destination = peer(payload.destination, 'destination');
    if (!Array.isArray(payload.messageIds) || !payload.messageIds.length) throw new Error('messageIds must be a nonempty array');
    const messageIds = payload.messageIds.map(value => id(value, 'messageId'));
    const sourcePeer = await resolvePeer(source);
    const destinationPeer = await resolvePeer(destination);
    const result = await call('forwardMsg', messageIds, sourcePeer, [destinationPeer], new Map());
    check(result, 'forwardMsg');
    // Native acceptance does not establish destination receipt or expose new IDs.
  }
  return { invokeOperation };
}
