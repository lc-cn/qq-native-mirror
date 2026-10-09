import { decodeElements, mentionLookupUid } from './message-elements.ts';
import type { MessageElement } from './types.ts';
type Native = Record<string, any>;

export function needsMentionLookup(elements: Native[]): boolean {
  return elements.some(element => element && typeof element === 'object' && mentionLookupUid(element) !== undefined);
}

/** UixConvert.getUin returns uinInfo: Map keyed by exact input UID at fixed
 * NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076. No fallback RPC or retry.
 * Unsupported/unresolved elements remain unknown, retaining native evidence.
 */
export async function decodeResolvedElementBatches(
  batches: Native[][],
  resolveUins: (uids: string[]) => Promise<ReadonlyMap<string, string>>,
  signal: AbortSignal,
  diagnostic: (stage: string) => void,
): Promise<MessageElement[][]> {
  signal.throwIfAborted();
  // Validate every element before initiating identity work for any record.
  const decoded = batches.map(elements => decodeElements(elements));
  // Capture mention fields before awaiting native work, while unknown elements
  // still retain their original raw object as evidence.
  const snapshots = batches.map(elements => elements.map(element => element.textElement && typeof element.textElement === 'object' && !Array.isArray(element.textElement) ? { ...element, textElement: { ...element.textElement } } : element));
  const uids = [...new Set(snapshots.flatMap(elements => Array.from(elements, mentionLookupUid)).filter((value): value is string => value !== undefined))];
  if (uids.length === 0) return decoded;
  let resolved: ReadonlyMap<string, string> = new Map();
  try {
    resolved = await new Promise<ReadonlyMap<string, string>>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Mention identity lookup timed out')); }, 10_000);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return resolveUins(uids); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
    signal.throwIfAborted();
    if (!(resolved instanceof Map)) throw new Error('Invalid native mention identity map');
    if (uids.some(uid => typeof resolved.get(uid) !== 'string' || !/^\d+$/.test(resolved.get(uid)!) || !/[1-9]/.test(resolved.get(uid)!))) diagnostic('unresolved-native-mention');
  } catch {
    signal.throwIfAborted();
    diagnostic('native-mention-lookup-failed');
    return decoded;
  }
  return snapshots.map((elements, batchIndex) => decodeElements(elements, resolved).map((element, index) => element.type === 'unknown' ? decoded[batchIndex][index] : element));
}
