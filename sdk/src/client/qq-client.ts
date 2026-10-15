import { captureSetGroupAvatar } from '../features/groups/group-avatar-input.ts';
import {
  captureGroupMemberList,
  captureGroupMemberQuery,
} from '../features/groups/group-member-query-input.ts';
import { createClientEventPresentation } from './client-event-presentation.ts';
import { createMessageEvent } from './message-event.ts';
import { createFriendRequestEvent, createGroupRequestEvent } from './request-event.ts';
import type { ContactContext } from './contacts/contact-context.ts';
import { FriendContact } from './contacts/friend-contact.ts';
import { GroupContact } from './contacts/group-contact.ts';
import { GroupMemberContact } from './contacts/group-member-contact.ts';
import { captureForwardSubmission } from '../features/forward/forward-input.ts';
import { captureFriendRequest } from '../features/contacts/friend-request-input.ts';
import { captureGroupRequestOperation } from '../features/groups/group-request-input.ts';
import { captureGroupSearch } from '../features/groups/group-search-input.ts';
import { captureGroupOperation } from '../features/groups/group-operation-input.ts';
import {
  captureGroupNoticeDeletion,
  captureGroupNoticeList,
  captureGroupNoticePublication,
} from '../features/groups/group-notice-input.ts';
import { captureContactOperation } from '../features/contacts/contact-operation-input.ts';
import {
  captureCreateGroupFolder,
  captureDeleteGroupFolder,
  captureDeleteGroupFile,
  captureGroupFileCount,
  captureGroupFilePage,
  captureGroupFileList,
} from '../features/groups/files/group-file-input.ts';
import { ClientLifecycle, captureWorkerExports } from '../runtime/client-lifecycle.ts';
import type { OperationCall, OperationResult } from '../runtime/operation-contracts.ts';
import {
  friendCategoryName,
  captureFriendCategoryAssignment,
  captureRenameFriendCategory,
  captureFriendCategoryId,
  captureFriendCategoryOrder,
} from '../features/contacts/friend-category-input.ts';
import { captureMergedForward } from '../features/forward/merged-forward-input.ts';
import { normalizeForwardResourceId } from '../features/forward/forward-resource-input.ts';
import {
  sendGroupId,
  capturePrivateMessage,
  captureGroupMessage,
} from '../features/messages/send-input.ts';
import {
  captureGroupEssenceRequest,
  captureGroupEssencePage,
  captureGroupEssenceList,
} from '../features/groups/group-essence-input.ts';
import { captureDownloadRequest } from '../features/media/download-input.ts';
import { captureRecallRequest } from '../features/messages/recall-input.ts';
import {
  normalizeMessageQuery,
  normalizeMessageBatchQuery,
  normalizeHistoryQuery,
} from '../features/messages/query-input.ts';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Account, ClientOptions, LoginRequest, ClientState } from '../contracts/client.ts';
import type { ClientEvents } from './events.ts';
import type {
  Friend,
  FriendCategory,
  FriendCategoryOrderEntry,
  CreatedFriendCategory,
  UserProfile,
  DeleteFriendOptions,
  FriendRequest,
} from '../contracts/contacts.ts';
import type {
  GroupEssencePage,
  GroupEssencePageOptions,
  GroupEssenceMessage,
  GroupEssenceListOptions,
  Group,
  GroupSearchMatch,
  GroupFolder,
  GroupFilePage,
  GroupFilePageOptions,
  GroupFileEntry,
  GroupFileListOptions,
  GroupMember,
  GroupMemberQueryOptions,
  GroupInfoUpdate,
  GroupMutedMember,
  KickOptions,
  GroupNoticeOptions,
  GroupNoticePage,
  GroupRequest,
  GroupRequestOptions,
  GroupRequestPage,
} from '../contracts/groups.ts';
import type {
  MessageInput,
  SentMessage,
  Message,
  Peer,
  HistoryOptions,
} from '../contracts/messages.ts';
import type {
  SentMergedForward,
  ForwardTextNode,
  MergedForwardOptions,
  ForwardResource,
} from '../contracts/forward.ts';
import type { NativeCallbackAudit } from '../contracts/native.ts';

