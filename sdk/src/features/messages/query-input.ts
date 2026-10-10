import type { Peer } from '../../types.ts';

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

export function messageIds(value: unknown): string[] {
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
