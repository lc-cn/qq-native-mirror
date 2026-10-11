import type { FriendRequest } from '../../contracts/contacts.ts';

export type FriendRequestOperation = 'listFriendRequests' | 'handleFriendRequest';
export type CapturedFriendRequest = {
  request: Pick<FriendRequest, 'uid' | 'time'>;
  accept: boolean;
};

function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must be a nonempty string`);
  return value;
}

/** Capture only the approval identity, never the event's raw native carrier.
 * Shared before IPC and native dispatch; exact UID and decimal spelling survive.
 */
export function captureFriendRequest(payload: Record<string, unknown>): CapturedFriendRequest {
  const supplied = payload.request;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
    throw new Error('request must be an object');
  const request = supplied as Record<string, unknown>;
  const uid = nonempty(request.uid, 'request.uid');
  const time = nonempty(request.time, 'request.time');
  if (!/^\d+$/.test(time)) throw new Error('request.time must be a numeric string');
  const accept = payload.accept;
  if (typeof accept !== 'boolean') throw new Error('accept must be a boolean');
  return { request: { uid, time }, accept };
}
