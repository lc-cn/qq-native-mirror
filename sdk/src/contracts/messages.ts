export type Peer = { type: 'private'; userId: string } | { type: 'group'; groupId: string };

export type SendableMessageElement =
  | { type: 'text'; text: string }
  | { type: 'at'; userId: string; text?: string }
  | { type: 'face'; id: number }
  | { type: 'image'; file: string }
  | { type: 'video'; file: string; elementId?: string }
  | { type: 'record'; file: string; elementId?: string }
  | { type: 'reply'; messageId: string }
  | { type: 'file'; file: string; name?: string; size?: string; elementId?: string };

/** Received merged-record reference; this is not a sendable raw card. */
export interface ReceivedForwardElement {
  type: 'forward';
  format: 'ark' | 'native';
  resourceId: string;
  cardId?: string;
  title?: string;
  summary?: string;
  prompt?: string;
  count?: number;
  previews?: string[];
}

export type MessageElement =
  | SendableMessageElement
  | ReceivedForwardElement
  | { type: 'unknown'; nativeType: number; data: unknown };

/** A single element or an ordered, immutable-friendly mix of text and elements. */
export type MessageInput =
  string | SendableMessageElement | readonly (string | SendableMessageElement)[];

export interface SentMessage {
  messageId: string;
  sequence: string;
  time: number;
}

export interface Message extends SentMessage {
  peer: Peer;
  sender: { userId: string; uid: string; nickname: string };
  elements: MessageElement[];
  raw: unknown;
}

/** A received event bound to its original client session and conversation. */
export interface MessageEvent extends Message {
  /** Captured routing is immutable; modifying the source DTO cannot redirect an event. */
  readonly peer: Readonly<Peer>;
  /** Reply in this conversation. Set quote to true to quote this message (default false).
   * Offline, closed or replaced sessions reject; sends are never automatically replayed.
   */
  readonly reply: (content: MessageInput, quote?: boolean) => Promise<SentMessage>;
}

/** A live private message with a directly addressable private conversation. */
export interface PrivateMessageEvent extends MessageEvent {
  readonly peer: Readonly<Extract<Peer, { type: 'private' }>>;
}

/** A live group message with a directly addressable group conversation. */
export interface GroupMessageEvent extends MessageEvent {
  readonly peer: Readonly<Extract<Peer, { type: 'group' }>>;
}

/** Passive recall metadata. The native timestamp string's unit and operator are unverified. */
export interface MessageRecall {
  peer: Peer;
  messageId: string;
  sequence: string;
  recallTime: string;
}

export interface HistoryOptions {
  before?: string;
  limit?: number;
}
