import { isAbsolute } from 'node:path';
import { validateFaceId } from './face-input.ts';
import type { SendableMessageElement } from '../../contracts/messages.ts';

import { sendUserId, sendGroupId } from '../../validation/identifiers.ts';
export { sendUserId, sendGroupId } from '../../validation/identifiers.ts';

/** Only selected own data fields participate in a send. Accessors are rejected
 * without execution; absent optional fields remain undefined. This does not make
 * arbitrary Proxy descriptor traps side-effect free. */
function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor))
    throw new Error('Message input requires own data properties');
  return descriptor?.value;
}

function captureElement(value: unknown, group: boolean): SendableMessageElement {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid message element');
  const type = field(value, 'type');
  switch (type) {
    case 'text': {
      const text = field(value, 'text');
      if (typeof text !== 'string') throw new Error('Invalid text element');
      return { type, text };
    }
    case 'at': {
      if (!group) throw new Error('Mentions require a group peer');
      const userId = sendUserId(field(value, 'userId') ?? field(value, 'id'), true);
      const text = field(value, 'text');
      if (text !== undefined && typeof text !== 'string') throw new Error('Invalid mention text');
      return { type, userId, ...(text === undefined ? {} : { text }) };
    }
    case 'face': {
      const id = field(value, 'id');
      validateFaceId(id);
      return { type, id };
    }
    case 'image':
    case 'video':
    case 'record':
    case 'file': {
      const file = field(value, 'file');
      if (typeof file !== 'string' || !isAbsolute(file))
        throw new Error(`${type} requires an absolute local file path`);
      if (type !== 'file') return { type, file };
      const name = field(value, 'name');
      if (name !== undefined && (typeof name !== 'string' || !name || /[/\\]/.test(name)))
        throw new Error('Attachment name must be a filename');
      return { type, file, ...(name === undefined ? {} : { name }) };
    }
    case 'reply': {
      const messageId = field(value, 'messageId');
      if (typeof messageId !== 'string' || !/^\d+$/.test(messageId) || !/[1-9]/.test(messageId))
        throw new Error('Invalid reply message identifier');
      return { type, messageId };
    }
    default:
      throw new Error('Unsupported message element');
  }
}

/** Capture the dense batch before IPC, UID queries, media preparation, reply
 * lookup or submission. Uses array data slots rather than caller-owned iterators.
 * Does not assert local media content validity. */
export function captureSendInput(input: unknown, group: boolean): SendableMessageElement[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (!Array.isArray(input)) throw new Error('Message must contain elements');
  const length = field(input, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0)
    throw new Error('Message must contain elements');
  const captured: SendableMessageElement[] = [];
  for (let index = 0; index < length; index++)
    captured.push(captureElement(field(input, String(index)), group));
  return captured;
}

/** Capture destination and the complete message before IPC or recipient lookup. */
export function capturePrivateMessage(userId: unknown, message: unknown) {
  return { userId: sendUserId(userId), message: captureSendInput(message, false) };
}

/** Group destinations retain their spelling; mentions are validated by the same batch capture. */
export function captureGroupMessage(groupId: unknown, message: unknown) {
  return { groupId: sendGroupId(groupId), message: captureSendInput(message, true) };
}
