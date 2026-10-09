import { deserializeKernelError, KernelRequestError } from './errors.ts';
import {captureMergedForward} from './merged-forward.ts';
import {normalizeForwardResourceId} from './forward-resource-wire.ts';
import { normalizeMessageQuery, normalizeMessageBatchQuery, normalizeHistoryQuery } from './message-query.ts';
export { KernelRequestError, MergedForwardError } from './errors.ts';
export type {MergedForwardFailure, MergedForwardProgress} from './errors.ts';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { prepareNative } from './native-package.ts';
import { normalizeLoginRequest } from './login-request.ts';
import type { Account, ClientOptions, ClientEvents, LoginRequest, ClientState, Friend, Group, GroupMember, MessageInput, SentMessage, SentMergedForward, ForwardTextNode, MergedForwardOptions, ForwardResource, Message, Peer, HistoryOptions, KickOptions, UserProfile, DeleteFriendOptions, FriendRequest, NativeCallbackAudit } from './types.ts';
export type * from './types.ts';
export type { VideoCodec, VideoInfo } from './video-codec-loader.ts';
import type { GroupNoticeOptions, GroupNoticePage } from './types.ts';
import type { GroupRequest, GroupRequestOptions, GroupRequestPage } from './types.ts';

/** A parent-side failure after IPC submission cannot identify the native phase. */
function requestFailure(method:string,error:Error):Error {
  if(method!=='sendMergedForward'||(error instanceof KernelRequestError&&error.mergedForward))return error;
  return new KernelRequestError(method,error.message,undefined,error.name,{phase:'operation',uploadCompletion:'unknown',cardCompletion:'unknown'});
}

