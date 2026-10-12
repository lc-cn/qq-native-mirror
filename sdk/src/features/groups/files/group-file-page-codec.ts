import type { GroupFile, GroupFileEntry, GroupFileFolder } from '../../../contracts/groups.ts';

export interface CapturedGroupFileBody {
  items: GroupFileEntry[];
  isEnd: boolean;
  nextIndex: number;
  allFileCount: number;
}

export interface CapturedGroupFileCallback {
  reqId: number;
  outcome: { ok: true; body: CapturedGroupFileBody } | { ok: false; error: Error };
}

const invalid = () =>
  Object.assign(new Error('Invalid native group file callback'), { code: 'invalid-result' });

function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
  const captured: unknown = descriptor.value;
  return captured;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  return value;
}

function uint64(value: unknown): string {
  const captured = text(value);
  if (!/^\d+$/.test(captured) || captured.length > 20 || BigInt(captured) > 0xffff_ffff_ffff_ffffn)
    throw invalid();
  return captured;
}

function number(value: unknown, signed = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < (signed ? -0x8000_0000 : 0) ||
    value > (signed ? 0x7fff_ffff : 0xffff_ffff)
  )
    throw invalid();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function folder(value: unknown): GroupFileFolder | null {
  if (value === null) return null;
  return {
    folderId: text(own(value, 'folderId')),
    parentFolderId: text(own(value, 'parentFolderId')),
    folderName: text(own(value, 'folderName')),
    createTime: number(own(value, 'createTime')),
    modifyTime: number(own(value, 'modifyTime')),
    createUin: uint64(own(value, 'createUin')),
    creatorName: text(own(value, 'creatorName')),
    totalFileCount: number(own(value, 'totalFileCount')),
    modifyUin: uint64(own(value, 'modifyUin')),
    modifyName: text(own(value, 'modifyName')),
    usedSpace: uint64(own(value, 'usedSpace')),
  };
}

function file(value: unknown): GroupFile | null {
  if (value === null) return null;
  return {
    fileModelId: uint64(own(value, 'fileModelId')),
    fileId: text(own(value, 'fileId')),
    fileName: text(own(value, 'fileName')),
    fileSize: uint64(own(value, 'fileSize')),
    busId: number(own(value, 'busId')),
    uploadedSize: uint64(own(value, 'uploadedSize')),
    uploadTime: number(own(value, 'uploadTime')),
    deadTime: number(own(value, 'deadTime')),
    modifyTime: number(own(value, 'modifyTime')),
    downloadTimes: number(own(value, 'downloadTimes')),
    sha: text(own(value, 'sha')),
    sha3: text(own(value, 'sha3')),
    md5: text(own(value, 'md5')),
    uploaderLocalPath: nullableText(own(value, 'uploaderLocalPath')),
    uploaderName: text(own(value, 'uploaderName')),
    uploaderUin: uint64(own(value, 'uploaderUin')),
    parentFolderId: nullableText(own(value, 'parentFolderId')),
    localPath: text(own(value, 'localPath')),
    transStatus: number(own(value, 'transStatus')),
    transType: number(own(value, 'transType')),
    elementId: uint64(own(value, 'elementId')),
    isFolder: bool(own(value, 'isFolder')),
  };
}

/** Snapshot the measured callback at receipt time, before request correlation.
 * Field types follow the fixed Mac ARM64 serializer recorded in
 * docs/evidence/group-file-page-contract.json. The 10,000-row bound is SDK policy.
 * A body failure belongs only to its captured token; no native wording/raw object
 * survives projection. Group/folder request association belongs to the page owner.
 */
export function captureGroupFileCallback(raw: unknown): CapturedGroupFileCallback | undefined {
  let reqId: number;
  try {
    reqId = number(own(raw, 'reqId'));
  } catch {
    return undefined;
  }
  try {
    const retCode = number(own(raw, 'retCode'), true);
    text(own(raw, 'retMsg'));
    text(own(raw, 'clientWording'));
    if (retCode !== 0)
      return {
        reqId,
        outcome: {
          ok: false,
          error: Object.assign(new Error('Native group file query rejected'), { code: retCode }),
        },
      };
    const isEnd = bool(own(raw, 'isEnd'));
    const allFileCount = number(own(raw, 'allFileCount'));
    const nextIndex = number(own(raw, 'nextIndex'));
    const item = own(raw, 'item');
    if (!Array.isArray(item)) throw invalid();
    const length = number(own(item, 'length'));
    if (length > 10_000) throw invalid();
    const items: GroupFileEntry[] = [];
    for (let index = 0; index < length; index++) {
      const row = own(item, String(index));
      items.push({
        groupId: uint64(own(row, 'peerId')),
        type: number(own(row, 'type'), true),
        folderInfo: folder(own(row, 'folderInfo')),
        fileInfo: file(own(row, 'fileInfo')),
      });
    }
    return { reqId, outcome: { ok: true, body: { items, isEnd, nextIndex, allFileCount } } };
  } catch {
    return { reqId, outcome: { ok: false, error: invalid() } };
  }
}
