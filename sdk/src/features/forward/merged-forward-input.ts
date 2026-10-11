import { buildTextForwardRequest } from './long-message-request.ts';
import { buildMergedForwardCard } from './merged-forward-card.ts';
import { sendUserId, sendGroupId } from '../../validation/identifiers.ts';
import type { ForwardTextNode, MergedForwardOptions } from '../../contracts/forward.ts';
import type { Peer } from '../../contracts/messages.ts';

/** Capture only own data fields from the strict public input shape. Validation
 * consumes this snapshot, never a second ordinary read from the caller object.
 * Proxy descriptor/prototype traps remain outside this purity guarantee. */
function record(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error('Invalid merged-forward fields');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key))
      throw Error('Invalid merged-forward fields');
    const descriptor = descriptors[key];
    if (!('value' in descriptor)) throw Error('Invalid merged-forward fields');
    captured[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(captured, key)))
    throw Error('Invalid merged-forward fields');
  return captured;
}

function captureNode(value: unknown): ForwardTextNode {
  const { userId, nickname, time, text } = record(value, ['userId', 'nickname', 'time', 'text']);
  if (typeof userId !== 'string' || !/^[1-9]\d{0,9}$/.test(userId) || Number(userId) > 0xffffffff)
    throw Error('Forward author requires a positive uint32 userId');
  if (typeof nickname !== 'string' || typeof time !== 'number' || typeof text !== 'string')
    throw Error('Invalid merged-forward node values');
  return { userId, nickname, time, text };
}

export interface CapturedMergedForward {
  peer: Peer;
  nodes: ForwardTextNode[];
  options: MergedForwardOptions;
}
/** Capture the entire operation before UID lookup or any mutation. */
export function captureMergedForward(
  peer: unknown,
  input: unknown,
  options: unknown = {},
): CapturedMergedForward {
  const destination = record(peer, ['type', 'userId', 'groupId'], ['type']);
  let selected: Peer;
  if (destination.type === 'private') {
    const { userId } = record(destination, ['type', 'userId']);
    selected = { type: 'private', userId: sendUserId(userId) };
  } else if (destination.type === 'group') {
    const { groupId: value } = record(destination, ['type', 'groupId']);
    const groupId = sendGroupId(value);
    if (Number(groupId) > 0xffffffff) throw Error('Merged-forward group requires uint32');
    selected = { type: 'group', groupId };
  } else throw Error('Merged-forward requires a private or group peer');
  if (!Array.isArray(input)) throw Error('Merged-forward requires 1-100 text nodes');
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > 100)
    throw Error('Merged-forward requires 1-100 text nodes');
  const nodes: ForwardTextNode[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor))
      throw Error('Merged-forward requires dense own data nodes');
    nodes.push(captureNode(descriptor.value));
  }
  const values = record(options, ['title', 'summary', 'prompt'], []);
  const captured: MergedForwardOptions = {};
  for (const key of ['title', 'summary', 'prompt'] as const) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (typeof value !== 'string') throw Error('Invalid merged-forward card option');
    captured[key] = value;
  }
  // Offline preflight uses the same writer/formatter and no native/random calls.
  buildTextForwardRequest({
    selfUid: 'u_preflight',
    target:
      selected.type === 'group'
        ? { type: 'group', groupUin: Number(selected.groupId) }
        : { type: 'private' },
    nodes: nodes.map((n) => ({
      senderUin: Number(n.userId),
      displayName: n.nickname,
      timeSeconds: n.time,
      text: n.text,
      sequence: 0,
    })),
  });
  buildMergedForwardCard({
    resourceId: 'preflight',
    cardId: '00000000-0000-4000-8000-000000000000',
    nodes: nodes.map((n) => ({ displayName: n.nickname, text: n.text })),
    options: captured,
  });
  return { peer: selected, nodes, options: captured };
}
