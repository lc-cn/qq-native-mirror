import { nativeResultError } from '../../errors.ts';
import { captureDeleteGroupFolder } from './group-file-input.ts';

export interface GroupFileContext {
  signal: AbortSignal;
  getRichMediaService(): {
    deleteGroupFolder(groupCode: string, folderId: string): unknown;
  };
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  try {
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
