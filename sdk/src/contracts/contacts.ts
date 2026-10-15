export interface Friend {
  userId: string;
  uid: string;
  nickname: string;
  remark: string;
}

/** Explicit private gray-tip notice; userId is present only when native peerUin supplies it. */
export interface FriendAdded {
  uid: string;
  messageId: string;
  userId?: string;
}

export interface FriendCategory {
  categoryId: number;
  sortId: number;
  name: string;
  memberCount: number;
  onlineCount: number;
  friends: Friend[];
}

/** Native creation receipt; membership and refreshed list contents are not included. */
export interface CreatedFriendCategory {
  categoryId: number;
  name: string;
}

/** Explicit category snapshot in the requested order; native sorting also carries each name. */
export type FriendCategoryOrderEntry = Pick<FriendCategory, 'categoryId' | 'name'>;

/** Projected Buddy metadata; optional remarks remain absent when not supplied. */
export interface FriendChange {
  userId: string;
  uid: string;
  nickname: string;
  remark?: string;
}

export interface FriendCategoryChange {
  categoryId: number;
  name: string;
  memberCount: number;
  friends: FriendChange[];
}

/** Native categorized metadata, without a completeness marker or inferred add/remove cause. */
export interface FriendListUpdate {
  categories: FriendCategoryChange[];
}

export interface UserProfile {
  userId: string;
  uid: string;
  nickname: string;
  remark: string;
  raw: unknown;
}

export interface DeleteFriendOptions {
  block?: boolean;
  both?: boolean;
}

export interface FriendRequest {
  uid: string;
  time: string;
  nickname: string;
  message: string;
  decided: boolean;
  unread: boolean;
  initiator: boolean;
  raw: unknown;
}

/** Live request capability bound to the receiving account session. */
export interface FriendRequestEvent extends FriendRequest {
  /** Submit an explicit decision (accept by default). Submission does not prove
   * remote friendship; retired sessions reject and failed actions are not replayed.
   */
  readonly approve: (accept?: boolean) => Promise<void>;
}
