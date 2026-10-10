import { sendGroupId } from '../messages/send-input.ts';
import { normalizeMessageQuery } from '../messages/query-input.ts';

/** Capture only explicit intent; message sequence/random are resolved in the worker. */
export function captureGroupEssenceRequest(groupId: unknown, messageId: unknown, enabled: unknown) {
  const group = sendGroupId(groupId);
  if (BigInt(group) > 0xffff_ffff_ffff_ffffn)
    throw new Error('groupId exceeds the native uint64 range');
  const query = normalizeMessageQuery({ type: 'group', groupId: group }, messageId);
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  return { groupId: group, messageId: query.messageId, enabled };
}
