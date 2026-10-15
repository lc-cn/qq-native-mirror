import type { SendableMessageElement } from '../contracts/messages.ts';

type Element<T extends SendableMessageElement['type']> = Extract<
  SendableMessageElement,
  { type: T }
>;

/** Construct message data without validation, filesystem access or network I/O.
 * Sending validates the complete input and its conversation before dispatch.
 * Media values are local absolute paths; constructing an element does not read it.
 */
export const segment = Object.freeze({
  text(text: string): Element<'text'> {
    return { type: 'text', text };
  },
  /** Use "all" to mention the group. Mentions are rejected in private sends. */
  at(userId: string, text?: string): Element<'at'> {
    return { type: 'at', userId, ...(text === undefined ? {} : { text }) };
  },
  face(id: number): Element<'face'> {
    return { type: 'face', id };
  },
  image(file: string): Element<'image'> {
    return { type: 'image', file };
  },
  record(file: string): Element<'record'> {
    return { type: 'record', file };
  },
  video(file: string): Element<'video'> {
    return { type: 'video', file };
  },
  file(file: string, name?: string): Element<'file'> {
    return { type: 'file', file, ...(name === undefined ? {} : { name }) };
  },
  reply(messageId: string): Element<'reply'> {
    return { type: 'reply', messageId };
  },
});
