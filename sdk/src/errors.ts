/** Failure of an operation in the isolated kernel worker. */
export class KernelRequestError extends Error {
  readonly operation: string;
  readonly code?: string | number;
  readonly originalName?: string;
  readonly mergedForward?: MergedForwardFailure;
  constructor(
    operation: string,
    message: string,
    code?: string | number,
    originalName?: string,
    mergedForward?: MergedForwardFailure,
  ) {
    super(message);
    this.name = 'KernelRequestError';
    this.operation = operation;
    this.code = code;
    this.originalName = originalName;
    this.mergedForward = mergedForward;
  }
}
export interface MergedForwardProgress {
  uploadCompletion: 'not-dispatched' | 'unknown' | 'resource-received';
  cardCompletion: 'not-dispatched' | 'unknown';
  resourceId?: string;
}
export interface MergedForwardFailure extends MergedForwardProgress {
  phase: 'upload' | 'card' | 'operation';
}
export class MergedForwardError extends Error {
  readonly phase: MergedForwardFailure['phase'];
  readonly progress: Readonly<MergedForwardProgress>;
  readonly code?: string | number;
  constructor(
    phase: MergedForwardFailure['phase'],
    message: string,
    progress: MergedForwardProgress,
    code?: string | number,
  ) {
    super(message);
    this.name = 'MergedForwardError';
    this.phase = phase;
    this.progress = Object.freeze({ ...progress });
    this.code = code;
  }
}
export interface SerializedKernelError {
  message: string;
  name?: string;
  code?: string | number;
  mergedForward?: MergedForwardFailure;
}
/** Inspect data properties only: proprietary errors may contain accessors or proxies.
 * A bounded prototype walk supports inherited Error fields without invoking code.
 */
function dataField(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  try {
    const seen = new Set<object>();
    let object: object | null = value;
    for (let depth = 0; object && depth < 64; depth++) {
      if (seen.has(object)) return;
      seen.add(object);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      object = Object.getPrototypeOf(object);
    }
  } catch {
    // Revoked proxies and trapping descriptor/prototype handlers are opaque.
  }
}
function instanceOf(
  value: unknown,
  constructor: abstract new (...args: never[]) => Error,
): boolean {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}
function mergedFailure(value: unknown): MergedForwardFailure | undefined {
  const phase = dataField(value, 'phase');
  const uploadCompletion = dataField(value, 'uploadCompletion');
  const cardCompletion = dataField(value, 'cardCompletion');
  const resourceId = dataField(value, 'resourceId');
  if (
    (phase !== 'upload' && phase !== 'card' && phase !== 'operation') ||
    (uploadCompletion !== 'not-dispatched' &&
      uploadCompletion !== 'unknown' &&
      uploadCompletion !== 'resource-received') ||
    (cardCompletion !== 'not-dispatched' && cardCompletion !== 'unknown')
  )
    return;
  if (
    resourceId !== undefined &&
    (typeof resourceId !== 'string' || !resourceId || Buffer.byteLength(resourceId) > 4096)
  )
    return;
  if ((uploadCompletion === 'resource-received') !== (typeof resourceId === 'string')) return;
  return {
    phase,
    uploadCompletion,
    cardCompletion,
    ...(typeof resourceId === 'string' ? { resourceId } : {}),
  };
}
/** Retain the reported result field, without exposing the rest of a native response. */
export function nativeResultError(
  message: string,
  result: unknown,
  field = 'result',
): Error & { code: string | number } {
  const value =
    result && typeof result === 'object' ? (result as Record<string, unknown>)[field] : undefined;
  const code =
    typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
      ? value
      : 'invalid-result';
  return Object.assign(new Error(message), { code });
}
/** Preserve explicit error fields only; never serialize arbitrary native objects, causes or stacks. */
export function serializeKernelError(error: unknown): SerializedKernelError {
  const isError = instanceOf(error, Error);
  const message = isError ? dataField(error, 'message') : undefined;
  const opaque = (typeof error === 'object' && error !== null) || typeof error === 'function';
  const result: SerializedKernelError = {
    message: isError
      ? typeof message === 'string'
        ? message
        : 'Kernel request failed'
      : opaque
        ? 'Kernel request failed'
        : String(error),
  };
  if (isError) {
    const name = dataField(error, 'name');
    if (typeof name === 'string') result.name = name;
    const code = dataField(error, 'code');
    if (typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code)))
      result.code = code;
    if (instanceOf(error, MergedForwardError)) {
      const progress = dataField(error, 'progress');
      result.mergedForward = mergedFailure({
        phase: dataField(error, 'phase'),
        uploadCompletion: dataField(progress, 'uploadCompletion'),
        cardCompletion: dataField(progress, 'cardCompletion'),
        resourceId: dataField(progress, 'resourceId'),
      });
    }
  }
  return result;
}
/** Internal normalization for callback failure paths. Ordinary errors with a
 * safely readable data message retain identity; opaque values never coerce.
 */
export function normalizeKernelError(error: unknown): Error {
  if (instanceOf(error, Error) && typeof dataField(error, 'message') === 'string')
    return error as Error;
  const serialized = serializeKernelError(error);
  const normalized = new Error(serialized.message);
  if (serialized.name !== undefined) normalized.name = serialized.name;
  if (serialized.code !== undefined) Object.assign(normalized, { code: serialized.code });
  return normalized;
}
export function deserializeKernelError(operation: string, error: unknown): KernelRequestError {
  if (typeof error === 'string') return new KernelRequestError(operation, error);
  const value = error as Partial<SerializedKernelError> | null;
  return new KernelRequestError(
    operation,
    typeof value?.message === 'string' ? value.message : 'Kernel request failed',
    typeof value?.code === 'string' ||
      (typeof value?.code === 'number' && Number.isFinite(value.code))
      ? value.code
      : undefined,
    typeof value?.name === 'string' ? value.name : undefined,
    mergedFailure(value?.mergedForward),
  );
}
