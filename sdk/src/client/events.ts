import type { Account, ClientState, OfflineInfo } from '../contracts/client.ts';
import type { DiagnosticInfo } from '../contracts/diagnostics.ts';
import type { FriendRequest, FriendListUpdate, FriendAdded } from '../contracts/contacts.ts';
import type {
  GroupRequest,
  GroupListUpdate,
  GroupMemberUpdate,
  GroupInfoUpdate,
  GroupMembershipEvent,
  GroupAdminEvent,
  GroupMuteEvent,
} from '../contracts/groups.ts';
import type {
  Message,
  MessageInput,
  SentMessage,
  Peer,
  MessageRecall,
} from '../contracts/messages.ts';
import type { FriendContact } from './contacts/friend-contact.ts';
import type { GroupContact } from './contacts/group-contact.ts';
import type { GroupMemberContact } from './contacts/group-member-contact.ts';

/** A received event bound to its original client session and conversation. */
export interface MessageEvent extends Message {
  /** Captured routing is immutable; modifying the source DTO cannot redirect an event. */
  readonly peer: Readonly<Peer>;
  /** Captured text elements joined in order, without trimming or media placeholders. */
  readonly text: string;
  /** The captured conversation; available on the general message event. */
  readonly conversation: FriendContact | GroupContact;
  /** Reply in this conversation. Set quote to true to quote this message (default false).
   * Offline, closed or replaced sessions reject; sends are never automatically replayed.
   */
  readonly reply: (content: MessageInput, quote?: boolean) => Promise<SentMessage>;
}

/** A live private message with a directly addressable private conversation. */
export interface PrivateMessageEvent extends MessageEvent {
  readonly peer: Readonly<Extract<Peer, { type: 'private' }>>;
  readonly conversation: FriendContact;
  readonly friend: FriendContact;
}

/** A live group message with a directly addressable group conversation. */
export interface GroupMessageEvent extends MessageEvent {
  readonly peer: Readonly<Extract<Peer, { type: 'group' }>>;
  readonly conversation: GroupContact;
  readonly group: GroupContact;
  /** The captured sender in this group; display metadata stays on sender. */
  readonly member: GroupMemberContact;
}

/** Live request capability bound to the receiving account session. */
export interface FriendRequestEvent extends FriendRequest {
  /** Submit an explicit decision (accept by default). Submission does not prove
   * remote friendship; retired sessions reject and failed actions are not replayed.
   */
  readonly approve: (accept?: boolean) => Promise<void>;
}

/** Live request capability bound to the receiving account session. */
export interface GroupRequestEvent extends GroupRequest {
  /** Submit one decision (accept by default), preserving the native operation's
   * acknowledgement semantics. A timeout does not prove the request was unchanged.
   */
  readonly approve: (accept?: boolean, reason?: string) => Promise<void>;
}

export interface ClientEvents {
  state: [ClientState];
  message: [MessageEvent];
  'message.private': [PrivateMessageEvent];
  'message.group': [GroupMessageEvent];
  'message-recalled': [unknown];
  'message.recalled': [MessageRecall];
  kicked: [OfflineInfo];
  offline: [OfflineInfo];
  'msf-status': [{ status: number; reason: number; args: unknown[] }];
  'msf-error': [{ code?: number | string; description?: string; args: unknown[] }];
  'reconnect-error': [Error];
  'request.friend': [FriendRequestEvent];
  /** @deprecated Use request.friend. Both names share one event and approval capability. */
  'friend-request': [FriendRequestEvent];
  'request.group': [GroupRequestEvent];
  'friend-list-updated': [FriendListUpdate];
  'friend-added': [FriendAdded];
  'group-list-updated': [GroupListUpdate];
  'group-members-updated': [GroupMemberUpdate];
  'group-info-updated': [GroupInfoUpdate];
  'group-membership': [GroupMembershipEvent];
  'group-admin': [GroupAdminEvent];
  'group-mute': [GroupMuteEvent];
  qrcode: [{ image: Buffer; url: string }];
  authenticated: [Account];
  login: [Account];
  ready: [Account];
  disconnected: [OfflineInfo | undefined];
  logout: [undefined];
  'qr-scanned': [undefined];
  'login-error': [Error];
  loginError: [Error];
  diagnostic: [DiagnosticInfo];
  'native-callback': [{ family: string; name: string; argumentTypes: string[] }];
  terminated: [Error];
  log: [{ stream: 'stdout' | 'stderr'; text: string }];
}
