import { nativeResultError } from '../../errors.ts';
import type { GroupFolder } from '../../contracts/groups.ts';
import {
  captureCreateGroupFolder,
  captureDeleteGroupFolder,
  captureGroupFileCount,
} from './group-file-input.ts';

export interface GroupFileContext {
  signal: AbortSignal;
  getRichMediaService(): {
    deleteGroupFolder(groupCode: string, folderId: string): unknown;
  };
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

function field(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function acknowledge(value: unknown): void {
  const outer = field(value, 'result');
  if (
    typeof outer !== 'number' ||
    !Number.isInteger(outer) ||
    outer < -0x8000_0000 ||
    outer > 0x7fff_ffff
  )
    throw nativeResultError('Invalid native group folder result', undefined);
  if (outer !== 0)
    throw nativeResultError('Native group folder invocation failed', { result: outer });
  const inner = field(field(value, 'groupFileCommonResult'), 'retCode');
  if (
    typeof inner !== 'number' ||
    !Number.isInteger(inner) ||
    inner < -0x8000_0000 ||
    inner > 0x7fff_ffff
  )
    throw nativeResultError('Invalid native group folder response', undefined);
  if (inner !== 0)
    throw nativeResultError('Native group folder response failed', { result: inner });
}

export interface GroupFolderCreationContext {
  signal: AbortSignal;
  getRichMediaService(): { createGroupFolder(groupCode: string, name: string): unknown };
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

/** Native creation returns one groupItem object, despite the pinned upstream
 * declaration saying array. See docs/evidence/group-folder-create-contract.json.
 * Require both statuses and a folder snapshot matching the requested uint64
 * group; optional folderInfo presence identifies the selected carrier without
 * guessing the native type enum. Never retry or issue a readback automatically.
 */
export async function createGroupFolder(
  context: GroupFolderCreationContext,
  groupId: unknown,
  name: unknown,
): Promise<GroupFolder> {
  const captured = captureCreateGroupFolder(groupId, name);
  context.signal.throwIfAborted();
  const service = context.getRichMediaService();
  context.signal.throwIfAborted();
  const method = service.createGroupFolder;
  context.signal.throwIfAborted();
  if (typeof method !== 'function') throw new Error('Native service is missing createGroupFolder');
  const result = await context.awaitAlive(
    Reflect.apply(method, service, [captured.groupId, captured.name]),
  );
  context.signal.throwIfAborted();
  const details = field(result, 'resultWithGroupItem');
  // Reuse the verified two-layer status policy without adopting or spreading
  // native objects. The selected creation result uses a different property name.
  acknowledge({ result: field(result, 'result'), groupFileCommonResult: field(details, 'result') });
  context.signal.throwIfAborted();
  const item = field(details, 'groupItem');
  const peerId = field(item, 'peerId'),
    folder = field(item, 'folderInfo');
  const folderId = field(folder, 'folderId'),
    parentFolderId = field(folder, 'parentFolderId'),
    folderName = field(folder, 'folderName');
  context.signal.throwIfAborted();
  if (
    typeof peerId !== 'string' ||
    !/^\d+$/.test(peerId) ||
    BigInt(peerId) !== BigInt(captured.groupId) ||
    typeof folderId !== 'string' ||
    !folderId ||
    typeof parentFolderId !== 'string' ||
    typeof folderName !== 'string'
  )
    throw nativeResultError('Invalid native group folder creation snapshot', undefined);
  context.signal.throwIfAborted();
  return { groupId: peerId, folderId, parentFolderId, name: folderName };
}

/** A single native acknowledgement, not proof of remote folder disappearance.
 * PC caller: NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076
 * packages/napcat-core/apis/group.ts#L371-L372 (blob 4949dabe83de37e42570d0c5e63036c0eb1e662a).
 * Service declaration blob 432f5bb4e89f0acd7aa5ccfcd6edff06355e0dda.
 * Six fixed binary profiles and exact converter/completion evidence:
 * docs/evidence/group-folder-contract.json. Both status fields are int32;
 * normal completion is a Promise acknowledgement, not server readback.
 * Native wording is intentionally excluded from errors. No retry or readback.
 */
export async function deleteGroupFolder(
  context: GroupFileContext,
  groupId: unknown,
  folderId: unknown,
): Promise<void> {
  const captured = captureDeleteGroupFolder(groupId, folderId);
  context.signal.throwIfAborted();
  const service = context.getRichMediaService();
  context.signal.throwIfAborted();
  const result = await context.awaitAlive(
    service.deleteGroupFolder(captured.groupId, captured.folderId),
  );
  context.signal.throwIfAborted();
  acknowledge(result);
  context.signal.throwIfAborted();
}

export interface GroupFileCountContext {
  signal: AbortSignal;
  getRichMediaService(): { batchGetGroupFileCount(groups: string[]): unknown };
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

function singleton(value: unknown): unknown {
  try {
    if (!Array.isArray(value)) return;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || length.value !== 1) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, '0');
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Single-group count, correlated by the uint64 group namespace, not row position
 * alone. Fixed source: services/NodeIKernelRichMediaService.ts#L250-L253 and
 * apis/group.ts#L492-L493 at 26d7533e0f5800fdff865ab2f2ad7692917e1076.
 * Binary profile gating belongs to the composition root. No callback, retry,
 * filesystem-capacity estimate or hardcoded file limit is inferred.
 */
export async function getGroupFileCount(
  context: GroupFileCountContext,
  groupId: unknown,
): Promise<number> {
  const captured = captureGroupFileCount(groupId);
  context.signal.throwIfAborted();
  const service = context.getRichMediaService();
  context.signal.throwIfAborted();
  const returned = service.batchGetGroupFileCount([captured.groupId]);
  let then: unknown;
  try {
    let object = returned && typeof returned === 'object' ? returned : null;
    const seen = new Set<object>();
    for (let depth = 0; object && depth < 64; depth++) {
      if (seen.has(object)) throw new Error('Invalid promise boundary');
      seen.add(object);
      const descriptor = Object.getOwnPropertyDescriptor(object, 'then');
      if (descriptor) {
        if (!('value' in descriptor)) throw new Error('Invalid promise boundary');
        then = descriptor.value;
        break;
      }
      object = Object.getPrototypeOf(object);
    }
  } catch {
    throw nativeResultError('Invalid native group file count result', undefined);
  }
  // Never re-read native `then`, or adopt its fulfillment value. The trusted
  // bridge resolves a plain box and observes late native rejection after close.
  const completion = new Promise<{ value: unknown }>((resolve, reject) => {
    if (typeof then === 'function')
      Reflect.apply(then, returned, [(value: unknown) => resolve({ value }), reject]);
    else resolve({ value: returned });
  });
  const result = (await context.awaitAlive(completion)).value;
  context.signal.throwIfAborted();
  const status = field(result, 'result');
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < -0x8000_0000 ||
    status > 0x7fff_ffff
  )
    throw nativeResultError('Invalid native group file count result', undefined);
  if (status !== 0) throw nativeResultError('Native group file count failed', { result: status });
  const group = singleton(field(result, 'groupCodes'));
  const count = singleton(field(result, 'groupFileCounts'));
  if (
    typeof group !== 'string' ||
    !/^\d+$/.test(group) ||
    BigInt(group) <= 0n ||
    BigInt(group) > 0xffff_ffff_ffff_ffffn ||
    BigInt(group) !== BigInt(captured.groupId) ||
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > 0xffff_ffff
  )
    throw nativeResultError('Invalid native group file count response', undefined);
  context.signal.throwIfAborted();
  return count;
}
