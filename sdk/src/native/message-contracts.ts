import type { NativeObject } from './native-object.ts';
/** Versioned native conversation descriptor; distinct from the public Peer DTO. */
export interface NativePeer {
  chatType: 1 | 2;
  peerUid: string;
  guildId?: string;
}
/** Receipt fields shared by message correlation and projection adapters. */
export interface NativeMessage extends NativeObject {
  msgId: string;
  peerUid: string;
  chatType: number;
}
