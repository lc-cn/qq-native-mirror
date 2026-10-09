/** Exact native UixConvert maps; no profile/group fallback or retry. */
export function positiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && /[1-9]/.test(value);
}
export function nativeUid(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.trim() === value && !value.includes('*');
}
export async function resolveNativeUins(
  requested: readonly string[], resolveUins: (uids: string[]) => Promise<ReadonlyMap<string, string>>,
  signal: AbortSignal, diagnostic: (stage: string) => void,
  failureStage: string, unresolvedStage: string,
): Promise<ReadonlyMap<string, string>> {
  signal.throwIfAborted();
  const uids = [...new Set(requested)];
  if (!uids.length) return new Map();
  try {
    const result = await new Promise<ReadonlyMap<string, string>>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Native identity lookup timed out')); }, 10_000);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return resolveUins(uids); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
    signal.throwIfAborted();
    if (!(result instanceof Map)) throw new Error('Invalid native identity map');
    const valid = new Map<string, string>();
    for (const uid of uids) { const uin = result.get(uid); if (positiveDecimal(uin)) valid.set(uid, uin); }
    if (valid.size !== uids.length) diagnostic(unresolvedStage);
    return valid;
  } catch {
    signal.throwIfAborted(); diagnostic(failureStage); return new Map();
  }
}
