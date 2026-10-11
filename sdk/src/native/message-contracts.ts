/** Versioned native conversation descriptor; distinct from the public Peer DTO. */
export interface NativePeer {
  chatType: 1 | 2;
  peerUid: string;
  guildId?: string;
}
