/** System-message metadata; unknown codes stay unknown and operator may be absent. */
export interface GroupMembershipEvent {
  groupId: string;
  direction: 'increase' | 'decrease';
  code: number;
  kind: 'invite' | 'leave' | 'kick' | 'kick-me' | 'disband' | 'unknown';
  memberUid?: string;
  operatorUid?: string;
}

export interface GroupAdminEvent {
  groupId: string;
  memberUid: string;
  enabled: boolean;
}

/** Content discriminator values are preserved without assigning unverified meanings. */
export interface GroupEssenceContent {
  type: number;
  text?: string;
  imageUrl?: string;
}

export interface GroupEssenceMessage {
  groupId: string;
  /** Sequence/random are not kernel messageId values. */
  sequence: number;
  random: number;
  senderId: string;
  senderNickname: string;
  sentAt: number;
  operatorId: string;
  operatorNickname: string;
  setAt: number;
  content: GroupEssenceContent[];
  removable: boolean;
}

export interface GroupEssencePageOptions {
  /** Passed unchanged as page_start; a next cursor is not inferred. */
  pageStart?: number;
  /** Defaults to 50; accepted range is 1..50. */
  pageLimit?: number;
}

export interface GroupEssencePage {
  groupId: string;
  pageStart: number;
  pageLimit: number;
  messages: GroupEssenceMessage[];
  /** Server flag for this page; the API does not claim an atomic full snapshot. */
  isEnd: boolean;
  groupRole: number;
}

export interface GroupMuteEvent {
  groupId: string;
  scope: 'member' | 'all';
  durationSeconds: string;
  enabled: boolean;
  memberUid?: string;
  operatorUid: string;
}

export interface Group {
  groupId: string;
  name: string;
  memberCount: number;
  maxMemberCount: number;
}

export interface GroupMember {
  userId: string;
  uid: string;
  nickname: string;
  card: string;
  role: 'owner' | 'admin' | 'member';
}

/** Native metadata notification; optional fields remain absent when not supplied. */
export interface GroupChange {
  groupId: string;
  name?: string;
  memberCount?: number;
  maxMemberCount?: number;
}

export interface GroupListUpdate {
  kind: 'refresh' | 'all' | 'modified' | 'removed';
  groups: GroupChange[];
}

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
export interface GroupMemberUpdate {
  groupId: string;
  source: 'local' | 'remote';
  members: GroupMemberChange[];
}

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

export interface KickOptions {
  rejectRejoin?: boolean;
  reason?: string;
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

export interface GroupRequestOptions {
  doubt?: boolean;
  limit?: number;
  before?: string;
}

export interface GroupRequestPage {
  requests: GroupRequest[];
  next: string;
}

export interface GroupNoticeOptions {
  imagePath?: string;
  pinned?: boolean;
  confirmRequired?: boolean;
}

/** A projected group notice; web tickets remain inside the worker. */
export interface WebGroupNotice {
  noticeId: string;
  senderId: string;
  publishTime: number;
  text: string;
  images: { id: string; width: string; height: string }[];
  settings?: unknown;
  readCount?: number;
  raw: Record<string, unknown>;
}

/** The native web query's returned page, without a complete-pagination guarantee. */
export interface WebGroupNoticeResult {
  notices: WebGroupNotice[];
  raw: Record<string, unknown>;
}

export type GroupNotice = WebGroupNotice;

export type GroupNoticePage = WebGroupNoticeResult;

/** Native shutUpTime is preserved; its unit/expiry interpretation is not established. */
export interface GroupMutedMember {
  uid: string;
  userId: string;
  nickname: string;
  card: string;
  role: 'unspecified' | 'stranger' | 'member' | 'admin' | 'owner';
  shutUpTime: number;
}
