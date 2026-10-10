import type { LoginRequest } from '../contracts/client.ts';

/** Validate JS/IPC input and own the authorization target before any await. */
export function normalizeLoginRequest(value: unknown): LoginRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid login request: expected an object');
  const { method, uin } = value as { method?: unknown; uin?: unknown };
  if (method !== 'qr' && method !== 'quick' && method !== 'restore')
    throw new TypeError('Invalid login method: expected qr, quick or restore');
  if (method === 'qr') return { method };
  if (
    (method === 'quick' || uin !== undefined) &&
    (typeof uin !== 'string' || !/^\d+$/.test(uin))
  ) {
    throw new TypeError('Invalid login account number: expected a decimal string');
  }
  if (method === 'quick') return { method, uin: uin as string };
  return { method, ...(uin === undefined ? {} : { uin: uin as string }) };
}
