/** Runs each teardown once. One failure retains its identity; multiple failures
 * retain every original value in an AggregateError. No cleanup is retried.
 */
export function cleanupAll(steps: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Multiple cleanup operations failed');
}

/** Expand only an inspectable own-data list; opaque teardown failures stay intact. */
function cleanupFailures(cleanup: unknown): unknown[] {
  try {
    if (cleanup instanceof AggregateError) {
      const field = Object.getOwnPropertyDescriptor(cleanup, 'errors');
      const value: unknown = field && 'value' in field ? field.value : undefined;
      if (Array.isArray(value)) {
        const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
          const captured: unknown[] = [];
          for (let index = 0; index < length; index++) {
            const item = Object.getOwnPropertyDescriptor(value, String(index));
            if (!item || !('value' in item)) return [cleanup];
            captured.push(item.value);
          }
          return captured;
        }
      }
    }
  } catch {
    // Unknown throws may reject brand or descriptor inspection; never replace them.
  }
  return [cleanup];
}

/** Retains the primary operation failure alongside any teardown failure. */
export function withCleanupFailure(original: unknown, cleanup: unknown): Error {
  return new AggregateError(
    [original, ...cleanupFailures(cleanup)],
    'Operation and cleanup failed',
  );
}
