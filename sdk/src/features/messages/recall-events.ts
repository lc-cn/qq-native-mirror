import type { MessageRecall } from '../../types.ts';

// RawMessage/onMsgInfoListUpdate at NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076.
// recallTime is a decimal string; the declaration does not establish its unit
// or identify an operator. This is metadata synchronization, not online causality.
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value);
const positive = (value: unknown): value is string => decimal(value) && /[1-9]/.test(value);

export function createRecallEvents(emit: (event: string, payload: unknown) => void) {
  const seen = new Set<string>();
  let closed = false;
  const invalid = () => emit('diagnostic', { stage: 'invalid-native-recall-update' });
  return {
    onMessageUpdate(value: unknown): void {
      if (closed) return;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalid();
        return;
      }
      const raw = value as Record<string, unknown>;
      if (raw.recallTime === undefined || (decimal(raw.recallTime) && !positive(raw.recallTime)))
        return;
      if (
        !positive(raw.recallTime) ||
        !decimal(raw.msgId) ||
        !decimal(raw.msgSeq) ||
        typeof raw.peerUid !== 'string' ||
        !raw.peerUid.trim()
      ) {
        invalid();
        return;
      }
      let peer: MessageRecall['peer'];
      if (raw.chatType === 2 && positive(raw.peerUid))
        peer = { type: 'group', groupId: raw.peerUid };
      else if (raw.chatType === 1 && positive(raw.peerUin))
        peer = { type: 'private', userId: raw.peerUin };
      else {
        invalid();
        return;
      }
      const key = JSON.stringify([raw.chatType, raw.peerUid, raw.msgId]);
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 10_000) seen.delete(seen.values().next().value!);
      const update: MessageRecall = {
        peer,
        messageId: raw.msgId,
        sequence: raw.msgSeq,
        recallTime: raw.recallTime,
      };
      emit('message.recalled', update);
    },
    close(): void {
      closed = true;
      seen.clear();
    },
  };
}
