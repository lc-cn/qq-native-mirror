import type { ClientState, OfflineInfo, Account } from './client.ts';
import type { Message, MessageRecall } from './messages.ts';
import type { FriendRequest, FriendListUpdate, FriendAdded } from './contacts.ts';
import type {
  GroupRequest,
  GroupListUpdate,
  GroupMemberUpdate,
  GroupInfoUpdate,
  GroupMembershipEvent,
  GroupAdminEvent,
  GroupMuteEvent,
} from './groups.ts';

/** Explicit error fields suitable for diagnostic events across worker IPC. */
export interface DiagnosticFailure {
  message: string;
  name?: string;
  code?: string | number;
}

/** Runtime diagnostics expose supported fields rather than native error objects. */
export interface DiagnosticInfo {
  stage: string;
  cleanupFailures?: DiagnosticFailure[];
}

export interface ClientEvents {
  state: [ClientState];
  message: [Message];
  'message.private': [Message];
  'message.group': [Message];
  'message-recalled': [unknown];
  'message.recalled': [MessageRecall];
  kicked: [OfflineInfo];
  offline: [OfflineInfo];
  'msf-status': [{ status: number; reason: number; args: unknown[] }];
  'msf-error': [{ code?: number | string; description?: string; args: unknown[] }];
  'reconnect-error': [Error];
  'request.friend': [FriendRequest];
  'request.group': [GroupRequest];
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
