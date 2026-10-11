/** Capture an own data field without invoking native accessors. Descriptor traps
 * can retire the action; recheck outside the catch before interpreting the value
 * or allowing the next read. Projection and acknowledgement stay with each protocol.
 */
export function groupFileField(signal: AbortSignal, value: unknown, key: string): unknown {
  signal.throwIfAborted();
  let selected: unknown;
  try {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      selected = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    }
  } catch {
    // Preserve fixed invalid-result errors rather than exposing native trap wording.
  }
  signal.throwIfAborted();
  return selected;
}
