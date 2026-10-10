import { ClientLifecycle } from './runtime/client-lifecycle.ts';
import type { ServiceOperation } from './runtime/operations.ts';
import { friendCategoryName } from './features/contacts/friend-categories.ts';
import { captureMergedForward } from './features/forward/merged-forward-input.ts';
import { normalizeForwardResourceId } from './features/forward/forward-resource-wire.ts';
import { sendGroupId } from './features/messages/send-input.ts';
import {
  captureGroupEssenceRequest,
  captureGroupEssencePage,
} from './features/groups/group-essence-input.ts';
import { captureDownloadRequest } from './features/media/download-input.ts';
import {
  normalizeMessageQuery,
  normalizeMessageBatchQuery,
  normalizeHistoryQuery,
} from './features/messages/query-input.ts';
export { KernelRequestError, MergedForwardError } from './errors.ts';
export type { MergedForwardFailure, MergedForwardProgress } from './errors.ts';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { prepareNative } from './native/native-package.ts';
import { normalizeLoginRequest } from './native/login-request.ts';
import type {
  Account,
  ClientOptions,
  ClientEvents,
  LoginRequest,
  ClientState,
  Friend,
  FriendCategory,
  CreatedFriendCategory,
  GroupEssencePage,
  GroupEssencePageOptions,
  Group,
  GroupMember,
  GroupInfoUpdate,
  GroupMutedMember,
  MessageInput,
  SentMessage,
  SentMergedForward,
  ForwardTextNode,
  MergedForwardOptions,
  ForwardResource,
  Message,
  Peer,
  HistoryOptions,
  KickOptions,
  UserProfile,
  DeleteFriendOptions,
  FriendRequest,
  NativeCallbackAudit,
} from './types.ts';
export type * from './types.ts';
export type { VideoCodec, VideoInfo } from './runtime/media-contracts.ts';
import type { GroupNoticeOptions, GroupNoticePage } from './types.ts';
import type { GroupRequest, GroupRequestOptions, GroupRequestPage } from './types.ts';

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

export async function createClient(options: ClientOptions): Promise<QQClient> {
  if (!options.dataDir) throw new Error('dataDir is required');
  options = {
    ...options,
    login: options.login === undefined ? undefined : normalizeLoginRequest(options.login),
  };
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_483_647)
  )
    throw new Error('timeoutMs must be an integer between 1 and 2147483647 milliseconds');
  if (typeof options.autoReconnect === 'object') {
    const { maxAttempts = 3, delayMs = 1000 } = options.autoReconnect;
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0
    )
      throw new Error('Invalid autoReconnect policy');
  }
  const native = await prepareNative(options);
  const adjacentBridge = join(dirname(native.wrapperPath), 'registration-bridge.node');
  const bridgePath =
    options.bridgePath ??
    (['darwin', 'linux'].includes(process.platform)
      ? existsSync(adjacentBridge)
        ? adjacentBridge
        : fileURLToPath(
            new URL(
              `../native/${process.platform}-${process.arch}/registration-bridge.node`,
              import.meta.url,
            ),
          )
      : undefined);
  const workerUrl = new URL(
    import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
    import.meta.url,
  );
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const spawnWorker = () =>
    fork(fileURLToPath(workerUrl), [], {
      cwd: dataDir,
      env,
      execPath: process.execPath,
      execArgv: [],
      serialization: 'advanced' as const,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  const worker = spawnWorker();
  const payload = {
    options: {
      ...options,
      ...native,
      videoCodecPath:
        options.videoCodecPath ??
        (options.mediaTools === undefined ? native.videoCodecPath : undefined),
      bridgePath,
      dataDir,
    },
  };
  const client = new QQClient(
    worker,
    options.timeoutMs ?? 120_000,
    options.login,
    { spawn: spawnWorker, payload },
    options.autoReconnect,
  );
  try {
    const result = await client.request<{ exports: string[] }>('init', payload);
    client.nativeExports.push(...result.exports);
    if (options.login)
      setImmediate(() => {
        void client.login(options.login).catch((error) => client.emit('loginError', error));
      });
    return client;
  } catch (error) {
    try {
      await client.close();
    } catch (cleanupError) {
      // eslint-disable-next-line preserve-caught-error -- AggregateError retains both original and cleanup errors.
      throw new AggregateError(
        [error, cleanupError],
        'QQ initialization and worker cleanup failed',
      );
    }
    throw error;
  }
}
