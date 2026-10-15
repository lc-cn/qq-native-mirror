import type {
  CreatedFriendCategory,
  DeleteFriendOptions,
  Friend,
  FriendCategory,
  FriendCategoryOrderEntry,
  FriendRequest,
  UserProfile,
} from '../contracts/contacts.ts';
import type {
  Group,
  GroupEssenceListOptions,
  GroupEssenceMessage,
  GroupEssencePage,
  GroupEssencePageOptions,
  GroupFileEntry,
  GroupFileListOptions,
  GroupFilePage,
  GroupFilePageOptions,
  GroupFolder,
  GroupInfoUpdate,
  GroupMember,
  GroupMemberQueryOptions,
  GroupMutedMember,
  GroupNoticeOptions,
  GroupNoticePage,
  GroupRequest,
  GroupRequestOptions,
  GroupRequestPage,
  GroupSearchMatch,
  KickOptions,
} from '../contracts/groups.ts';
import type {
  ForwardResource,
  ForwardTextNode,
  MergedForwardOptions,
  SentMergedForward,
} from '../contracts/forward.ts';
import type { Message, MessageInput, Peer, SentMessage } from '../contracts/messages.ts';
import type { ServiceOperation } from './operations.ts';

/** Internal parent-to-worker commands. These types constrain SDK dispatch;
 * received IPC remains untrusted and domain owners retain runtime validation.
 * They describe SDK payloads/results, never a proprietary native ABI.
 */
interface Operation<Payload extends object | undefined, Result> {
  payload: Payload;
  result: Result;
}

// The facade has already captured these defaults before IPC. Folder identity
// remains optional; type contracts must not permit accidentally dropping cursors
// or request budgets from a prepared request.
type CapturedFilePageOptions = Required<Omit<GroupFilePageOptions, 'folderId'>> &
  Pick<GroupFilePageOptions, 'folderId'>;
type CapturedFileListOptions = Required<Omit<GroupFileListOptions, 'folderId'>> &
  Pick<GroupFileListOptions, 'folderId'>;

/** One contract for every business operation, grouped by domain. Public DTOs
 * remain declared by their domains; neither this owner nor the worker imports
 * the public client implementation to infer its command vocabulary.
 */
export interface ServiceOperationContracts {
  // Contacts and self profile.
  addFriendCategory: Operation<{ name: string }, CreatedFriendCategory>;
  renameFriendCategory: Operation<{ categoryId: number; name: string }, void>;
  deleteFriendCategory: Operation<{ categoryId: number }, void>;
  reorderFriendCategories: Operation<{ categories: readonly FriendCategoryOrderEntry[] }, void>;
  setFriendCategory: Operation<{ userId: string; categoryId: number }, void>;
  listFriends: Operation<undefined, Friend[]>;
  listFriendCategories: Operation<undefined, FriendCategory[]>;
  getUserProfile: Operation<{ userId: string }, UserProfile>;
  setFriendRemark: Operation<{ userId: string; remark: string }, void>;
  deleteFriend: Operation<{ userId: string; options: Required<DeleteFriendOptions> }, void>;
  listFriendRequests: Operation<undefined, FriendRequest[]>;
  handleFriendRequest: Operation<
    { request: Pick<FriendRequest, 'uid' | 'time'>; accept: boolean },
    void
  >;
  setNickname: Operation<{ name: string }, void>;
  setSignature: Operation<{ text: string }, void>;

