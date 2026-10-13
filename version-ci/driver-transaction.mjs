/** Own the installed-version driver operation, its failure receipt and directory.
 * Reporting is secondary to the operation; cleanup always runs even if reporting fails.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {(error:unknown,stage:'operation'|'cleanup') => Promise<void>} reportFailure
 * @param {() => Promise<void>} cleanup
 * @returns {Promise<T>}
 */
export async function runVersionDriver(operation, reportFailure, cleanup) {
  /** @type {{ok:true,value:T}|{ok:false,error:unknown}} */
  let outcome;
  /** @type {unknown[]} */
  const failures = [];
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
    failures.push(error);
    try {
      await reportFailure(error, 'operation');
    } catch (reportError) {
      failures.push(reportError);
    }
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    failures.push(cleanupError);
    if (outcome.ok) {
      try {
        await reportFailure(cleanupError, 'cleanup');
      } catch (reportError) {
        failures.push(reportError);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Version driver, failure receipt or cleanup failed');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
