import { nativeResultError } from '../../../errors.ts';
import { captureDeleteGroupFile } from './group-file-input.ts';
import { groupFileField } from './group-file-result.ts';

export interface GroupFileDeletionContext {
  readonly signal: AbortSignal;
  getRichMediaService(): {
    deleteGroupFile(groupCode: string, params: number[], files: string[]): unknown;
  };
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

function captureAlive<T>(signal: AbortSignal, read: () => T): T {
  signal.throwIfAborted();
  try {
    return read();
  } finally {
    signal.throwIfAborted();
  }
}

function acknowledge(signal: AbortSignal, value: unknown, label: 'invocation' | 'response') {
  const status = groupFileField(signal, value, label === 'invocation' ? 'result' : 'retCode');
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < -0x8000_0000 ||
    status > 0x7fff_ffff
  )
    throw nativeResultError(`Invalid native group file deletion ${label}`, undefined);
  if (status !== 0)
    throw nativeResultError(`Native group file deletion ${label} failed`, { result: status });
}

/** Read only the bounded receipt shape needed for one requested ID. Array
 * iteration and indexed getters must not execute proprietary accessor code.
 */
function matchesFileList(signal: AbortSignal, value: unknown, fileId?: string): boolean {
  const expectedLength = fileId === undefined ? 0 : 1;
  signal.throwIfAborted();
  let matches = false;
  try {
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      signal.throwIfAborted();
      if (length && 'value' in length && length.value === expectedLength) {
        if (expectedLength === 0) matches = true;
        else {
          const item = Object.getOwnPropertyDescriptor(value, '0');
          matches = !!item && 'value' in item && item.value === fileId;
        }
      }
    }
  } catch {
    // Invalid receipts use a fixed public error, never native trap wording.
  }
  signal.throwIfAborted();
  return matches;
}

/** Submit one file exactly once, then require both zero statuses and an exact
 * per-file acknowledgement. This does not prove remote disappearance.
 * The pinned PC caller passes [102]; it is an opaque native parameter, not a
 * user option or an inferred enum. See docs/evidence/group-file-delete-contract.json.
 */
export async function deleteGroupFile(
  context: GroupFileDeletionContext,
  groupId: unknown,
  fileId: unknown,
): Promise<void> {
  const captured = captureDeleteGroupFile(groupId, fileId);
  context.signal.throwIfAborted();
  const service = captureAlive(context.signal, () => context.getRichMediaService());
  const method = captureAlive(context.signal, () => service.deleteGroupFile);
  if (typeof method !== 'function') throw new Error('Native service is missing deleteGroupFile');
  let pending: unknown;
  try {
    pending = Reflect.apply(method, service, [captured.groupId, [102], [captured.fileId]]);
  } catch (error) {
    context.signal.throwIfAborted();
    throw error;
  }
  // Await even when dispatch synchronously retires the owner, so a native
  // Promise is still observed and cannot produce an unhandled late rejection.
  const receipt = await context.awaitAlive(pending);
  context.signal.throwIfAborted();
  acknowledge(context.signal, receipt, 'invocation');
  const details = groupFileField(context.signal, receipt, 'transGroupFileResult');
  acknowledge(context.signal, groupFileField(context.signal, details, 'result'), 'response');
  const succeeded = groupFileField(context.signal, details, 'successFileIdList');
  if (!matchesFileList(context.signal, succeeded, captured.fileId))
    throw nativeResultError('Invalid native group file deletion acknowledgement', undefined);
  const failed = groupFileField(context.signal, details, 'failFileIdList');
  if (!matchesFileList(context.signal, failed))
    throw nativeResultError('Invalid native group file deletion acknowledgement', undefined);
  context.signal.throwIfAborted();
}
