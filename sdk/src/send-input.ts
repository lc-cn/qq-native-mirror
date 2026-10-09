import { isAbsolute } from 'node:path';
import { validateFaceId } from './message-elements.ts';
import type { SendableMessageElement } from './types.ts';

export function sendUserId(value: unknown, allowAll = false): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.includes('*')) throw new Error('Invalid send user identifier');
  if ((allowAll && value === 'all') || (/^\d+$/.test(value) && /[1-9]/.test(value)) || /^u_.+/.test(value)) return value;
  throw new Error('Invalid send user identifier');
}
export function sendGroupId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !/[1-9]/.test(value)) throw new Error('Invalid send group identifier');
  return value;
}
/** Validate and capture the whole batch before UID queries, media preparation,
 * reply lookup or native submission. Does not assert local media content validity. */
export function captureSendInput(input: unknown, group: boolean): SendableMessageElement[] {
  const values = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
  if (!Array.isArray(values) || !values.length) throw new Error('Message must contain elements');
  return Array.from(values, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message element');
    switch (value.type) {
      case 'text':
        if (typeof value.text !== 'string') throw new Error('Invalid text element');
        return { type: 'text', text: value.text };
      case 'at': {
        if (!group) throw new Error('Mentions require a group peer');
        const userId = sendUserId(value.userId ?? value.id, true);
        if (value.text !== undefined && typeof value.text !== 'string') throw new Error('Invalid mention text');
        return { type: 'at', userId, ...(value.text === undefined ? {} : { text: value.text }) };
      }
      case 'face': validateFaceId(value.id); return { type: 'face', id: value.id };
      case 'image': case 'video': case 'record': case 'file': {
        if (typeof value.file !== 'string' || !isAbsolute(value.file)) throw new Error(`${value.type} requires an absolute local file path`);
        if (value.type === 'file' && value.name !== undefined && (typeof value.name !== 'string' || !value.name || /[/\\]/.test(value.name))) throw new Error('Attachment name must be a filename');
        return { type: value.type, file: value.file, ...(value.type === 'file' && value.name !== undefined ? { name: value.name } : {}) };
      }
      case 'reply':
        if (typeof value.messageId !== 'string' || !/^\d+$/.test(value.messageId) || !/[1-9]/.test(value.messageId)) throw new Error('Invalid reply message identifier');
        return { type: 'reply', messageId: value.messageId };
      default: throw new Error(`Unsupported message element: ${String(value.type)}`);
    }
  });
}

export function sentReceipt(message: Record<string, unknown>) {
  if (typeof message.msgId !== 'string' || !/^\d+$/.test(message.msgId) || !/[1-9]/.test(message.msgId)
    || typeof message.msgSeq !== 'string' || !/^\d+$/.test(message.msgSeq)
    || typeof message.msgTime !== 'string' || !/^\d+$/.test(message.msgTime)) throw new Error('Invalid native sent message receipt metadata');
  const time = Number(message.msgTime);
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid native sent message receipt time');
  return { messageId: message.msgId, sequence: message.msgSeq, time };
}
