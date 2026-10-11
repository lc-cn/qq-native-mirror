import type { MessageElement } from '../../contracts/messages.ts';
import { decodeReceivedForward } from '../forward/received-forward.ts';

// An accessor is invalid data, not an absent optional field. Never execute it
// or coerce native values while projecting the public element contract.
const accessor = Symbol('native-element-accessor');
function data(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor === undefined ? undefined : 'value' in descriptor ? descriptor.value : accessor;
}
function record(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function textFields(text: object) {
  return {
    content: data(text, 'content'),
    atType: data(text, 'atType'),
    atUid: data(text, 'atUid'),
    atNtUid: data(text, 'atNtUid'),
  };
}
function lookupUid({ content, atType, atUid, atNtUid }: ReturnType<typeof textFields>) {
  if (typeof content !== 'string' || (atType !== 2 && atType !== 4)) return;
  if (atUid !== undefined && atUid !== '' && !(typeof atUid === 'string' && /^0+$/.test(atUid)))
    return;
  if (typeof atNtUid === 'string' && atNtUid.trim() && !atNtUid.includes('*')) return atNtUid;
}
export function mentionUserId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return;
  const number = BigInt(value);
  if (number > 0n) return value;
  if (number >= -2147483648n && number < 0n) return String(number + 4294967296n);
}
export function mentionLookupUid(element: unknown): string | undefined {
  if (!record(element)) return;
  const type = data(element, 'elementType');
  if (type === 10 || type === 16 || type === accessor) return;
  const text = data(element, 'textElement');
  return record(text) ? lookupUid(textFields(text)) : undefined;
}

/** Project validated own data fields only. Unsupported or malformed variants
 * retain their native object rather than exposing an invalid public DTO. */
export function decodeElements(
  native: unknown[],
  resolvedUins: ReadonlyMap<string, string> = new Map(),
): MessageElement[] {
  return Array.from(native, (element) => {
    if (!record(element)) throw new Error('Invalid native message element');
    const nativeType = data(element, 'elementType');
    const typeNumber =
      typeof nativeType === 'number' || typeof nativeType === 'string' ? Number(nativeType) : NaN;
    const unknown: MessageElement = { type: 'unknown', nativeType: typeNumber, data: element };
    if (typeof nativeType !== 'number' && typeof nativeType !== 'string') return unknown;
    if (typeNumber === 10 || typeNumber === 16) return decodeReceivedForward(element) ?? unknown;
    const text = data(element, 'textElement');
    if (text) {
      if (!record(text)) return unknown;
      const fields = textFields(text);
      const { content, atType, atUid, atNtUid } = fields;
      if (typeof content !== 'string' || [atType, atUid, atNtUid].includes(accessor))
        return unknown;
      if (atType === 0 || (atType === undefined && !atUid && !atNtUid))
        return { type: 'text', text: content };
      if (atType === 1) return { type: 'at', userId: 'all', text: content };
      if (atType !== 2 && atType !== 4) return unknown;
      const uid = lookupUid(fields);
      const resolved = uid === undefined ? undefined : resolvedUins.get(uid);
      const userId =
        mentionUserId(atUid) ??
        (typeof resolved === 'string' && /^\d+$/.test(resolved) && /[1-9]/.test(resolved)
          ? resolved
          : undefined);
      return userId === undefined ? unknown : { type: 'at', userId, text: content };
    }
    const reply = data(element, 'replyElement');
    if (reply) {
      if (!record(reply)) return unknown;
      const messageId = data(reply, 'replayMsgId');
      if (messageId !== undefined && messageId !== '')
        return typeof messageId === 'string' ? { type: 'reply', messageId } : unknown;
    }
    const face = data(element, 'faceElement');
    if (face) {
      if (!record(face)) return unknown;
      const id = data(face, 'faceIndex');
      if (typeof id === 'number' && Number.isInteger(id)) return { type: 'face', id };
      return unknown;
    }
    const picture = data(element, 'picElement');
    if (picture) {
      if (!record(picture)) return unknown;
      const file = data(picture, 'filePath') || data(picture, 'sourcePath');
      if (typeof file === 'string' && file) return { type: 'image', file };
      return unknown;
    }
    for (const [field, type] of [
      ['fileElement', 'file'],
      ['videoElement', 'video'],
      ['pttElement', 'record'],
    ] as const) {
      const media = data(element, field);
      if (!media) continue;
      if (!record(media)) return unknown;
      const file = data(media, 'filePath');
      if (typeof file !== 'string' || !file) return unknown;
      const elementId = data(element, 'elementId') ?? '';
      if (typeof elementId !== 'string') return unknown;
      if (type === 'file') {
        const name = data(media, 'fileName');
        const size = data(media, 'fileSize');
        if (
          (name !== undefined && typeof name !== 'string') ||
          (size !== undefined && typeof size !== 'string')
        )
          return unknown;
        return { type, file, elementId, name, size };
      }
      return { type, file, elementId };
    }
    return decodeReceivedForward(element) ?? unknown;
  });
}
