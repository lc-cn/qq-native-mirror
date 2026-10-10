import { buildTextForwardRequest } from './long-message-request.ts';
import { buildMergedForwardCard } from './merged-forward-card.ts';
import { sendUserId, sendGroupId } from '../messages/send-input.ts';
import type { ForwardTextNode, MergedForwardOptions } from '../../contracts/forward.ts';
import type { Peer } from '../../contracts/messages.ts';

function record(
  value: unknown,
  allowed: string[],
  required = allowed,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((k) => typeof k !== 'string' || !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !('value' in d))
  )
    throw Error('Invalid merged-forward fields');
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
  record(peer, ['type', 'userId', 'groupId'], ['type']);
  let selected: Peer;
  if (peer.type === 'private') {
    record(peer, ['type', 'userId']);
    selected = { type: 'private', userId: sendUserId(peer.userId) };
  } else if (peer.type === 'group') {
    record(peer, ['type', 'groupId']);
    const groupId = sendGroupId(peer.groupId);
    if (Number(groupId) > 0xffffffff) throw Error('Merged-forward group requires uint32');
    selected = { type: 'group', groupId };
  } else throw Error('Merged-forward requires a private or group peer');
  if (!Array.isArray(input) || input.length < 1 || input.length > 100)
    throw Error('Merged-forward requires 1-100 text nodes');
  const nodes = Array.from(input, (node) => {
    record(node, ['userId', 'nickname', 'time', 'text']);
    if (
      typeof node.userId !== 'string' ||
      !/^[1-9]\d{0,9}$/.test(node.userId) ||
      Number(node.userId) > 0xffffffff
    )
      throw Error('Forward author requires a positive uint32 userId');
    return {
      userId: node.userId,
      nickname: node.nickname as string,
      time: node.time as number,
      text: node.text as string,
    };
  });
  record(options, ['title', 'summary', 'prompt'], []);
  const captured = { ...options } as MergedForwardOptions;
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
