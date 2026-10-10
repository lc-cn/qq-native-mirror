import type { Message } from '../../contracts/messages.ts';
import type { NativePeer } from '../../native/message-contracts.ts';
import { decodeElements } from './inbound-elements.ts';
import { decodeNativeMessages, projectNativeMessage } from './inbound-messages.ts';

export interface MessageResolutionContext {
  readonly signal: AbortSignal;
  resolveUid(userId: string): Promise<string>;
  getIdentityService(): { getUin(uids: string[]): unknown };
  diagnostic(stage: string): void;
}

/** Share peer conversion and message projection between live delivery, queries
 * and forward operations. Native payloads remain untrusted: the existing
 * projectors validate them before producing public DTOs. Identity lookup owns
 * its existing deadline and cancellation policy; this module adds no cache,
 * listener, retry or account lifetime.
 */
export function createMessageResolution(context: MessageResolutionContext) {
  async function resolveMessages(
    messages: unknown[],
    rawMessages: unknown[] = messages,
    live = false,
    signal = context.signal,
  ): Promise<(Message | undefined)[]> {
    return decodeNativeMessages(
      // The decoder validates and captures each untrusted record before its
      // first await. This assertion exposes no proprietary callable members.
      messages as Record<string, unknown>[],
      rawMessages,
      async (uids) => {
        const result = await context.getIdentityService().getUin(uids);
        // Preserve the native member access without claiming that its value is
        // a typed Map. native-identities validates and copies it before use.
        return result == null ? undefined : (result as Record<string, unknown>).uinInfo;
      },
      signal,
      context.diagnostic,
      live,
    );
  }
  return {
    async resolvePeer(value: unknown): Promise<NativePeer> {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Unsupported peer type');
      const peer = value as Record<string, unknown>;
      if (peer.chatType === 1 || peer.chatType === 2) {
        if (typeof peer.peerUid !== 'string' || !peer.peerUid) throw new Error('Invalid peer UID');
        return { chatType: peer.chatType, peerUid: peer.peerUid };
      }
      if (peer.type === 'group') return { chatType: 2, peerUid: String(peer.groupId ?? peer.id) };
      if (peer.type === 'private')
        return { chatType: 1, peerUid: await context.resolveUid(String(peer.userId ?? peer.id)) };
      throw new Error('Unsupported peer type');
    },
    resolveMessages,
    async resolveMessage(message: unknown): Promise<Message | undefined> {
      return (await resolveMessages([message]))[0];
    },
    projectImmediate(message: object, raw: unknown = message): Message {
      const record = message as Record<string, unknown>;
      return projectNativeMessage(
        record,
        decodeElements(record.elements as Record<string, unknown>[]),
        new Map(),
        raw,
      );
    },
  };
}
