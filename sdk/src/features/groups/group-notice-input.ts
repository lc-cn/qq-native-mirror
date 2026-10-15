import { isAbsolute } from 'node:path';
import type { GroupNoticeOptions } from '../../contracts/groups.ts';
import { sendGroupId } from '../../validation/identifiers.ts';

/** Capture caller options without invoking accessors. File existence and native
 * ticket acquisition belong to the worker, after this synchronous preflight.
 */
export function captureGroupNoticePublication(
  groupId: unknown,
  text: unknown,
  options: unknown = undefined,
): { groupId: string; text: string; options?: GroupNoticeOptions } {
  const group = sendGroupId(groupId);
  if (typeof text !== 'string') throw new Error('notice text must be a string');
  // Native publication URI-encodes text. Reject malformed Unicode before any
  // ticket lookup or image upload can take place.
  encodeURI(text);
  if (options === undefined) return { groupId: group, text };
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('notice options must be an object');
  const captured: GroupNoticeOptions = {};
  for (const key of ['imagePath', 'pinned', 'confirmRequired'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor && !('value' in descriptor))
      throw new Error(`notice ${key} must be a data property`);
    const value: unknown = descriptor?.value;
    if (value === undefined) continue;
    if (key === 'imagePath') {
      if (typeof value !== 'string' || !isAbsolute(value))
        throw new Error('imagePath must be an absolute local file path');
      captured.imagePath = value;
    } else {
      if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
      captured[key] = value;
    }
  }
  return { groupId: group, text, options: captured };
}

export function captureGroupNoticeDeletion(groupId: unknown, noticeId: unknown) {
  const group = sendGroupId(groupId);
  if (typeof noticeId !== 'string' || !noticeId)
    throw new Error('noticeId must be a non-empty string');
  return { groupId: group, noticeId };
}

export function captureGroupNoticeList(groupId: unknown) {
  return { groupId: sendGroupId(groupId) };
}