  // Groups, membership, files and notices.
  listGroups: Operation<undefined, Group[]>;
  getGroupInfo: Operation<{ groupId: string }, GroupInfoUpdate>;
  listGroupMutedMembers: Operation<{ groupId: string }, GroupMutedMember[]>;
  getGroupMembers: Operation<{ groupId: string } & GroupMemberQueryOptions, GroupMember[]>;
  getGroupMember: Operation<
    { groupId: string; userId: string } & GroupMemberQueryOptions,
    GroupMember | undefined
  >;
  searchGroup: Operation<{ groupId: string }, GroupSearchMatch | undefined>;
  getGroupFileCount: Operation<{ groupId: string }, number>;
  getGroupFilePage: Operation<{ groupId: string; options: CapturedFilePageOptions }, GroupFilePage>;
  listGroupFiles: Operation<
    { groupId: string; options: CapturedFileListOptions },
    GroupFileEntry[]
  >;
  createGroupFolder: Operation<{ groupId: string; name: string }, GroupFolder>;
  deleteGroupFolder: Operation<{ groupId: string; folderId: string }, void>;
  deleteGroupFile: Operation<{ groupId: string; fileId: string }, void>;
  setGroupAvatar: Operation<{ groupId: string; file: string }, void>;
  setGroupName: Operation<{ groupId: string; name: string }, void>;
  setGroupRemark: Operation<{ groupId: string; remark: string }, void>;
  setGroupMute: Operation<{ groupId: string; enabled: boolean }, void>;
  setGroupMemberMute: Operation<{ groupId: string; userId: string; seconds: number }, void>;
  setGroupMemberCard: Operation<{ groupId: string; userId: string; card: string }, void>;
  setGroupAdmin: Operation<{ groupId: string; userId: string; enabled: boolean }, void>;
  kickGroupMember: Operation<
    { groupId: string; userId: string; options: Required<KickOptions> },
    void
  >;
  leaveGroup: Operation<{ groupId: string }, void>;
  listGroupRequests: Operation<
    {
      options: Required<Omit<GroupRequestOptions, 'before'>> & Pick<GroupRequestOptions, 'before'>;
    },
    GroupRequestPage
  >;
  handleGroupRequest: Operation<
    {
      request: Pick<GroupRequest, 'groupId' | 'sequence' | 'type' | 'doubt'>;
      accept: boolean;
      reason?: string;
    },
    void
  >;
  setGroupEssenceMessage: Operation<{ groupId: string; messageId: string; enabled: boolean }, void>;
  getGroupEssencePage: Operation<
    { groupId: string; options: Required<GroupEssencePageOptions> },
    GroupEssencePage
  >;
  listGroupEssenceMessages: Operation<
    { groupId: string; options: Required<GroupEssenceListOptions> },
    GroupEssenceMessage[]
  >;
  listGroupNotices: Operation<{ groupId: string }, GroupNoticePage>;
  publishGroupNotice: Operation<
    { groupId: string; text: string; options?: GroupNoticeOptions },
    void
  >;
  deleteGroupNotice: Operation<{ groupId: string; noticeId: string }, void>;

  // Messages and attachment reads.
  sendPrivateMessage: Operation<{ userId: string; message: MessageInput }, SentMessage>;
  sendGroupMessage: Operation<{ groupId: string; message: MessageInput }, SentMessage>;
  getMessage: Operation<{ peer: Peer; messageId: string }, Message | undefined>;
  getMessages: Operation<{ peer: Peer; messageIds: string[] }, (Message | undefined)[]>;
  getHistory: Operation<
    { peer: Peer; options: { before: string; limit: number; reverse: boolean } },
    Message[]
  >;
  recallMessage: Operation<{ peer: Peer; messageId: string }, void>;
  downloadAttachment: Operation<
    { peer: Peer; messageId: string; elementId: string; destination: string },
    { file: string }
  >;

  // Forwarded messages and independent resources.
  getForwardMessages: Operation<
    { peer: Peer; rootMessageId: string; parentMessageId: string },
    Message[]
  >;
  getForwardResource: Operation<{ resourceId: string }, ForwardResource>;
  forwardMessages: Operation<{ source: Peer; destination: Peer; messageIds: string[] }, void>;
  sendMergedForward: Operation<
    { peer: Peer; nodes: readonly ForwardTextNode[]; options: MergedForwardOptions },
    SentMergedForward
  >;
}

export type OperationResult<K extends ServiceOperation> = ServiceOperationContracts[K]['result'];

/** Required payloads cannot be omitted; payload-free commands accept no object. */
export type OperationArguments<K extends ServiceOperation> =
  ServiceOperationContracts[K]['payload'] extends undefined
    ? []
    : [payload: ServiceOperationContracts[K]['payload']];

/** A discriminated tuple retains method/payload correlation for union callers
 * as well as literals; callers cannot widen the method to accept another payload.
 */
export type OperationCall = {
  [K in keyof ServiceOperationContracts]: [method: K, ...args: OperationArguments<K>];
}[ServiceOperation];
