export interface QQVersion {
  clientVersion: string;
  appId: string;
  qua: string;
}
export type LoginRequest = { method: 'qr' } | { method: 'quick'; uin: string } | { method: 'restore'; uin?: string };
export interface NativeManifest {
  schemaVersion: 1;
  id: string;
  platform: NodeJS.Platform;
  arch: string;
  wrapper: string;
  version: QQVersion;
  files: Array<{ path: string; url: string; sha256: string; encoding?: 'gzip'; downloadSha256?: string }>;
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
  kicked: [OfflineInfo];
  offline: [OfflineInfo];
  'msf-status': [{ status: number; reason: number; args: unknown[] }];
  'msf-error': [{ code?: number | string; description?: string; args: unknown[] }];
  'reconnect-error': [Error];
  'request.friend': [FriendRequest];
  'request.group': [GroupRequest];
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
export interface Group { groupId: string; name: string; memberCount: number; maxMemberCount: number }
export interface GroupMember { userId: string; uid: string; nickname: string; card: string; role: 'owner' | 'admin' | 'member' }
export type Peer = { type: 'private'; userId: string } | { type: 'group'; groupId: string };
export type SendableMessageElement =
  | { type: 'text'; text: string }
  | { type: 'at'; userId: string; text?: string }
  | { type: 'image'; file: string }
  | { type: 'video'; file: string; elementId?: string }
  | { type: 'record'; file: string; elementId?: string }
  | { type: 'reply'; messageId: string }
  | { type: 'file'; file: string; name?: string; size?: string; elementId?: string };
export type MessageElement = SendableMessageElement
  | { type: 'face'; id: number }
  | { type: 'unknown'; nativeType: number; data: unknown };
export type MessageInput = string | SendableMessageElement[];
export interface SentMessage { messageId: string; sequence: string; time: number }
export interface Message extends SentMessage {
  peer: Peer;
  sender: { userId: string; uid: string; nickname: string };
  elements: MessageElement[];
  raw: unknown;
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
