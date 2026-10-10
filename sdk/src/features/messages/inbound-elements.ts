import type { MessageElement } from '../../contracts/messages.ts';
import { decodeReceivedForward } from '../forward/received-forward.ts';
import type { NativeObject as Native } from '../../native/native-object.ts';

/** Decode only fields supported by the public contract; preserve every other
 * native element intact instead of silently dropping media or notifications. */
export function mentionUserId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return;
  const number = BigInt(value);
  if (number > 0n) return value;
  if (number >= -2147483648n && number < 0n) return String(number + 4294967296n);
}
export function mentionLookupUid(element: Native): string | undefined {
  const data = (record: Native, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const type = data(element, 'elementType');
  if (type === 10 || type === 16) return;
  const text = data(element, 'textElement');
  if (!text || typeof text !== 'object' || Array.isArray(text)) return;
  const content = data(text, 'content'),
    atType = data(text, 'atType'),
    atUid = data(text, 'atUid'),
    atNtUid = data(text, 'atNtUid');
  if (typeof content !== 'string' || (atType !== 2 && atType !== 4)) return;
  if (atUid !== undefined && atUid !== '' && !(typeof atUid === 'string' && /^0+$/.test(atUid)))
    return;
  if (typeof atNtUid === 'string' && atNtUid.trim() && !atNtUid.includes('*')) return atNtUid;
}
export function decodeElements(
  native: Native[],
  resolvedUins: ReadonlyMap<string, string> = new Map(),
): MessageElement[] {
  return Array.from(native, (element) => {
    if (!element || typeof element !== 'object' || Array.isArray(element))
      throw new Error('Invalid native message element');
    const typeDescriptor = Object.getOwnPropertyDescriptor(element, 'elementType');
    const nativeType =
      typeDescriptor && 'value' in typeDescriptor ? typeDescriptor.value : undefined;
    const typeNumber =
      typeof nativeType === 'number' || typeof nativeType === 'string' ? Number(nativeType) : NaN;
    const unknown: MessageElement = { type: 'unknown', nativeType: typeNumber, data: element };
    if (
      !typeDescriptor ||
      !('value' in typeDescriptor) ||
      (typeof nativeType !== 'number' && typeof nativeType !== 'string')
    )
      return unknown;
    if (typeNumber === 10 || typeNumber === 16) return decodeReceivedForward(element) ?? unknown;
    const text = element.textElement;
    if (text) {
      if (typeof text !== 'object' || Array.isArray(text) || typeof text.content !== 'string')
        return unknown;
      if (text.atType === 0 || (text.atType === undefined && !text.atUid && !text.atNtUid))
        return { type: 'text', text: text.content };
      if (text.atType === 1) return { type: 'at', userId: 'all', text: text.content };
      if (text.atType !== 2 && text.atType !== 4) return unknown;
      const uid = mentionLookupUid(element);
      const resolved = uid === undefined ? undefined : resolvedUins.get(uid);
      const userId =
        mentionUserId(text.atUid) ??
        (typeof resolved === 'string' && /^\d+$/.test(resolved) && /[1-9]/.test(resolved)
          ? resolved
          : undefined);
      return userId === undefined ? unknown : { type: 'at', userId, text: text.content };
    }
    if (element.replyElement?.replayMsgId)
      return { type: 'reply', messageId: String(element.replyElement.replayMsgId) };
    if (element.faceElement && Number.isInteger(element.faceElement.faceIndex))
      return { type: 'face', id: element.faceElement.faceIndex };
    if (element.picElement) {
      const file = element.picElement.filePath || element.picElement.sourcePath;
      if (typeof file === 'string' && file) return { type: 'image', file };
    }
    for (const [field, type] of [
      ['fileElement', 'file'],
      ['videoElement', 'video'],
      ['pttElement', 'record'],
    ] as const) {
      const media = element[field];
      if (media && typeof media.filePath === 'string' && media.filePath) {
        return {
          type,
          file: media.filePath,
          elementId: String(element.elementId ?? ''),
          ...(type === 'file' ? { name: media.fileName, size: media.fileSize } : {}),
        };
      }
    }
    return decodeReceivedForward(element) ?? unknown;
  });
}
