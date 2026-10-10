export interface QQVersion {
  clientVersion: string;
  appId: string;
  qua: string;
}
export type LoginRequest = { method: 'qr' } | { method: 'quick'; uin: string } | { method: 'restore'; uin?: string };
export interface NativeManifest {
  /** Required for a bundle that uses a Node internal-ABI adapter. */
  nodeVersion?: string;
  nodeConfigSha256?: string;
  schemaVersion: 1;
  id: string;
  platform: NodeJS.Platform;
  arch: string;
  wrapper: string;
  /** Optional bundled video addon/module, covered by the same files SHA-256 inventory. */
  videoCodec?: string;
  npmStorage?: {format:'gzip-objects-v1';objects:Array<{path:string;sha256:string;downloadSha256:string;size:number;downloadSize:number}>};
  version: QQVersion;
  files: Array<{ path: string; url: string; sha256: string; size?: number; encoding?: 'gzip'; downloadSha256?: string }>;
}
export interface ClientOptions {
  /** HTTPS native catalog; defaults to the project's GitHub mirror. */
  catalogUrl?: string;
  /** HTTPS proxy prefixes for native file URLs, e.g. https://proxy.example/. Original URL is the final fallback. */
  downloadMirrors?: string[];
  wrapperPath?: string;
  /** Complete native package manifest; relative file URLs resolve against this URL. */
  manifestUrl?: string;
  cacheDir?: string;
  /** Required trusted digest when fetching a manifest from a mirror. */
  manifestSha256?: string;
  bridgePath?: string;
  /** Libraries loaded globally before the QQ wrapper. Linux defaults to libgnutls.so.30. */
  preloadLibraries?: string[];
  dataDir: string;
  version?: QQVersion;
  device?: { hostname?: string; osVersion?: string };
  login?: LoginRequest;
  /** Explicit native password-retention setting; omitted leaves the native default unchanged. Not a guarantee of QR restoration. */
  rememberPassword?: boolean;
  /** Absolute executable paths for real video metadata and thumbnail generation. */
  mediaTools?: { ffmpeg: string; ffprobe: string };
  /** Optional local codec override; defaults to bundled silk-wasm for PCM16 WAV/Tencent SILK. */
  recordCodecPath?: string;
  /** Local video codec override; otherwise uses the verified native bundle's declaration. */
  videoCodecPath?: string;
  /** Positive Node timer duration in milliseconds (maximum 2147483647). */
  timeoutMs?: number;
  /** Restore only after a disconnect explicitly classified as retryable. Unknown failures and kicks never trigger automatic login. */
  autoReconnect?: boolean | { maxAttempts?: number; delayMs?: number };
}
export interface Account { uin: string; uid: string }
export interface NativeCallbackAudit { family: string; name: string; argumentTypes: string[]; count: number }
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
  diagnostic: [{ stage: string }];
  'native-callback': [{ family: string; name: string; argumentTypes: string[] }];
  terminated: [Error];
  log: [{ stream: 'stdout' | 'stderr'; text: string }];
}

