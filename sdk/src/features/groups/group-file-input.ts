import { sendGroupId } from '../../validation/identifiers.ts';

/** Capture explicit folder identity without inferring a native folder format. */
export function captureDeleteGroupFolder(groupId: unknown, folderId: unknown) {
  const group = sendGroupId(groupId);
  if (BigInt(group) > 0xffff_ffff_ffff_ffffn)
    throw new Error('groupId exceeds the native uint64 range');
  if (typeof folderId !== 'string' || folderId.length === 0)
    throw new Error('folderId must be a nonempty string');
  return { groupId: group, folderId };
}
