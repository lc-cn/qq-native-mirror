import type { DeleteFriendOptions } from '../../contracts/contacts.ts';
import { nativeUid } from '../../validation/identifiers.ts';

interface ContactPayloads {
  getUserProfile: { userId: string };
  getUserProfileByUid: { uid: string };
  setFriendRemark: { userId: string; remark: string };
  deleteFriend: { userId: string; options: Required<DeleteFriendOptions> };
}
export type ContactOperation = keyof ContactPayloads;
/** The operation discriminator keeps validated fields correlated for domain dispatch. */
export type CapturedContactOperation<K extends ContactOperation = ContactOperation> = {
  [P in K]: { method: P; payload: ContactPayloads[P] };
}[K];

function userId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error('userId must be a numeric string');
  return value;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

/** Pure preflight shared by the facade, CLI and domain owner. Captures each
 * selected field once, preserving decimal spelling and allocating detached options.
 * It neither resolves identities nor acquires native services.
 */
export function captureContactOperation<K extends ContactOperation>(
  method: K,
  payload: Record<string, unknown>,
): CapturedContactOperation<K>;
export function captureContactOperation(
  method: ContactOperation,
  payload: Record<string, unknown>,
): CapturedContactOperation {
  if (method === 'getUserProfileByUid') {
    const uid = payload.uid;
    if (!nativeUid(uid))
      throw new Error('uid must be an unmasked native UID without surrounding whitespace');
    return { method, payload: { uid } };
  }
  const id = userId(payload.userId);
  switch (method) {
    case 'getUserProfile':
      return { method, payload: { userId: id } };
    case 'setFriendRemark': {
      const remark = payload.remark;
      if (typeof remark !== 'string') throw new Error('remark must be a string');
      return { method, payload: { userId: id, remark } };
    }
    case 'deleteFriend': {
      const supplied = payload.options;
      if (
        supplied !== undefined &&
        (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
      )
        throw new Error('options must be an object');
      const options = (supplied ?? {}) as Record<string, unknown>;
      const block = options.block;
      const capturedBlock = block === undefined ? false : flag(block, 'block');
      const both = options.both;
      const capturedBoth = both === undefined ? false : flag(both, 'both');
      return {
        method,
        payload: { userId: id, options: { block: capturedBlock, both: capturedBoth } },
      };
    }
    default:
      throw new Error(`Unsupported contact operation: ${method}`);
  }
}
