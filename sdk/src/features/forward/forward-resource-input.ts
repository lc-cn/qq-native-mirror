/** Pure forward-resource input rules shared by the public facade and worker.
 * Limits count UTF-8 bytes; strings retain their exact content and are never coerced.
 * Protocol encoding, decompression and native acquisition belong to other modules.
 */
export function boundedForwardString(value: unknown, max: number, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value.length) || Buffer.byteLength(value) > max)
    throw new Error('Invalid forward resource: invalid bounded UTF-8 string');
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff))
        throw new Error('Invalid forward resource: unpaired surrogate');
    } else if (c >= 0xdc00 && c <= 0xdfff)
      throw new Error('Invalid forward resource: unpaired surrogate');
  }
  return value;
}
export function normalizeForwardResourceId(value: unknown): string {
  return boundedForwardString(value, 4096, true);
}
