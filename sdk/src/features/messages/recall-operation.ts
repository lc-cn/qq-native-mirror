import type { NativePeer } from '../../native/message-contracts.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';

/** Only peer resolution, shared callback correlation and the recall method cross
 * this seam. Session acquisition and its dispatch guard remain with composition.
 */
export interface RecallContext {
  resolvePeer(value: unknown): Promise<NativePeer>;
  getMessageService(): { recallMsg(peer: NativePeer, messageIds: string[]): unknown };
  eventCall: NativeEventChannel['call'];
}

/** A callback does not replace the native method's own completion code. */
function nativeCallSucceeded(value: unknown): boolean {
  return (value as { result?: unknown } | null | undefined)?.result === 0;
}

/** Correlate the selected conversation and message, then require native success.
 * Share the Session's event channel: no extra listener, retry or remote readback.
 * Defer legacy message-ID reads and coercion until peer resolution completes.
 */
export async function recallMessage(
  context: RecallContext,
  peerInput: unknown,
  readMessageId: () => unknown,
): Promise<void> {
  const peer = await context.resolvePeer(peerInput);
  const id = String(readMessageId());
  await context.eventCall(
    'Msg/onMsgInfoListUpdate',
    (updates: { chatType: number; peerUid: string; msgId: string; recallTime?: unknown }[]) =>
      updates.find(
        (message) =>
          message.chatType === peer.chatType &&
          message.peerUid === peer.peerUid &&
          message.msgId === id &&
          message.recallTime &&
          message.recallTime !== '0',
      ),
    () => context.getMessageService().recallMsg(peer, [id]),
    10_000,
    nativeCallSucceeded,
  );
}
