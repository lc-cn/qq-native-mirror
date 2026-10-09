import { decodeElements, mentionLookupUid } from './message-elements.ts';
import { resolveNativeUins } from './native-identities.ts';
import type { MessageElement } from './types.ts';
type Native = Record<string, any>;

export function needsMentionLookup(elements: Native[]): boolean {
  return elements.some(element => element && typeof element === 'object' && mentionLookupUid(element) !== undefined);
}
export function captureElementBatches(batches: Native[][]) {
  const dense = Array.from(batches, elements => { if (!Array.isArray(elements)) throw new Error('Invalid native message element batch'); return elements; });
  const decoded = dense.map(elements => decodeElements(elements));
  const snapshots = dense.map(elements => elements.map(element => element.textElement && typeof element.textElement === 'object' && !Array.isArray(element.textElement) ? { ...element, textElement: { ...element.textElement } } : element));
  const uids = [...new Set(snapshots.flatMap(elements => Array.from(elements, mentionLookupUid)).filter((value): value is string => value !== undefined))];
  return { decoded, snapshots, uids };
}
export function decodeCapturedElements(captured: ReturnType<typeof captureElementBatches>, uins: ReadonlyMap<string, string>): MessageElement[][] {
  return captured.snapshots.map((elements, batch) => elements.map((element, index) => {
    if (mentionLookupUid(element) === undefined) return captured.decoded[batch][index];
    const resolved = decodeElements([element], uins)[0];
    return resolved.type === 'unknown' ? captured.decoded[batch][index] : resolved;
  }));
}
/** One keyed UID query; unknown mention evidence and exact numeric IDs survive. */
export async function decodeResolvedElementBatches(
  batches: Native[][], resolveUins: (uids: string[]) => Promise<ReadonlyMap<string, string>>,
  signal: AbortSignal, diagnostic: (stage: string) => void,
): Promise<MessageElement[][]> {
  signal.throwIfAborted();
  const captured = captureElementBatches(batches);
  const resolved = await resolveNativeUins(captured.uids, resolveUins, signal, diagnostic, 'native-mention-lookup-failed', 'unresolved-native-mention');
  signal.throwIfAborted();
  return decodeCapturedElements(captured, resolved);
}