export class QQClient extends EventEmitter<ClientEvents> {
  readonly nativeExports: string[] = [];
  #worker: ChildProcess;
  #next = 0;
  #closed = false;
  #closing = false;
  #closePromise?: Promise<void>;
  #retiringWorker = false;
  #callbackAudit = new Map<string, NativeCallbackAudit>();
  #state: ClientState = 'idle';
  #account?: Account;
  #pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #timeout: number;
  #login?: Promise<Account>;
  #loginRequest?: LoginRequest;
  #defaultLogin: LoginRequest;
  #generation = 0;
  #lastAccount?: Account;
  #reconnecting?: Promise<Account>;
  #reconnectRequest?: LoginRequest;
  #restart?: { spawn(): ChildProcess; payload: object };
  #auto?: { maxAttempts: number; delayMs: number };
  #autoTimer?: NodeJS.Timeout;
  #autoAttempts = 0;
  constructor(worker: ChildProcess, timeout: number, defaultLogin: LoginRequest = { method: 'qr' }, restart?: { spawn(): ChildProcess; payload: object }, autoReconnect?: ClientOptions['autoReconnect']) {
    super(); this.#worker = worker; this.#timeout = timeout; this.#defaultLogin = normalizeLoginRequest(defaultLogin);
    this.#restart = restart;
    if (autoReconnect) this.#auto = { maxAttempts: typeof autoReconnect === 'object' ? autoReconnect.maxAttempts ?? 3 : 3, delayMs: typeof autoReconnect === 'object' ? autoReconnect.delayMs ?? 1000 : 1000 };
    this.#attach(worker);
  }
  #attach(worker: ChildProcess) {
    const generation = ++this.#generation;
    worker.on('message', (message: any) => {
      if (generation !== this.#generation || this.#closed) return;
      if (message.event) {
        if (this.#closing) return;
        if (message.event === 'native-callback') {
          const { family, name, argumentTypes } = message.payload ?? {};
          if (typeof family === 'string' && typeof name === 'string' && Array.isArray(argumentTypes) && argumentTypes.every(value => typeof value === 'string')) {
            const key = JSON.stringify([family, name, argumentTypes]);
            const existing = this.#callbackAudit.get(key);
            if (existing) existing.count++;
            else if (this.#callbackAudit.size < 128) this.#callbackAudit.set(key, { family, name, argumentTypes: [...argumentTypes], count: 1 });
          }
        }
        if (message.event === 'ready') {
          this.#account = { ...message.payload }; this.#lastAccount = { ...message.payload };
          this.#autoAttempts = 0; clearTimeout(this.#autoTimer); this.#autoTimer = undefined;
          this.#setState('online');
        }
        if (message.event === 'disconnected' || message.event === 'logout' || message.event === 'kicked') {
          this.#login = undefined; this.#account = undefined; this.#setState('disconnected');
          for (const [id, pending] of this.#pending) {
            if (pending.method === 'close') continue;
            clearTimeout(pending.timer); this.#pending.delete(id);
            pending.reject(requestFailure(pending.method,new Error(`QQ account became offline (${message.event}); request was not replayed`)));
          }
          if (message.event === 'disconnected' && message.payload?.retryable !== true) { clearTimeout(this.#autoTimer); this.#autoTimer = undefined; }
          if (message.event !== 'disconnected') { clearTimeout(this.#autoTimer); this.#autoTimer = undefined; this.#lastAccount = undefined; }
        }
        if (message.event === 'login-error') message.payload = new Error(message.payload?.message ?? 'Native login failed');
        if (message.event === 'qrcode' && typeof message.payload?.image === 'string') message.payload.image = Buffer.from(message.payload.image, 'base64');
        this.emit(message.event, message.payload);
        if (message.event === 'disconnected' && message.payload?.retryable === true) this.#scheduleReconnect();
        if (message.event === 'message') this.emit(message.payload?.peer?.type === 'group' ? 'message.group' : 'message.private', message.payload);
      } else {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.#pending.delete(message.id);
        if (message.error) pending.reject(deserializeKernelError(pending.method,message.error)); else pending.resolve(message.result);
      }
    });
    const fail = (error: Error) => {
      if (generation !== this.#generation || this.#closed) return;
      clearTimeout(this.#autoTimer); this.#autoTimer = undefined;
      this.#closed = true;
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(requestFailure(pending.method,error)); }
      this.#pending.clear(); this.#account = undefined;
      this.#setState(this.#closing ? 'closed' : 'failed');
      if (!this.#closing) this.emit('terminated', error);
      // A worker crash has no proven network-only reason. Preserve the failure;
      // automatic login cannot safely infer that a restore should be attempted.
    };
    worker.on('error', fail);
    worker.on('exit', (code, signal) => fail(new Error(`Native worker exited (code=${code}, signal=${signal})`)));
    worker.stderr?.on('data', data => { if (generation === this.#generation) this.emit('log', { stream: 'stderr', text: data.toString() }); });
    worker.stdout?.on('data', data => { if (generation === this.#generation) this.emit('log', { stream: 'stdout', text: data.toString() }); });
  }
  get state(): ClientState { return this.#state; }
  get account(): Readonly<Account> | undefined { return this.#account && { ...this.#account }; }
  /** Bounded shape-only audit includes callbacks received before createClient() returns. */
  get nativeCallbackAudit(): NativeCallbackAudit[] { return [...this.#callbackAudit.values()].map(value => ({ ...value, argumentTypes: [...value.argumentTypes] })); }
  #setState(state: ClientState) {
    if (this.#state === state) return;
    this.#state = state; this.emit('state', state);
  }
  #scheduleReconnect() {
    if (!this.#auto || !this.#restart || !this.#lastAccount || this.#closing || this.#autoTimer || this.#reconnecting || this.#autoAttempts >= this.#auto.maxAttempts) return;
    this.#autoTimer = setTimeout(() => {
      this.#autoTimer = undefined; this.#autoAttempts++;
      void this.reconnect().catch(error => {
        this.emit('reconnect-error', error);
        // Login/initialization failures do not establish a transport-only cause.
        // Require explicit evidence before another automatic restore attempt.
        if (error?.retryable === true) this.#scheduleReconnect();
      });
    }, this.#auto.delayMs);
  }
  async request(method: string, payload: object = {}, timeoutMs = this.#timeout): Promise<any> {
    if (this.#closed || (this.#closing && method !== 'close') || !this.#worker.connected) throw new Error('QQ client is closed');
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.#pending.delete(id);
        const error=new Error(`Kernel ${method} timed out`);
        if(method==='login') {
          // A timed-out authorization must not later make this generation online.
          this.#closed=true;this.#account=undefined;this.#setState('failed');
          for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(requestFailure(pending.method,error));}
          this.#pending.clear();
          try {await this.#stopWorker();}
          catch(cleanupError){reject(new AggregateError([error,cleanupError],'QQ login timeout and worker cleanup failed'));return;}
        }
        reject(requestFailure(method,error));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      const sendFailed=(error:Error)=>{clearTimeout(timer);this.#pending.delete(id);reject(requestFailure(method,error));};
      try {
        this.#worker.send({ id, method, ...payload }, error => {if(error) sendFailed(error);});
      } catch(error) {sendFailed(error instanceof Error?error:new Error(String(error)));}
    });
  }
  login(request: LoginRequest = this.#defaultLogin): Promise<Account> {
    if (this.#closing || this.#closed) return Promise.reject(new Error('QQ client is closed'));
    try { request = normalizeLoginRequest(request); }
    catch (error) { return Promise.reject(error); }
    if (this.#account) {
      if ('uin' in request && request.uin !== undefined && request.uin !== this.#account.uin) return Promise.reject(new Error('A different account is online; use reconnect() to change accounts'));
      return Promise.resolve({ ...this.#account });
    }
    if (this.#login && this.#loginRequest && (request.method !== this.#loginRequest.method || ('uin' in request ? request.uin : undefined) !== ('uin' in this.#loginRequest ? this.#loginRequest.uin : undefined))) {
      return Promise.reject(new Error('A different login request is already in progress'));
    }
    if (!this.#login) {
      this.#loginRequest = { ...request };
      this.#setState('connecting');
      const loginPromise = this.request('login', { login: request }).catch(error => {
        if (this.#login === loginPromise) {
          this.#login = undefined;
          if (!this.#closed && !this.#closing && this.#state === 'connecting') this.#setState('idle');
        }
        throw error;
      });
      this.#login = loginPromise;
    }
    return this.#login;
  }
  waitForLogin(): Promise<Account> {
    if (this.#closing || this.#closed) return Promise.reject(new Error('QQ client is closed'));
    // A completed login Promise exposes its mutable result to its caller.
    // Return the current stored identity, while still joining a pending login.
    if (this.#account) return Promise.resolve({ ...this.#account });
    return this.#login ?? this.login();
  }
  /** Restart the isolated native process and restore authorization. Requests are never replayed. */
  reconnect(login: LoginRequest = { method: 'restore', ...(this.#lastAccount ? { uin: this.#lastAccount.uin } : {}) }): Promise<Account> {
    if (this.#closing || this.#state === 'closed') return Promise.reject(new Error('QQ client is closed'));
    try { login = normalizeLoginRequest(login); }
    catch (error) { return Promise.reject(error); }
    if (!this.#restart) return Promise.reject(new Error('Worker restart is unavailable for this client'));
    if (this.#reconnecting) {
      if (login.method !== this.#reconnectRequest?.method || ('uin' in login ? login.uin : undefined) !== (this.#reconnectRequest && 'uin' in this.#reconnectRequest ? this.#reconnectRequest.uin : undefined)) {
        return Promise.reject(new Error('A different reconnect request is already in progress'));
      }
      return this.#reconnecting;
    }
    clearTimeout(this.#autoTimer); this.#autoTimer = undefined;
    this.#reconnectRequest = login;
    this.#reconnecting = Promise.resolve().then(() => this.#restartAndLogin(login)).catch(error => {
      if (!this.#closing) { this.#closed = true; this.#setState('failed'); }
      throw error;
    }).finally(() => { this.#reconnecting = undefined; this.#reconnectRequest = undefined; });
    this.#setState('connecting');
    return this.#reconnecting;
  }
  async #restartAndLogin(login: LoginRequest): Promise<Account> {
    if (this.#closing || this.#state === 'closed') throw new Error('QQ client is closed');
    this.#setState('connecting'); this.#account = undefined; this.#login = undefined;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(requestFailure(pending.method,new Error('QQ client reconnecting; request was not replayed'))); }
    this.#pending.clear();
    const previous = this.#worker;
    ++this.#generation;
    this.#retiringWorker = true;
    try {
      if (previous.exitCode == null && previous.signalCode == null) {
        await new Promise<void>((resolve, reject) => {
          const exit = () => { clearTimeout(force); clearTimeout(deadline); resolve(); };
          previous.once('exit', exit);
          const force = setTimeout(() => previous.kill('SIGKILL'), 2000);
          const deadline = setTimeout(() => { previous.removeListener('exit', exit); clearTimeout(force); reject(new Error('Previous native worker did not exit')); }, 4000);
          previous.kill();
        });
      }
    } finally { this.#retiringWorker = false; }
    if (this.#closing) throw new Error('QQ client closed during reconnect');
    this.#closed = false;
    this.#worker = this.#restart!.spawn(); this.#attach(this.#worker);
    try {
      const result = await this.request('init', this.#restart!.payload);
      this.nativeExports.splice(0, this.nativeExports.length, ...result.exports);
      return await this.login(login);
    } catch (error) {
      if (!this.#closing) { this.#closed = true; this.#setState('failed'); }
      try { await this.#stopWorker(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'QQ reconnect and worker cleanup failed'); }
      throw error;
    }
  }
  #operation<T>(method: string, payload: object = {}): Promise<T> {
    if (this.#state !== 'online') return Promise.reject(new Error('QQ client is not online; await login() first'));
    return this.request(method, payload);
  }
  listFriends(): Promise<Friend[]> { return this.#operation('listFriends'); }
  listGroups(): Promise<Group[]> { return this.#operation('listGroups'); }
  getGroupMembers(groupId: string): Promise<GroupMember[]> { return this.#operation('getGroupMembers', { groupId }); }
  sendPrivateMessage(userId: string, message: MessageInput): Promise<SentMessage> { return this.#operation('sendPrivateMessage', { userId, message }); }
  sendGroupMessage(groupId: string, message: MessageInput): Promise<SentMessage> { return this.#operation('sendGroupMessage', { groupId, message }); }
  async getHistory(peer: Peer, options: HistoryOptions = {}): Promise<Message[]> {
    const query = normalizeHistoryQuery(peer, options);
    return this.#operation('getHistory', { peer: query.peer, options: { before: query.before, limit: query.count, reverse: query.reverse } });
  }
  async getMessage(peer: Peer, messageId: string): Promise<Message | undefined> { return this.#operation('getMessage', normalizeMessageQuery(peer, messageId)); }
  /** Same order as unique requested IDs; absent successful-response items are undefined. */
  async getMessages(peer: Peer, messageIds: readonly string[]): Promise<(Message | undefined)[]> { return this.#operation('getMessages', normalizeMessageBatchQuery(peer, messageIds)); }
  /** First-level cards use their message ID for both root and parent. Nested reads keep the outer peer/root explicit. */
  async getForwardMessages(peer: Peer, rootMessageId: string, parentMessageId: string = rootMessageId): Promise<Message[]> {
    const root=normalizeMessageQuery(peer,rootMessageId),parent=normalizeMessageQuery(root.peer,parentMessageId);
    return this.#operation('getForwardMessages', { peer:root.peer, rootMessageId:root.messageId, parentMessageId:parent.messageId });
  }
  /** Fetch one resource; no synthetic message identities or implicit media/nested fetches. */
  async getForwardResource(resourceId: string): Promise<ForwardResource> {
    return this.#operation('getForwardResource', { resourceId:normalizeForwardResourceId(resourceId) });
  }
  /** Native submission only; this does not confirm destination receipt. */
  forwardMessages(source: Peer, destination: Peer, messageIds: string[]): Promise<void> { return this.#operation('forwardMessages', { source, destination, messageIds }); }
  /** Text-only composition; upload and card dispatch are never automatically retried. */
  async sendMergedForward(peer: Peer, nodes: readonly ForwardTextNode[], options: MergedForwardOptions = {}): Promise<SentMergedForward> {
    return this.#operation('sendMergedForward', captureMergedForward(peer,nodes,options));
  }
  recallMessage(peer: Peer, messageId: string): Promise<void> { return this.#operation('recallMessage', { peer, messageId }); }
  downloadAttachment(peer: Peer, messageId: string, elementId: string, destination: string): Promise<{ file: string }> { return this.#operation('downloadAttachment', { peer, messageId, elementId, destination }); }
  getUserProfile(userId: string): Promise<UserProfile> { return this.#operation('getUserProfile', { userId }); }
  setFriendRemark(userId: string, remark: string): Promise<void> { return this.#operation('setFriendRemark', { userId, remark }); }
  deleteFriend(userId: string, options: DeleteFriendOptions = {}): Promise<void> { return this.#operation('deleteFriend', { userId, options }); }
  listFriendRequests(): Promise<FriendRequest[]> { return this.#operation('listFriendRequests'); }
  handleFriendRequest(request: Pick<FriendRequest, 'uid' | 'time'>, accept: boolean): Promise<void> { return this.#operation('handleFriendRequest', { request, accept }); }
  listGroupRequests(options: GroupRequestOptions = {}): Promise<GroupRequestPage> { return this.#operation('listGroupRequests', { options }); }
  handleGroupRequest(request: Pick<GroupRequest, 'groupId' | 'sequence' | 'type' | 'doubt'>, accept: boolean, reason?: string): Promise<void> { return this.#operation('handleGroupRequest', { request, accept, reason }); }
  setGroupName(groupId: string, name: string): Promise<void> { return this.#operation('setGroupName', { groupId, name }); }
  setGroupMute(groupId: string, enabled: boolean): Promise<void> { return this.#operation('setGroupMute', { groupId, enabled }); }
  setGroupMemberMute(groupId: string, userId: string, seconds: number): Promise<void> { return this.#operation('setGroupMemberMute', { groupId, userId, seconds }); }
  /** Native submission only; completion does not confirm the remote group state. */
  setGroupMemberCard(groupId: string, userId: string, card: string): Promise<void> { return this.#operation('setGroupMemberCard', { groupId, userId, card }); }
  /** Native submission only; completion does not confirm the remote group state. */
  setGroupAdmin(groupId: string, userId: string, enabled: boolean): Promise<void> { return this.#operation('setGroupAdmin', { groupId, userId, enabled }); }
  /** Native submission only; completion does not confirm the remote group state. */
  kickGroupMember(groupId: string, userId: string, options: KickOptions = {}): Promise<void> { return this.#operation('kickGroupMember', { groupId, userId, options }); }
  setNickname(name: string): Promise<void> { return this.#operation('setNickname', { name }); }
  async setSignature(text: string): Promise<void> {
    if (typeof text !== 'string') throw new TypeError('signature text must be a string');
    await this.#operation('setSignature', { text });
  }
  listGroupNotices(groupId: string): Promise<GroupNoticePage> { return this.#operation('listGroupNotices', { groupId }); }
  publishGroupNotice(groupId: string, text: string, options?: GroupNoticeOptions): Promise<void> { return this.#operation('publishGroupNotice', { groupId, text, options }); }
  deleteGroupNotice(groupId: string, noticeId: string): Promise<void> { return this.#operation('deleteGroupNotice', { groupId, noticeId }); }
  /** Native submission only; completion does not confirm the remote group state. */
  leaveGroup(groupId: string): Promise<void> { return this.#operation('leaveGroup', { groupId }); }
  close(): Promise<void> {
    return this.#closePromise ??= this.#finishClose();
  }
  async #stopWorker(): Promise<void> {
    const worker = this.#worker;
    if (worker.exitCode != null || worker.signalCode != null) return;
    await new Promise<void>((resolve, reject) => {
      const exited = () => { clearTimeout(force); clearTimeout(deadline); resolve(); };
      worker.once('exit', exited);
      const force = setTimeout(() => worker.kill('SIGKILL'), 2000);
      const deadline = setTimeout(() => { worker.removeListener('exit', exited); clearTimeout(force); reject(new Error('Native worker did not exit after shutdown')); }, 4000);
      worker.kill();
    });
  }
  async #finishClose(): Promise<void> {
    clearTimeout(this.#autoTimer); this.#autoTimer = undefined;
    if (this.#closing) return;
    if (this.#retiringWorker) {
      this.#closing = true; this.#closed = true; this.#account = undefined; this.#setState('closing');
      try { await this.#stopWorker(); this.#setState('closed'); }
      catch (error) { this.#setState('failed'); throw error; }
      return;
    }
    if (this.#closed) { this.#closing = true; await this.#stopWorker(); this.#setState('closed'); return; }
    this.#closing = true; this.#setState('closing');
    try { await this.request('close', {}, 2000); } finally {
      this.#closed = true; this.#account = undefined;
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(requestFailure(pending.method,new Error('QQ client closed'))); }
      this.#pending.clear();
      try { await this.#stopWorker(); this.#setState('closed'); }
      catch (error) { this.#setState('failed'); throw error; }
    }
  }
}

export async function createClient(options: ClientOptions): Promise<QQClient> {
  if (!options.dataDir) throw new Error('dataDir is required');
  options = { ...options, login: options.login === undefined ? undefined : normalizeLoginRequest(options.login) };
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647)) throw new Error('timeoutMs must be an integer between 1 and 2147483647 milliseconds');
  if (typeof options.autoReconnect === 'object') {
    const { maxAttempts = 3, delayMs = 1000 } = options.autoReconnect;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error('Invalid autoReconnect policy');
  }
  const native = await prepareNative(options);
  const adjacentBridge = join(dirname(native.wrapperPath), 'registration-bridge.node');
  const bridgePath = options.bridgePath ?? (['darwin', 'linux'].includes(process.platform)
    ? (existsSync(adjacentBridge) ? adjacentBridge : fileURLToPath(new URL(`../native/${process.platform}-${process.arch}/registration-bridge.node`, import.meta.url))) : undefined);
  const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const spawnWorker = () => fork(fileURLToPath(workerUrl), [], { cwd: dataDir, env, execPath: process.execPath, execArgv: [], serialization: 'advanced' as const, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const worker = spawnWorker();
  const payload = { options: { ...options, ...native, videoCodecPath: options.videoCodecPath ?? (options.mediaTools === undefined ? native.videoCodecPath : undefined), bridgePath, dataDir } };
  const client = new QQClient(worker, options.timeoutMs ?? 120_000, options.login, { spawn: spawnWorker, payload }, options.autoReconnect);
  try {
    const result = await client.request('init', payload);
    client.nativeExports.push(...result.exports);
    if (options.login) setImmediate(() => { void client.login(options.login).catch(error => client.emit('loginError', error)); });
    return client;
  } catch (error) {
    try { await client.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'QQ initialization and worker cleanup failed'); }
    throw error;
  }
}
