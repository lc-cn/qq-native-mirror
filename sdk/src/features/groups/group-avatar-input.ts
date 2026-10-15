import { isAbsolute } from 'node:path';
import { sendGroupId } from '../../validation/identifiers.ts';

/** Capture a native uint64 group selector and a stable local pathname without IO
 * or coercion. File readability and native support belong to the worker owner.
 */
export function captureSetGroupAvatar(
  groupId: unknown,
  file: unknown,
): { groupId: string; file: string } {
  const group = sendGroupId(groupId);
  if (BigInt(group) > 0xffff_ffff_ffff_ffffn)
    throw new Error('groupId exceeds the native uint64 range');
  if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0'))
    throw new Error('Group avatar file must be an absolute local path without NUL');
  return { groupId: group, file };
}
