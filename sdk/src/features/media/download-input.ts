import { normalizeHistoryQuery } from '../messages/query-input.ts';
import type { Peer } from '../../types.ts';
import { isAbsolute } from 'node:path';

export function own(value: unknown, key: string): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Attachment fields require a plain object');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor))
    throw new Error('Attachment fields require own data properties');
  return descriptor?.value;
}
export function downloadStrings(messageId: unknown, elementId: unknown, destination: unknown) {
  if (
    typeof messageId !== 'string' ||
    !/^\d+$/.test(messageId) ||
    typeof elementId !== 'string' ||
    !/^\d+$/.test(elementId)
  )
    throw new Error('Attachment requires numeric messageId and elementId strings');
  if (typeof destination !== 'string' || destination.includes('\0') || !isAbsolute(destination))
    throw new Error('Attachment destination must be an absolute local path');
  return { messageId, elementId, destination };
}
export function captureDownloadRequest(
  peer: unknown,
  messageId: unknown,
  elementId: unknown,
  destination: unknown,
): { peer: Peer; messageId: string; elementId: string; destination: string } {
  const captured = normalizeHistoryQuery(peer, {}).peer;
  return { peer: captured, ...downloadStrings(messageId, elementId, destination) };
}
export function captureDownloadPayload(
  payload: unknown,
): ReturnType<typeof captureDownloadRequest> {
  return captureDownloadRequest(
    own(payload, 'peer'),
    own(payload, 'messageId'),
    own(payload, 'elementId'),
    own(payload, 'destination'),
  );
}
