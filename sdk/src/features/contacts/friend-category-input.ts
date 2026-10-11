import { sendUserId } from '../../validation/identifiers.ts';
import type { FriendCategoryOrderEntry } from '../../contracts/contacts.ts';

/** Shared public category input capture, before IPC or native acquisition.
 * Query-result projection and mutation completion belong to their respective owners.
 */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
export function friendCategoryName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Friend category name must be a nonblank string');
  return value;
}

/** Category selectors inhabit the uint32 namespace; zero is not assumed mutable. */
export function captureFriendCategoryId(categoryId: unknown): number {
  if (
    typeof categoryId !== 'number' ||
    !Number.isInteger(categoryId) ||
    categoryId < 0 ||
    categoryId > 0xffff_ffff
  )
    throw new Error('Friend category ID must be a uint32 number');
  return categoryId;
}

export function captureRenameFriendCategory(categoryId: unknown, name: unknown) {
  return { categoryId: captureFriendCategoryId(categoryId), name: friendCategoryName(name) };
}

/** Capture every explicit row before acquisition. Names are preserved, never inferred or refreshed. */
export function captureFriendCategoryOrder(value: unknown): readonly FriendCategoryOrderEntry[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Friend category order must be a nonempty array');
  const ids = new Set<number>();
  const rows: FriendCategoryOrderEntry[] = [];
  const length = value.length;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor))
      throw new Error('Friend category order requires dense data rows');
    const row: unknown = descriptor.value;
    const categoryId = captureFriendCategoryId(field(row, 'categoryId'));
    const name = field(row, 'name');
    if (typeof name !== 'string') throw new Error('Friend category order requires string names');
    if (ids.has(categoryId)) throw new Error('Friend category order contains duplicate IDs');
    ids.add(categoryId);
    rows.push(Object.freeze({ categoryId, name }));
  }
  return Object.freeze(rows);
}

/** Capture public identity and measured category selector before UID lookup. */
export function captureFriendCategoryAssignment(userId: unknown, categoryId: unknown) {
  return { userId: sendUserId(userId), categoryId: captureFriendCategoryId(categoryId) };
}
