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

function essenceGroupId(groupId: unknown): string {
  const group = sendGroupId(groupId);
  if (BigInt(group) > 0xffff_ffff_ffff_ffffn) throw new Error('groupId exceeds the uint64 range');
  return group;
}

function essenceOptions(options: unknown) {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))
    throw new Error('group essence options must be an object');
  return (name: string, fallback: number, minimum: number, maximum: number) => {
    const item = options === undefined ? undefined : Object.getOwnPropertyDescriptor(options, name);
    if (item && !('value' in item))
      throw new Error(`group essence ${name} must be a data property`);
    const value: unknown = item?.value === undefined ? fallback : item.value;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(`group essence ${name} must be an integer between ${minimum} and ${maximum}`);
    return value;
  };
}

/** Capture the documented HTTP pagination parameters without inferring a next cursor. */
export function captureGroupEssencePage(groupId: unknown, options: unknown = undefined) {
  const group = essenceGroupId(groupId);
  const option = essenceOptions(options);
  return {
    groupId: group,
    pageStart: option('pageStart', 0, 0, 0xffffffff),
    pageLimit: option('pageLimit', 50, 1, 50),
  };
}

/** Full reads use the source's fixed 50-row page size and an explicit SDK budget. */
export function captureGroupEssenceList(groupId: unknown, options: unknown = undefined) {
  const group = essenceGroupId(groupId);
  const option = essenceOptions(options);
  return { groupId: group, maxPages: option('maxPages', 20, 1, 1000) };
}
