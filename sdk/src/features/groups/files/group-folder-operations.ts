import { nativeResultError } from '../../../errors.ts';
import { groupFileField } from './group-file-result.ts';
import type { GroupFolder } from '../../../contracts/groups.ts';
import { captureCreateGroupFolder, captureDeleteGroupFolder } from './group-file-input.ts';

export interface GroupFolderDeletionContext {
  signal: AbortSignal;
  getRichMediaService(): {
    deleteGroupFolder(groupCode: string, folderId: string): unknown;
  };
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

function acknowledgeInvocation(signal: AbortSignal, value: unknown): void {
  const outer = groupFileField(signal, value, 'result');
  if (
    typeof outer !== 'number' ||
    !Number.isInteger(outer) ||
    outer < -0x8000_0000 ||
    outer > 0x7fff_ffff
  )
    throw nativeResultError('Invalid native group folder result', undefined);
  if (outer !== 0)
    throw nativeResultError('Native group folder invocation failed', { result: outer });
}

function acknowledgeResponse(signal: AbortSignal, value: unknown): void {
  const inner = groupFileField(signal, value, 'retCode');
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
  acknowledgeInvocation(context.signal, result);
  const details = groupFileField(context.signal, result, 'resultWithGroupItem');
  acknowledgeResponse(context.signal, groupFileField(context.signal, details, 'result'));
  context.signal.throwIfAborted();
  const item = groupFileField(context.signal, details, 'groupItem');
  const peerId = groupFileField(context.signal, item, 'peerId'),
    folder = groupFileField(context.signal, item, 'folderInfo');
  const folderId = groupFileField(context.signal, folder, 'folderId'),
    parentFolderId = groupFileField(context.signal, folder, 'parentFolderId'),
    folderName = groupFileField(context.signal, folder, 'folderName');
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
  context: GroupFolderDeletionContext,
  groupId: unknown,
  folderId: unknown,
): Promise<void> {
  const captured = captureDeleteGroupFolder(groupId, folderId);
  context.signal.throwIfAborted();
  const service = context.getRichMediaService();
  context.signal.throwIfAborted();
  const method = service.deleteGroupFolder;
  context.signal.throwIfAborted();
  if (typeof method !== 'function') throw new Error('Native service is missing deleteGroupFolder');
  const result = await context.awaitAlive(
    Reflect.apply(method, service, [captured.groupId, captured.folderId]),
  );
  context.signal.throwIfAborted();
  acknowledgeInvocation(context.signal, result);
  acknowledgeResponse(
    context.signal,
    groupFileField(context.signal, result, 'groupFileCommonResult'),
  );
  context.signal.throwIfAborted();
}
