/** Shared identifier input rules; native numeric bounds belong to each operation. */
export function sendUserId(value: unknown, allowAll = false): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.includes('*'))
    throw new Error('Invalid send user identifier');
  if (
    (allowAll && value === 'all') ||
    (/^\d+$/.test(value) && /[1-9]/.test(value)) ||
    /^u_.+/.test(value)
  )
    return value;
  throw new Error('Invalid send user identifier');
}
export function sendGroupId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !/[1-9]/.test(value))
    throw new Error('Invalid send group identifier');
  return value;
}
