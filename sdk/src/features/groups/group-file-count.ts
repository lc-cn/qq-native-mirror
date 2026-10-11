import { nativeResultError } from '../../errors.ts';
import { captureGroupFileCount } from './group-file-input.ts';
import { groupFileField } from './group-file-result.ts';

export interface GroupFileCountContext {
  signal: AbortSignal;
  getRichMediaService(): { batchGetGroupFileCount(groups: string[]): unknown };
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

function singleton(signal: AbortSignal, value: unknown): unknown {
  signal.throwIfAborted();
  let selected: unknown;
  try {
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      signal.throwIfAborted();
      if (length && 'value' in length && length.value === 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, '0');
        selected = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      }
    }
  } catch {
    // Malformed native arrays stay opaque. Retirement is checked outside this catch.
  }
  signal.throwIfAborted();
  return selected;
}

/** Single-group count, correlated by the uint64 group namespace, not row position
 * alone. Fixed source: services/NodeIKernelRichMediaService.ts#L250-L253 and
 * apis/group.ts#L492-L493 at 26d7533e0f5800fdff865ab2f2ad7692917e1076.
 * Binary profile selection belongs to composition; the group-files owner gates
 * dispatch before invoking this adapter. No callback, retry,
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
  const method = service.batchGetGroupFileCount;
  context.signal.throwIfAborted();
  if (typeof method !== 'function')
    throw new Error('Native service is missing batchGetGroupFileCount');
  const returned: unknown = Reflect.apply(method, service, [[captured.groupId]]);
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
  const status = groupFileField(context.signal, result, 'result');
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < -0x8000_0000 ||
    status > 0x7fff_ffff
  )
    throw nativeResultError('Invalid native group file count result', undefined);
  if (status !== 0) throw nativeResultError('Native group file count failed', { result: status });
  const group = singleton(context.signal, groupFileField(context.signal, result, 'groupCodes'));
  const count = singleton(
    context.signal,
    groupFileField(context.signal, result, 'groupFileCounts'),
  );
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
