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

export interface GroupEssenceListOptions {
  /** Defaults to 20; accepted range is 1..1000. No end marker within this budget rejects the read. */
  maxPages?: number;
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

/** A matched native search snapshot; ownerUid is not a numeric account ID. */
export interface GroupSearchMatch extends Group {
  ownerUid: string;
  /** Native fingerMemo, distinct from groupMemo. */
  description: string;
}

/** Native folder snapshot returned by creation; no listing or remote readback is implied. */
export interface GroupFolder {
  groupId: string;
  folderId: string;
  parentFolderId: string;
  name: string;
}

/** Native folder metadata. Time units and numeric selector meanings are unverified. */
export interface GroupFileFolder {
  folderId: string;
  parentFolderId: string;
  folderName: string;
  createTime: number;
  modifyTime: number;
  createUin: string;
  creatorName: string;
  totalFileCount: number;
  modifyUin: string;
  modifyName: string;
  usedSpace: string;
}

/** File metadata preserves uint64 fields as decimal strings and absent paths as null. */
export interface GroupFile {
  fileModelId: string;
  fileId: string;
  fileName: string;
  fileSize: string;
  busId: number;
  uploadedSize: string;
  uploadTime: number;
  deadTime: number;
  modifyTime: number;
  downloadTimes: number;
  sha: string;
  sha3: string;
  md5: string;
  uploaderLocalPath: string | null;
  uploaderName: string;
  uploaderUin: string;
  parentFolderId: string | null;
  localPath: string;
  transStatus: number;
  transType: number;
  elementId: string;
  isFolder: boolean;
}

/** Carriers are independent; their presence does not classify the opaque native type. */
export interface GroupFileEntry {
  groupId: string;
  type: number;
  folderInfo: GroupFileFolder | null;
  fileInfo: GroupFile | null;
}

export interface GroupFilePageOptions {
  /** Omit for the root folder. */
  folderId?: string;
  /** Opaque int32 selector; defaults to 1. */
  sortType?: number;
  /** SDK request budget: 1..1000; defaults to 50. */
  fileCount?: number;
  /** uint32 cursor; defaults to 0. */
  startIndex?: number;
  /** Opaque uint32 selector; defaults to 2. */
  sortOrder?: number;
  /** Opaque uint32 selector; defaults to 0. */
  showOnlinedocFolder?: number;
}

/** First validated callback for one correlated request; this is not an atomic snapshot. */
export interface GroupFilePage {
  groupId: string;
  folderId?: string;
  startIndex: number;
  fileCount: number;
  items: GroupFileEntry[];
  isEnd: boolean;
  nextIndex: number;
  /** Native allFileCount, not a promise that it equals items.length. */
  allFileCount: number;
}

export interface GroupFileListOptions extends Omit<GroupFilePageOptions, 'startIndex'> {
  /** Starts at zero. No end marker within 1..1000 pages rejects; default is 20. */
  maxPages?: number;
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

/** Live request capability bound to the receiving account session. */
export interface GroupRequestEvent extends GroupRequest {
  /** Submit one decision (accept by default), preserving the native operation's
   * acknowledgement semantics. A timeout does not prove the request was unchanged.
   */
  readonly approve: (accept?: boolean, reason?: string) => Promise<void>;
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
