import { sendGroupId } from '../../validation/identifiers.ts';
/** Preserve the caller's spelling while validating the native uint64 namespace. */
export function captureGroupSearch(groupId: unknown): string {
  const group = sendGroupId(groupId);
  if (BigInt(group) > 0xffff_ffff_ffff_ffffn)
    throw new Error('groupId exceeds the native uint64 range');
  return group;
}
