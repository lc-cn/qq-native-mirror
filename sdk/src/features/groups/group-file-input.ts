import { sendGroupId } from '../../validation/identifiers.ts';

/** Native request fields; optional folder identity remains omitted at the root. */
export interface GroupFileListParams {
  folderId?: string;
  sortType: number;
  fileCount: number;
  startIndex: number;
  sortOrder: number;
  showOnlinedocFolder: number;
}

export interface CapturedGroupFilePage {
  groupId: string;
  params: GroupFileListParams;
}

export interface CapturedGroupFileList extends CapturedGroupFilePage {
  maxPages: number;
}

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

function pageOptions(options: unknown, list: boolean): Record<string, unknown> {
  if (options === undefined) return {};
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('group file options must be an object');
  const allowed = ['folderId', 'sortType', 'fileCount', 'sortOrder', 'showOnlinedocFolder'];
  allowed.push(list ? 'maxPages' : 'startIndex');
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowed.includes(key))
      throw new Error('Unknown group file option');
    const field = Object.getOwnPropertyDescriptor(options, key);
    if (!field || !('value' in field))
      throw new Error('group file options must use data properties');
    captured[key] = field.value;
  }
  return captured;
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string) {
  const number = value === undefined ? fallback : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max)
    throw new Error(`group file ${name} must be an integer between ${min} and ${max}`);
  return number;
}

function pageParams(options: Record<string, unknown>, startIndex: number): GroupFileListParams {
  const folderId = options.folderId;
  if (folderId !== undefined && (typeof folderId !== 'string' || folderId.length === 0))
    throw new Error('folderId must be a nonempty string');
  return {
    ...(folderId === undefined ? {} : { folderId }),
    sortType: integer(options.sortType, 1, -0x80000000, 0x7fffffff, 'sortType'),
    fileCount: integer(options.fileCount, 50, 1, 1000, 'fileCount'),
    startIndex,
    sortOrder: integer(options.sortOrder, 2, 0, 0xffffffff, 'sortOrder'),
    showOnlinedocFolder: integer(
      options.showOnlinedocFolder,
      0,
      0,
      0xffffffff,
      'showOnlinedocFolder',
    ),
  };
}

/** Capture all caller fields before capability checks, native acquisition or queuing. */
export function captureGroupFilePage(groupId: unknown, options?: unknown): CapturedGroupFilePage {
  const group = groupCode(groupId);
  const captured = pageOptions(options, false);
  return {
    groupId: group,
    params: pageParams(captured, integer(captured.startIndex, 0, 0, 0xffffffff, 'startIndex')),
  };
}

export function captureGroupFileList(groupId: unknown, options?: unknown): CapturedGroupFileList {
  const group = groupCode(groupId);
  const captured = pageOptions(options, true);
  return {
    groupId: group,
    params: pageParams(captured, 0),
    maxPages: integer(captured.maxPages, 20, 1, 1000, 'maxPages'),
  };
}
