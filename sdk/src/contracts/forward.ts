import type { SentMessage } from './messages.ts';

/** Observed protobuf records, separate from native messages with query/recall IDs. */
export type ForwardResourceElement =
  | { type: 'text'; text: string }
  | { type: 'at'; text: string; userId?: string; uid?: string; raw: Buffer }
  | { type: 'face'; id: number; serviceType?: never; businessType?: never; raw?: never }
  | { type: 'face'; id: number; serviceType: 33 | 37; businessType?: number; raw: Buffer }
  | { type: 'unknown'; fieldNumbers: number[]; raw: Buffer };

export interface ForwardRecord {
  sender: { userId?: string; uid?: string; nickname?: string };
  time?: number;
  elements: ForwardResourceElement[];
  raw: Buffer;
}

export interface ForwardResource {
  resourceId: string;
  records: ForwardRecord[];
  /** Complete decompressed payload, including unrecognized actions and fields. */
  raw: Buffer;
}

/** Text-only merged record; time is an explicit Unix timestamp in seconds. */
export interface ForwardTextNode {
  userId: string;
  nickname: string;
  time: number;
  text: string;
}

export interface MergedForwardOptions {
  title?: string;
  summary?: string;
  prompt?: string;
}

export interface SentMergedForward extends SentMessage {
  resourceId: string;
}
