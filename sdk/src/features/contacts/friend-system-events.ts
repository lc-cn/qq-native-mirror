/** Receive-only friend-add gray tip, pinned to NapCatQQ 26d7533e api/msg.ts. */
import { createHash } from 'node:crypto';
import type { FriendAdded } from '../../contracts/contacts.ts';

function own(value: unknown, key: string, strict = false): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (strict && descriptor && !('value' in descriptor)) throw new Error('accessor');
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function item(value: unknown[], index: number, strict = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (strict && (!descriptor || !('value' in descriptor))) throw new Error('array item');
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function text(value: unknown, decimal = false): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value) || // eslint-disable-line no-control-regex -- Reject control characters in untrusted native event strings.
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value)) !== value ||
    (decimal && (!/^\d+$/.test(value) || !/[1-9]/.test(value)))
  )
    throw new Error('identifier');
  return value;
}
function knownBusinessId(value: unknown): boolean {
  // The declared form is a string. Only this exact numeric scalar is tolerated;
  // the pinned source uses toString(), but arbitrary objects must not coerce.
  return value === '19324' || value === 19324;
}
function gray(value: unknown, strict = false): unknown {
  const elements = own(value, 'elements', strict);
  if (!Array.isArray(elements)) return;
  return own(item(elements, 0, strict), 'grayTipElement', strict);
}

export function createFriendSystemEvents(emit: (event: string, payload: unknown) => void) {
  let closed = false;
  const seen = new Set<string>();
  return {
    hasAddedCandidate(value: unknown): boolean {
      if (closed) return false;
      try {
        if (!Array.isArray(value) || value.length > 4096) return false;
        for (let i = 0; i < value.length; i++) {
          const row = item(value, i);
          if (own(row, 'chatType') !== 1 || own(row, 'msgType') !== 5) continue;
          const tip = gray(row);
          if (
            own(tip, 'subElementType') === 17 &&
            knownBusinessId(own(own(tip, 'jsonGrayTipElement'), 'busiId')) &&
            own(row, 'peerUid') !== ''
          )
            return true;
        }
      } catch {
        return false;
      }
      return false;
    },
    onRecvMsg(value: unknown): void {
      if (closed) return;
      const batch: { key: string; event: FriendAdded }[] = [];
      try {
        if (!Array.isArray(value) || value.length > 4096) throw new Error('batch');
        for (let i = 0; i < value.length; i++) {
          const row = item(value, i, true);
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('message');
          if (own(row, 'chatType', true) !== 1 || own(row, 'msgType', true) !== 5) continue;
          const tip = gray(row, true);
          if (
            own(tip, 'subElementType', true) !== 17 ||
            !knownBusinessId(own(own(tip, 'jsonGrayTipElement', true), 'busiId', true))
          )
            continue;
          const uid = own(row, 'peerUid', true);
          if (uid === '') continue;
          const event: FriendAdded = {
            uid: text(uid),
            messageId: text(own(row, 'msgId', true), true),
          };
          const uin = own(row, 'peerUin', true);
          if (uin !== undefined && uin !== '' && !(typeof uin === 'string' && /^0+$/.test(uin)))
            event.userId = text(uin, true);
          batch.push({
            key: createHash('sha256')
              .update(JSON.stringify([event.uid, event.messageId]))
              .digest('hex'),
            event,
          });
        }
      } catch {
        if (!closed) emit('diagnostic', { stage: 'invalid-native-friend-added-message' });
        return;
      }
      for (const { key, event } of batch) {
        if (closed) return;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 2048) seen.delete(seen.values().next().value!);
        emit('friend-added', event);
      }
    },
    close(): void {
      closed = true;
      seen.clear();
    },
  };
}
