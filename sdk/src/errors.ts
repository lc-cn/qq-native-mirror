/** Failure of an operation in the isolated kernel worker. */
export class KernelRequestError extends Error {
  readonly operation: string;
  readonly code?: string | number;
  readonly originalName?: string;
  constructor(operation: string, message: string, code?: string | number, originalName?: string) {
    super(message); this.name='KernelRequestError';this.operation=operation;this.code=code;this.originalName=originalName;
  }
}
export interface SerializedKernelError { message: string; name?: string; code?: string | number }
/** Retain the reported result field, without exposing the rest of a native response. */
export function nativeResultError(message:string,result:unknown,field='result'):Error & {code:string|number} {
  const value=result && typeof result==='object' ? (result as Record<string,unknown>)[field] : undefined;
  const code=typeof value==='string'||(typeof value==='number'&&Number.isFinite(value))?value:'invalid-result';
  return Object.assign(new Error(message),{code});
}
/** Preserve explicit error fields only; never serialize arbitrary native objects, causes or stacks. */
export function serializeKernelError(error: unknown): SerializedKernelError {
  const result:SerializedKernelError={message:error instanceof Error?error.message:String(error)};
  if(error instanceof Error) {
    result.name=error.name;
    const code=(error as Error & {code?:unknown}).code;
    if(typeof code==='string'||(typeof code==='number'&&Number.isFinite(code))) result.code=code;
  }
  return result;
}
export function deserializeKernelError(operation:string,error:unknown):KernelRequestError {
  if(typeof error==='string') return new KernelRequestError(operation,error);
  const value=error as Partial<SerializedKernelError>|null;
  return new KernelRequestError(operation,typeof value?.message==='string'?value.message:'Kernel request failed',
    typeof value?.code==='string'||(typeof value?.code==='number'&&Number.isFinite(value.code))?value.code:undefined,
    typeof value?.name==='string'?value.name:undefined);
}
