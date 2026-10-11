import type { GroupRequest, GroupRequestOptions } from '../../contracts/groups.ts';

interface GroupRequestPayloads {
  listGroupRequests: {
    options: Required<Omit<GroupRequestOptions, 'before'>> & Pick<GroupRequestOptions, 'before'>;
  };
  handleGroupRequest: {
    request: Pick<GroupRequest, 'groupId' | 'sequence' | 'type' | 'doubt'>;
    accept: boolean;
    reason: string | undefined;
  };
}
export type GroupRequestOperation = keyof GroupRequestPayloads;
export type CapturedGroupRequestOperation<K extends GroupRequestOperation = GroupRequestOperation> =
  {
    [P in K]: { method: P; payload: GroupRequestPayloads[P] };
  }[K];

function numeric(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error(`${name} must be a numeric string`);
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}
function requestType(value: unknown): 1 | 5 | 7 {
  if (value !== 1 && value !== 5 && value !== 7) throw new Error('Unsupported group request type');
  return value;
}

/** Pure request preflight. Missing cursors stay absent: native execution maps
 * absence to its empty cursor, while an explicitly empty public cursor is invalid.
 * Detached selected fields make repeated capture safe at both IPC boundaries.
 */
export function captureGroupRequestOperation<K extends GroupRequestOperation>(
  method: K,
  payload: Record<string, unknown>,
): CapturedGroupRequestOperation<K>;
export function captureGroupRequestOperation(
  method: GroupRequestOperation,
  payload: Record<string, unknown>,
): CapturedGroupRequestOperation {
  if (method === 'listGroupRequests') {
    const supplied = payload.options;
    if (
      supplied !== undefined &&
      (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
    )
      throw new Error('options must be an object');
    const options = (supplied ?? {}) as Record<string, unknown>;
    // Preserve the existing list preflight read order before validating defaults.
    const capturedDoubt = options.doubt;
    const capturedBefore = options.before;
    const capturedLimit = options.limit;
    const doubt = capturedDoubt === undefined ? false : bool(capturedDoubt, 'doubt');
    const before = capturedBefore === undefined ? undefined : numeric(capturedBefore, 'before');
    const limit = capturedLimit ?? 20;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('limit must be an integer between 1 and 100');
    return {
      method,
      payload: { options: { doubt, limit, ...(before === undefined ? {} : { before }) } },
    };
  }
  if (method !== 'handleGroupRequest')
    throw new Error(`Unsupported group request operation: ${method}`);
  const supplied = payload.request;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
    throw new Error('request must be an object');
  const request = supplied as Record<string, unknown>;
  const groupId = numeric(request.groupId, 'request.groupId');
  const sequence = numeric(request.sequence, 'request.sequence');
  const type = requestType(request.type);
  const doubt = bool(request.doubt, 'request.doubt');
  const accept = bool(payload.accept, 'accept');
  const reason = payload.reason;
  if (reason !== undefined && typeof reason !== 'string')
    throw new Error('reason must be a string');
  return { method, payload: { request: { groupId, sequence, type, doubt }, accept, reason } };
}
