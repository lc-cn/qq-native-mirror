import { sendGroupId } from '../../validation/identifiers.ts';

function groupCode(value: unknown): string {
  const group = sendGroupId(value);
  if (BigInt(group) > 0xffff_ffff_ffff_ffffn)
    throw new Error('groupId exceeds the native uint64 range');
  return group;
}

/** Capture explicit folder identity without inferring a native folder format. */
export function captureDeleteGroupFolder(groupId: unknown, folderId: unknown) {
  const group = groupCode(groupId);
  if (typeof folderId !== 'string' || folderId.length === 0)
    throw new Error('folderId must be a nonempty string');
  return { groupId: group, folderId };
}

/** The native group selector is uint64; retain the caller's decimal spelling. */
export function captureGroupFileCount(groupId: unknown) {
  return { groupId: groupCode(groupId) };
}

export function captureCreateGroupFolder(groupId: unknown, name: unknown) {
  const group = groupCode(groupId);
  if (typeof name !== 'string' || !name.trim())
    throw new Error('Folder name must be a nonblank string');
  return { groupId: group, name };
}
