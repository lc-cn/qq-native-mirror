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
function mergedFailure(value: unknown): MergedForwardFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    typeof v.phase !== 'string' ||
    !['upload', 'card', 'operation'].includes(v.phase) ||
    typeof v.uploadCompletion !== 'string' ||
    !['not-dispatched', 'unknown', 'resource-received'].includes(v.uploadCompletion) ||
    typeof v.cardCompletion !== 'string' ||
    !['not-dispatched', 'unknown'].includes(v.cardCompletion)
  )
    return;
  if (
    v.resourceId !== undefined &&
    (typeof v.resourceId !== 'string' || !v.resourceId || Buffer.byteLength(v.resourceId) > 4096)
  )
    return;
  if ((v.uploadCompletion === 'resource-received') !== (typeof v.resourceId === 'string')) return;
  return {
    phase: v.phase as MergedForwardFailure['phase'],
    uploadCompletion: v.uploadCompletion as MergedForwardProgress['uploadCompletion'],
    cardCompletion: v.cardCompletion as MergedForwardProgress['cardCompletion'],
    ...(v.resourceId === undefined ? {} : { resourceId: v.resourceId as string }),
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
  const result: SerializedKernelError = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof Error) {
    result.name = error.name;
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code)))
      result.code = code;
    if (error instanceof MergedForwardError)
      result.mergedForward = mergedFailure({ phase: error.phase, ...error.progress });
  }
  return result;
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