export type ClientState = 'idle' | 'connecting' | 'online' | 'disconnected' | 'closing' | 'closed' | 'failed';
export interface Friend { userId: string; uid: string; nickname: string; remark: string }
/** System-message metadata; unknown codes stay unknown and operator may be absent. */
export interface GroupMembershipEvent { groupId: string; direction: 'increase' | 'decrease'; code: number; kind: 'invite' | 'leave' | 'kick' | 'kick-me' | 'disband' | 'unknown'; memberUid?: string; operatorUid?: string }
export interface GroupAdminEvent { groupId: string; memberUid: string; enabled: boolean }
export interface GroupMuteEvent { groupId: string; scope: 'member' | 'all'; durationSeconds: string; enabled: boolean; memberUid?: string; operatorUid: string }
export interface FriendCategory { categoryId: number; sortId: number; name: string; memberCount: number; onlineCount: number; friends: Friend[] }
/** Projected Buddy metadata; optional remarks remain absent when not supplied. */
export interface FriendChange { userId: string; uid: string; nickname: string; remark?: string }
export interface FriendCategoryChange { categoryId: number; name: string; memberCount: number; friends: FriendChange[] }
/** Native categorized metadata, without a completeness marker or inferred add/remove cause. */
export interface FriendListUpdate { categories: FriendCategoryChange[] }
export interface Group { groupId: string; name: string; memberCount: number; maxMemberCount: number }
export interface GroupMember { userId: string; uid: string; nickname: string; card: string; role: 'owner' | 'admin' | 'member' }
/** Native metadata notification; optional fields remain absent when not supplied. */
export interface GroupChange { groupId: string; name?: string; memberCount?: number; maxMemberCount?: number }
export interface GroupListUpdate { kind: 'refresh' | 'all' | 'modified' | 'removed'; groups: GroupChange[] }
export interface GroupMemberChange {
  uid: string;
  userId?: string;
  nickname?: string;
  card?: string;
  role?: 'unspecified' | 'stranger' | 'member' | 'admin' | 'owner';
  deleted?: boolean;
  roleChanged?: boolean;
}
/** Metadata synchronization, not a classified member join/leave notice. */
export interface GroupMemberUpdate { groupId: string; source: 'local' | 'remote'; members: GroupMemberChange[] }
/** Detail metadata synchronization; no inferred join/leave or operator. */
export interface GroupInfoUpdate {
  groupId: string;
  name: string;
  memberCount: number;
  maxMemberCount: number;
  ownerUid: string;
  ownerUserId: string;
  description: string;
}
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
export type MessageElement = SendableMessageElement
  | ReceivedForwardElement
  | { type: 'unknown'; nativeType: number; data: unknown };
export type MessageInput = string | SendableMessageElement[];
export interface SentMessage { messageId: string; sequence: string; time: number }
/** Text-only merged record; time is an explicit Unix timestamp in seconds. */
export interface ForwardTextNode { userId: string; nickname: string; time: number; text: string }
export interface MergedForwardOptions { title?: string; summary?: string; prompt?: string }
export interface SentMergedForward extends SentMessage { resourceId: string }
export interface Message extends SentMessage {
  peer: Peer;
  sender: { userId: string; uid: string; nickname: string };
  elements: MessageElement[];
  raw: unknown;
}
/** Passive recall metadata. The native timestamp string's unit and operator are unverified. */
export interface MessageRecall {
  peer: Peer;
  messageId: string;
  sequence: string;
  recallTime: string;
}
export interface HistoryOptions { before?: string; limit?: number }
export interface KickOptions { rejectRejoin?: boolean; reason?: string }
export interface UserProfile { userId: string; uid: string; nickname: string; remark: string; raw: unknown }
export interface DeleteFriendOptions { block?: boolean; both?: boolean }
export interface FriendRequest {
  uid: string; time: string; nickname: string; message: string;
  decided: boolean; unread: boolean; initiator: boolean; raw: unknown;
}
export interface GroupRequest {
  groupId: string;
  sequence: string;
  type: 1 | 5 | 7;
  kind: 'invite' | 'invite-approval' | 'join';
  doubt: boolean;
  status: number;
  message: string;
  raw: unknown;
}
export interface GroupRequestOptions { doubt?: boolean; limit?: number; before?: string }
export interface GroupRequestPage { requests: GroupRequest[]; next: string }
export interface OfflineInfo {
  source: 'login' | 'msf' | 'kicked';
  kind: 'unknown' | 'transport' | 'logout' | 'forced';
  retryable: boolean;
  args: unknown[];
  status?: number;
  reason?: number;
  code?: number | string;
  description?: string;
  kickedInfo?: unknown;
}

export interface GroupNoticeOptions { imagePath?: string; pinned?: boolean; confirmRequired?: boolean }

export type { WebGroupNotice as GroupNotice, WebGroupNoticeResult as GroupNoticePage } from './web-group-notices.ts';

/** Native shutUpTime is preserved; its unit/expiry interpretation is not established. */
export interface GroupMutedMember { uid:string; userId:string; nickname:string; card:string; role:'unspecified'|'stranger'|'member'|'admin'|'owner'; shutUpTime:number }
