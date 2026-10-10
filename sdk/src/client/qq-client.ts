import { captureGroupSearch } from '../features/groups/group-search-input.ts';
import {
  captureCreateGroupFolder,
  captureDeleteGroupFolder,
  captureGroupFileCount,
} from '../features/groups/group-file-input.ts';
import { ClientLifecycle } from '../runtime/client-lifecycle.ts';
import type { ServiceOperation } from '../runtime/operations.ts';
import { friendCategoryName } from '../features/contacts/friend-categories.ts';
import { captureMergedForward } from '../features/forward/merged-forward-input.ts';
import { normalizeForwardResourceId } from '../features/forward/forward-resource-wire.ts';
import { sendGroupId } from '../features/messages/send-input.ts';
import {
  captureGroupEssenceRequest,
  captureGroupEssencePage,
  captureGroupEssenceList,
} from '../features/groups/group-essence-input.ts';
import { captureDownloadRequest } from '../features/media/download-input.ts';
import {
  normalizeMessageQuery,
  normalizeMessageBatchQuery,
  normalizeHistoryQuery,
} from '../features/messages/query-input.ts';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Account, ClientOptions, LoginRequest, ClientState } from '../contracts/client.ts';
import type { ClientEvents } from '../contracts/events.ts';
import type {
  Friend,
  FriendCategory,
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
  GroupMember,
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

export class QQClient extends EventEmitter<ClientEvents> {
  readonly nativeExports: string[] = [];
  readonly #lifecycle: ClientLifecycle;
  readonly #callbackAudit = new Map<string, NativeCallbackAudit>();
  constructor(
    worker: ChildProcess,
    timeout: number,
    defaultLogin: LoginRequest = { method: 'qr' },
    restart?: { spawn(): ChildProcess; payload: object },
    autoReconnect?: ClientOptions['autoReconnect'],
  ) {
    super();
    this.#lifecycle = new ClientLifecycle({
      worker,
      timeout,
      defaultLogin,
      restart,
      autoReconnect,
      emit: (event, payload) => this.#emitLifecycleEvent(event, payload),
      exportsUpdated: (exports) =>
        this.nativeExports.splice(0, this.nativeExports.length, ...exports),
    });
  }
  get state(): ClientState {
    return this.#lifecycle.state;
  }
  get account(): Readonly<Account> | undefined {
    return this.#lifecycle.account;
  }
  /** Present native callback payloads without giving the facade lifecycle ownership. */
  #emitLifecycleEvent(event: string, value: unknown): void {
    let payload = value as (Record<string, unknown> & { peer?: { type?: unknown } }) | undefined;
    if (event === 'native-callback') {
      const { family, name, argumentTypes } = payload ?? {};
      if (
        typeof family === 'string' &&
        typeof name === 'string' &&
        Array.isArray(argumentTypes) &&
        argumentTypes.every((value) => typeof value === 'string')
      ) {
        const key = JSON.stringify([family, name, argumentTypes]);
        const existing = this.#callbackAudit.get(key);
        if (existing) existing.count++;
        else if (this.#callbackAudit.size < 128)
          this.#callbackAudit.set(key, {
            family,
            name,
            argumentTypes: [...argumentTypes],
            count: 1,
          });
      }
    }
    if (event === 'login-error')
      payload = new Error(
        typeof payload?.message === 'string' ? payload.message : 'Native login failed',
      ) as unknown as Record<string, unknown>;
    if (event === 'qrcode' && payload && typeof payload.image === 'string')
      payload.image = Buffer.from(payload.image, 'base64');
    Reflect.apply(this.emit, this, [event, payload]);
    if (event === 'message')
      Reflect.apply(this.emit, this, [
        payload?.peer?.type === 'group' ? 'message.group' : 'message.private',
        payload,
      ]);
  }
  /** Bounded shape-only audit includes callbacks received before createClient() returns. */
  get nativeCallbackAudit(): NativeCallbackAudit[] {
    return [...this.#callbackAudit.values()].map((value) => ({
      ...value,
      argumentTypes: [...value.argumentTypes],
    }));
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
  #operation<T>(method: ServiceOperation, payload: object = {}): Promise<T> {
    if (this.state !== 'online')
      return Promise.reject(new Error('QQ client is not online; await login() first'));
    return this.request<T>(method, payload);
  }
  async addFriendCategory(name: string): Promise<CreatedFriendCategory> {
    return this.#operation('addFriendCategory', { name: friendCategoryName(name) });
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
  async getGroupMembers(groupId: string): Promise<GroupMember[]> {
    return this.#operation('getGroupMembers', { groupId: sendGroupId(groupId) });
  }
  sendPrivateMessage(userId: string, message: MessageInput): Promise<SentMessage> {
    return this.#operation('sendPrivateMessage', { userId, message });
  }
  sendGroupMessage(groupId: string, message: MessageInput): Promise<SentMessage> {
    return this.#operation('sendGroupMessage', { groupId, message });
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
  forwardMessages(source: Peer, destination: Peer, messageIds: string[]): Promise<void> {
    return this.#operation('forwardMessages', { source, destination, messageIds });
  }
  /** Text-only composition; upload and card dispatch are never automatically retried. */
  async sendMergedForward(
    peer: Peer,
    nodes: readonly ForwardTextNode[],
    options: MergedForwardOptions = {},
  ): Promise<SentMergedForward> {
    return this.#operation('sendMergedForward', captureMergedForward(peer, nodes, options));
  }
  recallMessage(peer: Peer, messageId: string): Promise<void> {
    return this.#operation('recallMessage', { peer, messageId });
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
  getUserProfile(userId: string): Promise<UserProfile> {
    return this.#operation('getUserProfile', { userId });
  }
  setFriendRemark(userId: string, remark: string): Promise<void> {
    return this.#operation('setFriendRemark', { userId, remark });
  }
  deleteFriend(userId: string, options: DeleteFriendOptions = {}): Promise<void> {
    return this.#operation('deleteFriend', { userId, options });
  }
  listFriendRequests(): Promise<FriendRequest[]> {
    return this.#operation('listFriendRequests');
  }
  handleFriendRequest(
    request: Pick<FriendRequest, 'uid' | 'time'>,
    accept: boolean,
  ): Promise<void> {
    return this.#operation('handleFriendRequest', { request, accept });
  }
  listGroupRequests(options: GroupRequestOptions = {}): Promise<GroupRequestPage> {
    return this.#operation('listGroupRequests', { options });
  }
  handleGroupRequest(
    request: Pick<GroupRequest, 'groupId' | 'sequence' | 'type' | 'doubt'>,
    accept: boolean,
    reason?: string,
  ): Promise<void> {
    return this.#operation('handleGroupRequest', { request, accept, reason });
  }
  async searchGroup(groupId: string): Promise<GroupSearchMatch | undefined> {
    return this.#operation('searchGroup', { groupId: captureGroupSearch(groupId) });
  }
  async getGroupFileCount(groupId: string): Promise<number> {
    return this.#operation('getGroupFileCount', captureGroupFileCount(groupId));
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
    if (typeof remark !== 'string') throw new Error('remark must be a string');
    return this.#operation('setGroupRemark', { groupId: capturedGroupId, remark });
  }
  setGroupName(groupId: string, name: string): Promise<void> {
    return this.#operation('setGroupName', { groupId, name });
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
  setGroupMute(groupId: string, enabled: boolean): Promise<void> {
    return this.#operation('setGroupMute', { groupId, enabled });
  }
  setGroupMemberMute(groupId: string, userId: string, seconds: number): Promise<void> {
    return this.#operation('setGroupMemberMute', { groupId, userId, seconds });
  }
  /** Native submission only; completion does not confirm the remote group state. */
  setGroupMemberCard(groupId: string, userId: string, card: string): Promise<void> {
    return this.#operation('setGroupMemberCard', { groupId, userId, card });
  }
  /** Native submission only; completion does not confirm the remote group state. */
  setGroupAdmin(groupId: string, userId: string, enabled: boolean): Promise<void> {
    return this.#operation('setGroupAdmin', { groupId, userId, enabled });
  }
  /** Native submission only; completion does not confirm the remote group state. */
  kickGroupMember(groupId: string, userId: string, options: KickOptions = {}): Promise<void> {
    return this.#operation('kickGroupMember', { groupId, userId, options });
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
  listGroupNotices(groupId: string): Promise<GroupNoticePage> {
    return this.#operation('listGroupNotices', { groupId });
  }
  publishGroupNotice(groupId: string, text: string, options?: GroupNoticeOptions): Promise<void> {
    return this.#operation('publishGroupNotice', { groupId, text, options });
  }
  deleteGroupNotice(groupId: string, noticeId: string): Promise<void> {
    return this.#operation('deleteGroupNotice', { groupId, noticeId });
  }
  /** Native submission only; completion does not confirm the remote group state. */
  leaveGroup(groupId: string): Promise<void> {
    return this.#operation('leaveGroup', { groupId });
  }
  close(): Promise<void> {
    return this.#lifecycle.close();
  }
}
