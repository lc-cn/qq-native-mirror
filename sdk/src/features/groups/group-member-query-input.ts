import type { GroupMemberQueryOptions } from '../../contracts/groups.ts';
import { sendGroupId } from '../../validation/identifiers.ts';

/** Group membership uses positive decimal account IDs, never UID addressing. */
export function groupMemberUserId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !/[1-9]/.test(value))
    throw new Error('Group member userId must be a positive decimal string');
  return value;
}

/** Compare validated decimal identities without rounding or changing DTO spelling. */
export function groupMemberIdentity(userId: string): string {
  return userId.replace(/^0+/, '');
}

/** Capture only explicit own data options. No accessors, coercion or native work. */
export function captureGroupMemberList(
  groupId: unknown,
  options: unknown = undefined,
): { groupId: string } & GroupMemberQueryOptions {
  const captured: { groupId: string } & GroupMemberQueryOptions = {
    groupId: sendGroupId(groupId),
  };
  if (options === undefined) return captured;
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw new Error('Group member query options must be a plain object');
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'refresh') throw new Error('Unknown group member query option');
    const field = Object.getOwnPropertyDescriptor(options, key);
    if (!field || !('value' in field))
      throw new Error('Group member refresh must be a data property');
    const value: unknown = field.value;
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Error('refresh must be a boolean');
    captured.refresh = value;
  }
  return captured;
}

export function captureGroupMemberQuery(
  groupId: unknown,
  userId: unknown,
  options: unknown = undefined,
): { groupId: string; userId: string } & GroupMemberQueryOptions {
  const account = groupMemberUserId(userId);
  return { ...captureGroupMemberList(groupId, options), userId: account };
}
