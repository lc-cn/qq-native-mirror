import type { Peer } from '../../contracts/messages.ts';

export function forwardMessageId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error(`${name} must be a numeric string`);
  return value;
}

/** Preserve the existing forwarding peer contract, including one getter read.
 * Capture the selected identity before asynchronous resolution or worker IPC. */
export function captureForwardPeer(value: unknown, name: string): Peer {
  if (!value || typeof value !== 'object') throw new Error(`${name} must be a peer`);
  const type: unknown = Reflect.get(value, 'type');
  if (type === 'private')
    return { type, userId: forwardMessageId(Reflect.get(value, 'userId'), `${name}.userId`) };
  if (type === 'group')
    return { type, groupId: forwardMessageId(Reflect.get(value, 'groupId'), `${name}.groupId`) };
  throw new Error(`${name}.type must be private or group`);
}

/** Existing-message forwarding has a nonempty-list policy, unlike the 100-ID
 * query policy. Preserve order, numeric spelling and repeated IDs. */
export function captureForwardSubmission(value: object): {
  source: Peer;
  destination: Peer;
  messageIds: string[];
} {
  const source = captureForwardPeer(Reflect.get(value, 'source'), 'source');
  const destination = captureForwardPeer(Reflect.get(value, 'destination'), 'destination');
  const input: unknown = Reflect.get(value, 'messageIds');
  if (!Array.isArray(input)) throw new Error('messageIds must be a nonempty array');
  const length: unknown = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1)
    throw new Error('messageIds must be a nonempty array');
  const messageIds: string[] = [];
  // Validate fixed own slots, never caller iteration or inherited array values.
  // Proxy descriptor traps may still execute code supplied by the caller.
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor))
      throw new Error('messageIds requires dense own data properties');
    messageIds.push(forwardMessageId(descriptor.value, 'messageId'));
  }
  return { source, destination, messageIds };
}