// The creation root completes initialization once without a public lifecycle hook.
// Weak keys do not keep manually constructed or failed clients alive.
const initializationCompleters = new WeakMap<
  QQClient,
  (exports: string[], autoLogin: boolean) => void
>();

/** Internal creation seam; deliberately absent from the package entry. */
export function completeClientInitialization(
  client: QQClient,
  reply: unknown,
  autoLogin = false,
): void {
  const complete = initializationCompleters.get(client);
  if (!complete) throw new Error('QQ client initialization is unavailable');
  complete(captureWorkerExports(reply), autoLogin);
  initializationCompleters.delete(client);
}

export class QQClient extends EventEmitter<ClientEvents> {
  #nativeExports: string[] = [];
  readonly #lifecycle: ClientLifecycle;
  readonly #events: ReturnType<typeof createClientEventPresentation>;
  constructor(
    worker: ChildProcess,
    timeout: number,
    defaultLogin: LoginRequest = { method: 'qr' },
    restart?: { spawn(): ChildProcess; payload: object },
    autoReconnect?: ClientOptions['autoReconnect'],
  ) {
    super();
    const captureEventGuard = () =>
      this.#lifecycle?.captureOnlineOperationGuard() ??
      (() => {
        throw new Error('Event belongs to an inactive client session');
      });
    this.#events = createClientEventPresentation(
      (event, payload) => Reflect.apply(this.emit, this, [event, payload]),
      {
        message: (value) => createMessageEvent(value, this.#operationContext(captureEventGuard())),
        friendRequest: (value) =>
          createFriendRequestEvent(value, {
            assertActive: captureEventGuard(),
            handleFriendRequest: (request, accept) => this.handleFriendRequest(request, accept),
          }),
        groupRequest: (value) =>
          createGroupRequestEvent(value, {
            assertActive: captureEventGuard(),
            handleGroupRequest: (request, accept, reason) =>
              this.handleGroupRequest(request, accept, reason),
          }),
      },
    );
    this.#lifecycle = new ClientLifecycle({
      worker,
      timeout,
      defaultLogin,
      restart,
      autoReconnect,
      emit: (...event) => {
        switch (event[0]) {
          case 'state':
            this.emit('state', event[1]);
            break;
          case 'log':
            this.emit('log', event[1]);
            break;
          case 'terminated':
            this.emit('terminated', event[1]);
            break;
          default: {
            const exhaustive: never = event;
            return exhaustive;
          }
        }
      },
      forward: this.#events.forward,
      exportsUpdated: (exports) => this.#replaceNativeExports(exports),
    });
    initializationCompleters.set(this, (exports, autoLogin) => {
      this.#replaceNativeExports(exports);
      if (autoLogin) this.#lifecycle.scheduleDefaultLogin();
    });
  }
  #replaceNativeExports(exports: string[]): void {
    if (['closing', 'closed', 'failed'].includes(this.#lifecycle.state))
      throw new Error('QQ client closed or failed during export publication');
    this.#nativeExports = [...exports];
  }
  /** A detached view of the most recently initialized worker's export names. */
  get nativeExports(): string[] {
    return [...this.#nativeExports];
  }
  get state(): ClientState {
    return this.#lifecycle.state;
  }
  get account(): Readonly<Account> | undefined {
    return this.#lifecycle.account;
  }
  /** Bounded shape-only audit includes callbacks received before createClient() returns. */
  get nativeCallbackAudit(): NativeCallbackAudit[] {
    return this.#events.audit;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing public request return contract; RPC internals use unknown.
  request<T = any>(method: string, payload: object = {}, timeoutMs?: number): Promise<T> {
    return this.#lifecycle.request<T>(method, payload, timeoutMs);
  }
  login(request?: LoginRequest): Promise<Account> {
    return this.#lifecycle.login(request);
  }
  waitForLogin(): Promise<Account> {
    return this.#lifecycle.waitForLogin();
  }
  /** Restart the isolated native process and restore authorization. Requests are never replayed. */
  reconnect(login?: LoginRequest): Promise<Account> {
    return this.#lifecycle.reconnect(login);
  }
  #contactContext(): ContactContext {
    const assertActive = this.#lifecycle.captureOnlineOperationGuard();
    assertActive();
    return this.#operationContext(assertActive);
  }
  #operationContext(assertActive: () => void): ContactContext {
    return Object.freeze({
      assertActive,
      invoke: <C extends OperationCall>(...command: C): Promise<OperationResult<C[0]>> => {
        // Input capture may run caller code. Recheck the original session at dispatch.
        assertActive();
        return this.#operation<C>(...command);
      },
    });
  }
  /** Select a positive decimal QQ account locally. Requires an online session;
   * the returned object is retired by offline, reconnect or close.
   */
  pickFriend(userId: string): FriendContact {
    return new FriendContact(this.#contactContext(), userId);
  }
  /** Select a group locally, without asserting membership or fetching metadata. */
  pickGroup(groupId: string): GroupContact {
    return new GroupContact(this.#contactContext(), groupId);
  }
  /** Select one member identity in one group, without asserting membership. */
  pickMember(groupId: string, userId: string): GroupMemberContact {
    return new GroupMemberContact(this.#contactContext(), groupId, userId);
  }
  #operation<C extends OperationCall>(...command: C): Promise<OperationResult<C[0]>> {
    if (this.state !== 'online')
      return Promise.reject(new Error('QQ client is not online; await login() first'));
    const [method, payload] = command;
    return this.request<OperationResult<C[0]>>(method, payload ?? {});
  }
  async addFriendCategory(name: string): Promise<CreatedFriendCategory> {
    return this.#operation('addFriendCategory', { name: friendCategoryName(name) });
  }
  /** Native ACK only; timeout or shutdown after dispatch leaves the effect unknown. */
  async renameFriendCategory(categoryId: number, name: string): Promise<void> {
    return this.#operation('renameFriendCategory', captureRenameFriendCategory(categoryId, name));
  }
  /** Native ACK only; the remote category state requires independent verification. */
  async deleteFriendCategory(categoryId: number): Promise<void> {
    return this.#operation('deleteFriendCategory', {
      categoryId: captureFriendCategoryId(categoryId),
    });
  }
  /** Submit explicit names/order once. Native ACK does not certify the remote category state. */
  async reorderFriendCategories(categories: readonly FriendCategoryOrderEntry[]): Promise<void> {
    return this.#operation('reorderFriendCategories', {
      categories: captureFriendCategoryOrder(categories),
    });
  }
  /** Assign once. Native ACK does not certify remote state; a timeout leaves the effect unknown. */
  async setFriendCategory(userId: string, categoryId: number): Promise<void> {
    return this.#operation(
      'setFriendCategory',
      captureFriendCategoryAssignment(userId, categoryId),
    );
  }
  listFriendCategories(): Promise<FriendCategory[]> {
    return this.#operation('listFriendCategories');
  }
  listFriends(): Promise<Friend[]> {
    return this.#operation('listFriends');
  }
  listGroups(): Promise<Group[]> {
    return this.#operation('listGroups');
  }
  async listGroupMutedMembers(groupId: string): Promise<GroupMutedMember[]> {
    return this.#operation('listGroupMutedMembers', { groupId: sendGroupId(groupId) });
  }
  async getGroupInfo(groupId: string): Promise<GroupInfoUpdate> {
    return this.#operation('getGroupInfo', { groupId: sendGroupId(groupId) });
  }
  async getGroupMembers(
    groupId: string,
    options?: GroupMemberQueryOptions,
  ): Promise<GroupMember[]> {
    const context = this.#contactContext();
    let captured;
    try {
      captured = captureGroupMemberList(groupId, options);
    } finally {
      context.assertActive();
    }
    const members = await context.invoke('getGroupMembers', captured);
    context.assertActive();
    return members;
  }
  /** Read a complete member list and select one account. Only a successful full
   * query may return undefined; no membership or permission is inferred locally.
   */
  async getGroupMember(
    groupId: string,
    userId: string,
    options?: GroupMemberQueryOptions,
  ): Promise<GroupMember | undefined> {
    const context = this.#contactContext();
    let captured;
    try {
      captured = captureGroupMemberQuery(groupId, userId, options);
    } finally {
      context.assertActive();
    }
    const member = await context.invoke('getGroupMember', captured);
    context.assertActive();
    return member;
  }
  async sendPrivateMessage(userId: string, message: MessageInput): Promise<SentMessage> {
    return this.#operation('sendPrivateMessage', capturePrivateMessage(userId, message));
  }
  async sendGroupMessage(groupId: string, message: MessageInput): Promise<SentMessage> {
    return this.#operation('sendGroupMessage', captureGroupMessage(groupId, message));
  }
  async getHistory(peer: Peer, options: HistoryOptions = {}): Promise<Message[]> {
    const query = normalizeHistoryQuery(peer, options);
    return this.#operation('getHistory', {
      peer: query.peer,
      options: { before: query.before, limit: query.count, reverse: query.reverse },
    });
  }
  async getMessage(peer: Peer, messageId: string): Promise<Message | undefined> {
    return this.#operation('getMessage', normalizeMessageQuery(peer, messageId));
  }
  /** Same order as unique requested IDs; absent successful-response items are undefined. */
  async getMessages(peer: Peer, messageIds: readonly string[]): Promise<(Message | undefined)[]> {
    return this.#operation('getMessages', normalizeMessageBatchQuery(peer, messageIds));
  }
  /** First-level cards use their message ID for both root and parent. Nested reads keep the outer peer/root explicit. */
  async getForwardMessages(
    peer: Peer,
    rootMessageId: string,
    parentMessageId: string = rootMessageId,
  ): Promise<Message[]> {
    const root = normalizeMessageQuery(peer, rootMessageId),
      parent = normalizeMessageQuery(root.peer, parentMessageId);
    return this.#operation('getForwardMessages', {
      peer: root.peer,
      rootMessageId: root.messageId,
      parentMessageId: parent.messageId,
    });
  }
  /** Fetch one resource; no synthetic message identities or implicit media/nested fetches. */
  async getForwardResource(resourceId: string): Promise<ForwardResource> {
    return this.#operation('getForwardResource', {
      resourceId: normalizeForwardResourceId(resourceId),
    });
  }
  /** Native submission only; this does not confirm destination receipt. */
  async forwardMessages(source: Peer, destination: Peer, messageIds: string[]): Promise<void> {
    return this.#operation(
      'forwardMessages',
      captureForwardSubmission({ source, destination, messageIds }),
    );
  }
  /** Text-only composition; upload and card dispatch are never automatically retried. */
  async sendMergedForward(
    peer: Peer,
    nodes: readonly ForwardTextNode[],
    options: MergedForwardOptions = {},
  ): Promise<SentMergedForward> {
    return this.#operation('sendMergedForward', captureMergedForward(peer, nodes, options));
  }
  async recallMessage(peer: Peer, messageId: string): Promise<void> {
    return this.#operation('recallMessage', captureRecallRequest(peer, messageId));
  }
  async downloadAttachment(
    peer: Peer,
    messageId: string,
    elementId: string,
    destination: string,
  ): Promise<{ file: string }> {
    const captured = captureDownloadRequest(peer, messageId, elementId, destination);
    return this.#operation('downloadAttachment', captured);
  }
  async getUserProfile(userId: string): Promise<UserProfile> {
    return this.#operation(
      'getUserProfile',
      captureContactOperation('getUserProfile', { userId }).payload,
    );
  }
  async setFriendRemark(userId: string, remark: string): Promise<void> {
    return this.#operation(
      'setFriendRemark',
      captureContactOperation('setFriendRemark', { userId, remark }).payload,
    );
  }
  async deleteFriend(userId: string, options: DeleteFriendOptions = {}): Promise<void> {
    return this.#operation(
      'deleteFriend',
      captureContactOperation('deleteFriend', { userId, options }).payload,
    );
  }
  listFriendRequests(): Promise<FriendRequest[]> {
    return this.#operation('listFriendRequests');
  }
  async handleFriendRequest(
    request: Pick<FriendRequest, 'uid' | 'time'>,
    accept: boolean,
  ): Promise<void> {
    return this.#operation('handleFriendRequest', captureFriendRequest({ request, accept }));
  }
  async listGroupRequests(options: GroupRequestOptions = {}): Promise<GroupRequestPage> {
    return this.#operation(
      'listGroupRequests',
      captureGroupRequestOperation('listGroupRequests', { options }).payload,
    );
  }
  async handleGroupRequest(
    request: Pick<GroupRequest, 'groupId' | 'sequence' | 'type' | 'doubt'>,
    accept: boolean,
    reason?: string,
  ): Promise<void> {
    return this.#operation(
      'handleGroupRequest',
      captureGroupRequestOperation('handleGroupRequest', { request, accept, reason }).payload,
    );
  }
  async searchGroup(groupId: string): Promise<GroupSearchMatch | undefined> {
    return this.#operation('searchGroup', { groupId: captureGroupSearch(groupId) });
  }
  async getGroupFileCount(groupId: string): Promise<number> {
    return this.#operation('getGroupFileCount', captureGroupFileCount(groupId));
  }

  /** A native per-file acknowledgement; remote disappearance needs readback. */
  async deleteGroupFile(groupId: string, fileId: string): Promise<void> {
    return this.#operation('deleteGroupFile', captureDeleteGroupFile(groupId, fileId));
  }

  /** Read the first validated, correlated native page within a five-second deadline. */
  async getGroupFilePage(
    groupId: string,
    options: GroupFilePageOptions = {},
  ): Promise<GroupFilePage> {
    const captured = captureGroupFilePage(groupId, options);
    return this.#operation('getGroupFilePage', {
      groupId: captured.groupId,
      options: captured.params,
    });
  }

  /** Traverse a folder from zero to the native end marker; never return a partial list. */
  async listGroupFiles(
    groupId: string,
    options: GroupFileListOptions = {},
  ): Promise<GroupFileEntry[]> {
    const captured = captureGroupFileList(groupId, options);
    const { startIndex: _startIndex, ...params } = captured.params;
    return this.#operation('listGroupFiles', {
      groupId: captured.groupId,
      options: { ...params, maxPages: captured.maxPages },
    });
  }

  async createGroupFolder(groupId: string, name: string): Promise<GroupFolder> {
    return this.#operation('createGroupFolder', captureCreateGroupFolder(groupId, name));
  }

  async deleteGroupFolder(groupId: string, folderId: string): Promise<void> {
    const captured = captureDeleteGroupFolder(groupId, folderId);
    return this.#operation('deleteGroupFolder', captured);
  }

  async setGroupRemark(groupId: string, remark: string): Promise<void> {
    const capturedGroupId = sendGroupId(groupId);
    return this.#operation(
      'setGroupRemark',
      captureGroupOperation('setGroupRemark', { groupId: capturedGroupId, remark }).payload,
    );
  }
  /** Set an avatar from a stable absolute local file. A verified native profile is
   * required; acknowledgement does not confirm remote propagation. No retry.
   */
  async setGroupAvatar(groupId: string, file: string): Promise<void> {
    return this.#operation('setGroupAvatar', captureSetGroupAvatar(groupId, file));
  }
  async setGroupName(groupId: string, name: string): Promise<void> {
    return this.#operation(
      'setGroupName',
      captureGroupOperation('setGroupName', { groupId, name }).payload,
    );
  }
  /** Native acknowledgement requires both status layers to be zero.
   * This does not confirm remote state; the mutation is issued once, without retry.
   */
  async setGroupEssenceMessage(
    groupId: string,
    messageId: string,
    enabled: boolean,
  ): Promise<void> {
    const captured = captureGroupEssenceRequest(groupId, messageId, enabled);
    return this.#operation('setGroupEssenceMessage', captured);
  }
  async setGroupMute(groupId: string, enabled: boolean): Promise<void> {
    return this.#operation(
      'setGroupMute',
      captureGroupOperation('setGroupMute', { groupId, enabled }).payload,
    );
  }
  async setGroupMemberMute(groupId: string, userId: string, seconds: number): Promise<void> {
    return this.#operation(
      'setGroupMemberMute',
      captureGroupOperation('setGroupMemberMute', { groupId, userId, seconds }).payload,
    );
  }
  /** Native submission only; completion does not confirm the remote group state. */
  async setGroupMemberCard(groupId: string, userId: string, card: string): Promise<void> {
    return this.#operation(
      'setGroupMemberCard',
      captureGroupOperation('setGroupMemberCard', { groupId, userId, card }).payload,
    );
  }
  /** Native submission only; completion does not confirm the remote group state. */
  async setGroupAdmin(groupId: string, userId: string, enabled: boolean): Promise<void> {
    return this.#operation(
      'setGroupAdmin',
      captureGroupOperation('setGroupAdmin', { groupId, userId, enabled }).payload,
    );
  }
  /** Native submission only; completion does not confirm the remote group state. */
  async kickGroupMember(groupId: string, userId: string, options: KickOptions = {}): Promise<void> {
    return this.#operation(
      'kickGroupMember',
      captureGroupOperation('kickGroupMember', { groupId, userId, options }).payload,
    );
  }
  setNickname(name: string): Promise<void> {
    return this.#operation('setNickname', { name });
  }
  async setSignature(text: string): Promise<void> {
    if (typeof text !== 'string') throw new TypeError('signature text must be a string');
    await this.#operation('setSignature', { text });
  }
  /** Read one essence page through QQ HTTP with worker-owned native tickets. */
  async getGroupEssencePage(
    groupId: string,
    options: GroupEssencePageOptions = {},
  ): Promise<GroupEssencePage> {
    const query = captureGroupEssencePage(groupId, options);
    return this.#operation('getGroupEssencePage', {
      groupId: query.groupId,
      options: { pageStart: query.pageStart, pageLimit: query.pageLimit },
    });
  }
  /** Traverse essence pages until the server's end marker; never return a partial list. */
  async listGroupEssenceMessages(
    groupId: string,
    options: GroupEssenceListOptions = {},
  ): Promise<GroupEssenceMessage[]> {
    const query = captureGroupEssenceList(groupId, options);
    return this.#operation('listGroupEssenceMessages', {
      groupId: query.groupId,
      options: { maxPages: query.maxPages },
    });
  }
  async listGroupNotices(groupId: string): Promise<GroupNoticePage> {
    return this.#operation('listGroupNotices', captureGroupNoticeList(groupId));
  }
  async publishGroupNotice(
    groupId: string,
    text: string,
    options?: GroupNoticeOptions,
  ): Promise<void> {
    return this.#operation(
      'publishGroupNotice',
      captureGroupNoticePublication(groupId, text, options),
    );
  }
  async deleteGroupNotice(groupId: string, noticeId: string): Promise<void> {
    return this.#operation('deleteGroupNotice', captureGroupNoticeDeletion(groupId, noticeId));
  }
  /** Native submission only; completion does not confirm the remote group state. */
  async leaveGroup(groupId: string): Promise<void> {
    return this.#operation('leaveGroup', captureGroupOperation('leaveGroup', { groupId }).payload);
  }
  close(): Promise<void> {
    return this.#lifecycle.close();
  }
}
