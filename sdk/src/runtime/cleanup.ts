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

/** Retains the primary operation failure alongside any teardown failure. */
export function withCleanupFailure(original: unknown, cleanup: unknown): Error {
  const errors = cleanup instanceof AggregateError ? cleanup.errors : [cleanup];
  return new AggregateError([original, ...errors], 'Operation and cleanup failed');
}
