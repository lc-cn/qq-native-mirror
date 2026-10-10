import { captureFriendCategories, projectFriendCategories } from './friend-categories.ts';
import { nativeResultError } from './errors.ts';
import {captureMergedForward,sendCapturedMergedForward} from './merged-forward.ts';
import {createLongMessageResponseTransport} from './long-message-response.ts';
import {buildForwardResourceRequest,normalizeForwardResourceId} from './forward-resource-wire.ts';
import {createForwardResourceTransport} from './forward-resource-transport.ts';
import { normalizeMessageQuery, normalizeMessageBatchQuery, normalizeHistoryQuery, queryNativeMessage, queryNativeMessages, queryNativeHistory } from './message-query.ts';
import { createSelfProfile, type SelfProfileOperation } from './self-profile.ts';
import { listWebGroupNotices } from './web-group-notices.ts';
import { createGroupNotices, type GroupNoticeOperation } from './group-notices.ts';
import { createForwardMessages, type ForwardOperation } from './forward-messages.ts';
import { createGroupRequests, type GroupRequestOperation } from './group-requests.ts';
import type { VideoCodec } from './video-codec-loader.ts';
import { createVideoElement, type MediaTools } from './media-send.ts';
import { createRecordElement, type RecordCodec } from './media-record.ts';
import { createFriendRequests, type FriendRequestOperation } from './friend-requests.ts';
import { createContactOperations, type ContactOperation } from './contact-operations.ts';
import { downloadAttachment, captureDownloadPayload } from './media-operations.ts';
import { createImageElement, createFileElement, createReplyElement, decodeElements, faceElement } from './message-elements.ts';
/** Native contracts extracted from local NapCat; this module never sends at startup. */
import { createGroupOperations, type GroupOperation } from './group-operations.ts';
import { createGroupEvents } from './group-events.ts';
import { createRecallEvents } from './recall-events.ts';
import { needsMentionLookup } from './inbound-mentions.ts';
import { captureNativeMessage, decodeNativeMessages, messageIdentityUids, projectNativeMessage } from './inbound-messages.ts';
import { captureSendInput, sendUserId, sendGroupId, sentReceipt } from './send-input.ts';
import type { Friend, Group, GroupMember, Message, NativeCallbackAudit } from './types.ts';

type Native = Record<string, any>;
export interface NativePeer { chatType: 1 | 2; peerUid: string; guildId?: string }
export type ServiceOperation = 'listFriendCategories' | 'listFriends' | 'listGroups' | 'getGroupMembers' | 'sendPrivateMessage' | 'sendGroupMessage' | 'sendMergedForward' | 'getForwardResource' | 'getMessage' | 'getMessages' | 'getHistory' | 'recallMessage' | 'downloadAttachment' | SelfProfileOperation | 'listGroupNotices' | GroupNoticeOperation | GroupOperation | ContactOperation | FriendRequestOperation | GroupRequestOperation | ForwardOperation;
export interface NativeMessage extends Native { msgId: string; peerUid: string; chatType: number }
interface Waiter { event: string; check: (...args: any[]) => unknown; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

function toMessage(message: Native, raw: unknown = message): Message {
  return projectNativeMessage(message, decodeElements(message.elements), new Map(), raw);
}

export function createNativeServices(session: Native, version: string, emit: (event: string, payload: unknown) => void, mediaTools?: MediaTools, recordCodec?: RecordCodec, accountId?: string, accountUid?: string, auditCallback?: (info: Pick<NativeCallbackAudit,'family'|'name'|'argumentTypes'>) => void, videoCodec?: VideoCodec) {
  const lifetime=new AbortController();
  let closed = false;
  // Modules may retain services across awaits. Guard the actual method boundary,
  // so stale work cannot dispatch a new mutation after Session shutdown.
  const guardedSession = new Proxy(session, {
    get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        if (closed) throw new Error('Native services are closed');
        const value = Reflect.apply(member, target, args);
        if (typeof key !== 'string' || !/^get.+Service$/.test(key) || !value || typeof value !== 'object') return value;
        return new Proxy(value, { get(serviceTarget, serviceKey) {
          const method = Reflect.get(serviceTarget, serviceKey);
          if (typeof method !== 'function') return method;
          return (...serviceArgs: unknown[]) => {
            if (closed && !(typeof serviceKey === 'string' && /^removeKernel.+Listener$/.test(serviceKey))) throw new Error('Native services are closed');
            return Reflect.apply(method, serviceTarget, serviceArgs);
          };
        } });
      };
    },
  });
  const waiters = new Set<Waiter>();
  const listeners: Native[] = [];
  const uidCache = new Map<string, string>();
  const receivedMessages = new Set<string>();
  const usedSendIds = new Set<string>();
  const recallEvents = createRecallEvents(emit);
  let groupListRequest: Promise<unknown> | undefined;
  let groupListInvalidated = false;
  const call = (object: Native, name: string, ...args: any[]) => {
    if (closed) throw new Error('Native services are closed');
    if (!object || typeof object[name] !== 'function') throw new Error(`Native service is missing ${name}`);
    return object[name](...args);
  };
  const service = (name: string): Native => call(guardedSession, `get${name}Service`);
  const awaitAlive = async <T>(value: T | PromiseLike<T>): Promise<T> => {
    // The native call is evaluated before this helper. A synchronous callback can
    // close the Session while returning a Promise that may reject much later.
    const pending = Promise.resolve(value);
    if (lifetime.signal.aborted) {
      void pending.catch(() => {});
      lifetime.signal.throwIfAborted();
    }
    let abort: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Native services closed during operation'));
      lifetime.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([pending, stopped]);
      lifetime.signal.throwIfAborted();
      return result;
    } finally { lifetime.signal.removeEventListener('abort', abort!); }
  };
  const resolvedMessages = async (messages: Native[], rawMessages = messages, live = false): Promise<(Message | undefined)[]> => {
    return decodeNativeMessages(messages, rawMessages, async uids => {
      const value = await call(service('UixConvert'), 'getUin', uids);
      return value?.uinInfo;
    }, lifetime.signal, stage => { if (!closed) emit('diagnostic', { stage }); }, live);
  };
  const resolvedMessage = async (message: Native) => (await resolvedMessages([message]))[0];
  let receiveQueue: Promise<void> | undefined;
  const receiveKey = (message: Native): string | undefined => message.msgId && message.peerUid ? JSON.stringify([message.chatType, message.peerUid, message.msgId])
    : message.chatType === 1 && message.msgId && message.peerUin ? JSON.stringify([1, 'uin', message.peerUin, message.msgId]) : undefined;
  const captureReceived = (raw: Native) => {
    return { raw, message: captureNativeMessage(raw), key: receiveKey(raw) };
  };
  type Received = ReturnType<typeof captureReceived>;
  const unseenReceived = (messages: Received[]) => messages.filter(message => !message.key || !receivedMessages.has(message.key));
  const deliverReceived = (messages: Received[], decoded: (Message | undefined)[]) => {
    if (closed) return;
    messages.forEach((message, index) => {
      if (closed) return;
      const converted = decoded[index];
      if (!converted) return;
      const key = message.key;
      if (key && receivedMessages.has(key)) return;
      if (key) {
        receivedMessages.add(key);
        if (receivedMessages.size > 10_000) receivedMessages.delete(receivedMessages.values().next().value!);
      }
      emit('message', converted);
    });
    dispatch('Msg/onRecvMsg', [messages.map(message => message.raw)]);
  };
  const dispatch = (event: string, args: any[]) => {
    for (const waiter of [...waiters]) {
      if (waiter.event !== event) continue;
      try {
        const result = waiter.check(...args);
        if (result !== undefined) { waiters.delete(waiter); waiter.resolve(result); }
      } catch (error) { waiters.delete(waiter); waiter.reject(error as Error); }
    }
  };
  const listener = (family: string, overrides: Native) => {
    const wrapped = new Map<PropertyKey, (...args: any[]) => unknown>();
    const target = new Proxy(overrides, {
      get: (object, key) => {
        const member = object[key as string];
        if (member !== undefined && typeof member !== 'function') return member;
        if (!wrapped.has(key)) wrapped.set(key, (...args: any[]) => {
          if (closed) return;
          auditCallback?.({family,name:String(key),argumentTypes:args.map(value=>value===null?'null':Array.isArray(value)?'array':typeof value)});
          return typeof member === 'function' ? Reflect.apply(member,object,args) : dispatch(`${family}/${String(key)}`,args);
        });
        return wrapped.get(key);
      },
    });
    call(service(family), `addKernel${family}Listener`, target);
    listeners.push(target);
  };
  listener('Msg', {
    onRecvMsg: (messages: NativeMessage[]) => {
      if (closed) return;
      if (!Array.isArray(messages)) { emit('diagnostic', { stage: 'invalid-native-message-batch' }); return; }
      const validMessages: Received[] = [];
      for (const message of Array.from(messages)) {
        if (message && typeof message === 'object' && !Array.isArray(message) && message.chatType !== 1 && message.chatType !== 2) continue;
        try { validMessages.push(captureReceived(message)); }
        catch { emit('diagnostic', { stage: 'invalid-native-message' }); }
      }
      if (!receiveQueue && !validMessages.some(value => messageIdentityUids(value.message).length || needsMentionLookup(value.message.elements))) {
        const unseen = unseenReceived(validMessages);
        deliverReceived(unseen, unseen.map(value => toMessage(value.message, value.raw)));
        return;
      }
      // A UID lookup may settle after another callback. Preserve delivery order
      // across the entire callback batch and every subsequent queued batch.
      const queued = (receiveQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (closed) return;
        const unseen = unseenReceived(validMessages);
        deliverReceived(unseen, await resolvedMessages(unseen.map(value => value.message), unseen.map(value => value.raw), true));
      });
      receiveQueue = queued;
      void queued.catch(() => { if (!closed) emit('diagnostic', { stage: 'invalid-native-message' }); }).finally(() => { if (receiveQueue === queued) receiveQueue = undefined; });
    },
    onMsgInfoListUpdate: (messages: NativeMessage[]) => {
      if (closed) return;
      if (!Array.isArray(messages)) { emit('diagnostic', { stage: 'invalid-native-message-update-batch' }); return; }
      const validMessages = messages.filter(message => message && typeof message === 'object');
      if (validMessages.length !== messages.length) emit('diagnostic', { stage: 'invalid-native-message-update' });
      dispatch('Msg/onMsgInfoListUpdate', [validMessages]);
      for (const message of validMessages) {
        recallEvents.onMessageUpdate(message);
        if (message.recallTime && message.recallTime !== '0') emit('message-recalled', message);
      }
    },
    onKickedOffLine: (...args: unknown[]) => { if (!closed) emit('kicked', { info: args[0], args }); },
  });
  const groupEvents = createGroupEvents(emit);
  listener('Group', { onGroupListUpdate: (kind: unknown, groups: Native[]) => {
    if (process.env.QQ_NATIVE_TRACE_FIELDS === '1') emit('diagnostic', { stage: `group-list-update:kind-${typeof kind === 'number' || typeof kind === 'boolean' ? String(kind) : typeof kind}:count-${Array.isArray(groups) ? groups.length : 'non-array'}` });
    groupEvents.onGroupListUpdate(kind, groups);
    dispatch('Group/onGroupListUpdate', [kind, groups]);
  }, onMemberInfoChange: groupEvents.onMemberInfoChange, onGroupDetailInfoChange: groupEvents.onGroupDetailInfoChange });
  const eventCall = async (event: string, check: Waiter['check'], invoke: () => any, timeoutMs = 10_000, checkReturn?: (value: any) => boolean) => {
    lifetime.signal.throwIfAborted();
    let waiter: Waiter;
    let stop: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { stop = reject; });
    const abort = () => stop(new Error('Client closed during native operation'));
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const result = new Promise<any>((resolve, reject) => {
      waiter = { event, check, resolve, reject, timer: setTimeout(() => {
        waiters.delete(waiter);
        const error = new Error(`Native operation timed out: ${event}`);
        reject(error); stop(error);
      }, timeoutMs) };
      waiters.add(waiter);
    });
    void result.catch(() => {});
    try {
      // Callback success alone cannot bypass a native rejection. Only a waiter
      // failure (close/deadline/callback failure) may interrupt pending invoke.
      const failed = result.then(() => new Promise<never>(() => {}));
      // The executor captures synchronous throws while preserving immediate
      // dispatch for callback channels such as a coalesced group-list query.
      const returned = await Promise.race([new Promise<any>(resolve => resolve(invoke())), failed, stopped]);
      lifetime.signal.throwIfAborted();
      if (checkReturn && !checkReturn(returned)) throw nativeResultError(`Native operation rejected: ${event}`, returned);
      const value = await Promise.race([result, stopped]);
      lifetime.signal.throwIfAborted();
      return value;
    } catch (error) {
      waiter!.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      waiters.delete(waiter!); clearTimeout(waiter!.timer);
      lifetime.signal.removeEventListener('abort', abort);
    }
  };
  const uidFor = async (id: string): Promise<string> => {
    if (id.startsWith('u_')) return id;
    if (uidCache.has(id)) return uidCache.get(id)!;
    const converted = await awaitAlive(call(service('UixConvert'), 'getUid', [id]));
    const uid = converted?.uidInfo?.get(id);
    if (typeof uid !== 'string' || !uid || uid.includes('*')) throw new Error('Could not resolve user identifier');
    return uid;
  };
  const friendRequests = createFriendRequests(guardedSession, emit);
  const groupRequests = createGroupRequests(guardedSession, emit);
  const contactOperations = createContactOperations(guardedSession, uidFor);
  const selfProfile = createSelfProfile(guardedSession, () => accountUid ?? '');
  const groupNotices = createGroupNotices(guardedSession);
  const groupOperations = createGroupOperations(guardedSession, uidFor);
  const resolvePeer = async (peer: Native): Promise<NativePeer> => {
    if (peer?.chatType === 1 || peer?.chatType === 2) {
      if (typeof peer.peerUid !== 'string' || !peer.peerUid) throw new Error('Invalid peer UID');
      return { chatType: peer.chatType, peerUid: peer.peerUid };
    }
    if (peer?.type === 'group') return { chatType: 2, peerUid: String(peer.groupId ?? peer.id) };
    if (peer?.type === 'private') return { chatType: 1, peerUid: await uidFor(String(peer.userId ?? peer.id)) };
    throw new Error('Unsupported peer type');
  };
  const forwardMessages = createForwardMessages(guardedSession, resolvePeer, resolvedMessage, lifetime.signal, resolvedMessages);
  const elementsFor = async (input: unknown, peer: NativePeer): Promise<Native[]> => {
    const elements = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    if (!Array.isArray(elements) || !elements.length) throw new Error('Message must contain elements');
    return Promise.all(elements.map(async (element: Native) => {
      if (element.type === 'text') {
        if (typeof element.text !== 'string') throw new Error('Invalid text element');
        return { elementType: 1, elementId: '', textElement: { content: element.text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } };
      }
      if (element.type === 'at') {
        if (peer.chatType !== 2) throw new Error('Mentions require a group peer');
        const id = String(element.userId ?? element.id ?? '');
        if (!id) throw new Error('Mention requires userId');
        const all = id === 'all';
        return { elementType: 1, elementId: '', textElement: {
          content: `@${element.text ?? (all ? '全体成员' : id)}`, atType: all ? 1 : 2,
          atUid: id, atTinyId: '', atNtUid: all ? 'all' : await uidFor(id),
        } };
      }
      if (element.type === 'face') return faceElement(element.id);
      if (element.type === 'image') return createImageElement(element.file, service('Msg'));
      if (element.type === 'video') return createVideoElement(element.file, service('Msg'), mediaTools, videoCodec, lifetime.signal);
      if (element.type === 'record') return createRecordElement(element.file, service('Msg'), recordCodec);
      if (element.type === 'file') return createFileElement(element.file, element.name);
      if (element.type === 'reply') return createReplyElement(element.messageId, peer, service('Msg'));
      throw new Error(`Unsupported message element: ${String(element.type)}`);
    }));
  };
  let longMessageTransport: ReturnType<typeof createLongMessageResponseTransport> | undefined;
  let forwardResourceTransport: ReturnType<typeof createForwardResourceTransport> | undefined;
  const sendPreparedElements = async (peer: NativePeer, elements: Native[], onDispatch?: () => void) => {
    const messages = service('Msg');
    const uniqueId = await awaitAlive(call(messages, 'generateMsgUniqueId', peer.chatType, call(service('MSF'), 'getServerTime')));
    lifetime.signal.throwIfAborted();
    if (typeof uniqueId !== 'string' || !uniqueId.trim()) throw new Error('Invalid native send correlation identifier');
    if (usedSendIds.has(uniqueId)) throw new Error('Duplicate native send correlation identifier');
    usedSendIds.add(uniqueId);
    const destination = { ...peer, guildId: uniqueId };
    const sent = await eventCall('Msg/onMsgInfoListUpdate', (updates: NativeMessage[]) => {
      const matching = updates.filter(message => message.guildId === uniqueId
        && (message.chatType === undefined || message.chatType === peer.chatType)
        && (message.peerUid === undefined || message.peerUid === peer.peerUid));
      const message = matching.find(message => message.sendStatus === 2);
      if (message) return sentReceipt(message);
      if (matching.some(message => message.sendStatus === 0)) throw new Error('Native message send failed');
      return undefined;
    },
      () => { lifetime.signal.throwIfAborted(); onDispatch?.(); return call(messages, 'sendMsg', '0', destination, elements, new Map()); }, 10_000, value => value?.result === 0);
    lifetime.signal.throwIfAborted();
    return sent;
  };
  const send = async (peer: NativePeer, input: unknown) => sendPreparedElements(peer, await elementsFor(input, peer));
  return {
    async invokeOperation(method: ServiceOperation, payload: Native = {}): Promise<unknown> {
      if (closed) throw new Error('Native services are closed');
      switch (method) {
        case 'listFriendCategories': {
          if (!['7.0.2-53644', '3.2.32-52194', '9.9.33-52230'].includes(version)) throw new Error('Buddy list signature not verified for this native version');
          const raw = await awaitAlive(call(service('Buddy'), 'getBuddyListV2', '0', true, 0));
          const captured = captureFriendCategories(raw);
          const profiles = await awaitAlive(call(service('Profile'), 'getCoreAndBaseInfo', 'nodeStore', [...captured.uniqueUIDs]));
          const categories = projectFriendCategories(captured, profiles);
          lifetime.signal.throwIfAborted();
          for (const category of categories) for (const friend of category.friends) uidCache.set(friend.userId, friend.uid);
          return categories;
        }
        case 'listFriends': {
          // Windows 9.9.33 uses the same three-argument V2 contract in the pinned
          // upstream implementation; account-level Windows validation is pending.
          if (!['7.0.2-53644', '3.2.32-52194', '9.9.33-52230'].includes(version)) throw new Error('Buddy list signature not verified for this native version');
          const result = await awaitAlive(call(service('Buddy'), 'getBuddyListV2', '0', true, 0));
          // Pinned getBuddyListV2 returns GeneralCallResult as well as data.
          // An empty data array does not establish a successful query.
          if (result?.result !== 0) throw nativeResultError('Native buddy list query failed', result);
          if (!Array.isArray(result?.data)) throw new Error('Invalid native buddy list');
          // Materialize holes before validation; flatMap/some would skip them.
          const categories = Array.from(result.data);
          if (categories.some((category: any) => !Array.isArray(category?.buddyUids))) throw new Error('Invalid native buddy list');
          const requested = categories.flatMap((category: any) => Array.from(category.buddyUids));
          if (!requested.every((uid): uid is string => typeof uid === 'string' && uid.length > 0)) throw new Error('Invalid native buddy UID');
          const uids = [...new Set<string>(requested)];
          const profiles = await awaitAlive(call(service('Profile'), 'getCoreAndBaseInfo', 'nodeStore', uids));
          if (!(profiles instanceof Map)) throw new Error('Invalid native profile map');
          if (uids.some(uid => !profiles.has(uid))) throw new Error('Native buddy profiles are incomplete');
          const friends = uids.map((uid): Friend => {
            const profile = profiles.get(uid);
            const core = profile?.coreInfo;
            if (!core || typeof core !== 'object' || Array.isArray(core)
              || typeof core.uid !== 'string' || !core.uid.trim() || core.uid !== uid
              || typeof core.uin !== 'string' || !/^\d+$/.test(core.uin)
              || typeof core.remark !== 'string' || (core.nick !== undefined && typeof core.nick !== 'string')) throw new Error('Invalid native buddy profile');
            return { userId: core.uin, uid, nickname: core.nick ?? '', remark: core.remark };
          });
          // A rejected batch must not leave usable entries from an earlier row.
          lifetime.signal.throwIfAborted();
          for (const friend of friends) uidCache.set(friend.userId, friend.uid);
          return friends;
        }
        case 'listGroups': {
          if (groupListInvalidated) throw new Error('Group list query channel invalidated; create a new Session');
          if (groupListRequest) return groupListRequest;
          const request = eventCall('Group/onGroupListUpdate', (update: number, groups: Native[]) => {
          // Source: NapCatQQ packages/napcat-core/types/group.ts GroupListUpdateType.
          // REFRESHALL=0 and GETALL=1 are full lists; MODIFIED/REMOVE and new native
          // update kinds can carry partial or empty deltas. Never return those.
          if (update !== 0 && update !== 1) return undefined;
          if (!Array.isArray(groups)) throw new Error('Invalid native group list');
          return Array.from(groups, (group): Group => {
            if (!group || typeof group !== 'object' || Array.isArray(group)
              || typeof group.groupCode !== 'string' || !/^\d+$/.test(group.groupCode) || typeof group.groupName !== 'string'
              || !Number.isSafeInteger(group.memberCount) || group.memberCount < 0
              || !Number.isSafeInteger(group.maxMember) || group.maxMember < 0) throw new Error('Invalid native group list');
            return { groupId: group.groupCode, name: group.groupName, memberCount: group.memberCount, maxMemberCount: group.maxMember };
          });
        },
          () => call(service('Group'), 'getGroupList', payload.refresh ?? true),10_000,value=>value?.result===0);
          groupListRequest=request;
          try {return await request;}
          catch(error) {groupListInvalidated=true;throw error;}
          finally {if(groupListRequest===request)groupListRequest=undefined;}
        }
        case 'getGroupMembers': {
          const groupId = sendGroupId(payload.groupId);
          const refresh = payload.refresh ?? false;
          if (typeof refresh !== 'boolean') throw new Error('refresh must be a boolean');
          const result = await awaitAlive(call(service('Group'), 'getAllMemberList', groupId, refresh));
          // Pinned NodeIKernelGroupService.getAllMemberList reports errCode and
          // finish:true. A Map alone does not establish a successful full list.
          if (result?.errCode !== 0) throw nativeResultError('Native group member query failed', result, 'errCode');
          const infos = result?.result?.infos;
          if (!(infos instanceof Map)) throw new Error('Invalid native group member map');
          if (result.result.finish !== true) throw Object.assign(new Error('Native group member list is incomplete'), { code: 'incomplete-result' });
          const members = [...infos.entries()].map(([uid, member]): GroupMember => {
            // Pinned GroupMember identity and display fields are strings. Do not
            // invent an identity by coercing a number/object or substituting keys.
            if (typeof uid !== 'string' || !uid.trim() || !member || typeof member !== 'object' || Array.isArray(member)
              || member.uid !== uid || typeof member.uin !== 'string' || !/^\d+$/.test(member.uin)
              || typeof member.nick !== 'string' || typeof member.cardName !== 'string') throw new Error('Invalid native group member');
            if (typeof member.role !== 'number') throw new Error('Unknown native group member role');
            const role = ({ 4: 'owner', 3: 'admin', 2: 'member' } as const)[member.role as 2 | 3 | 4];
            if (!role) throw new Error('Unknown native group member role');
            return { userId: member.uin, uid, nickname: member.nick, card: member.cardName, role };
          });
          // Commit only a complete validated query; failures leave no partial cache.
          lifetime.signal.throwIfAborted();
          for (const member of members) uidCache.set(member.userId, member.uid);
          return members;
        }
        case 'sendPrivateMessage': {
          const userId = sendUserId(payload.userId);
          const input = captureSendInput(payload.message, false);
          return send({ chatType: 1, peerUid: await uidFor(userId) }, input);
        }
        case 'sendGroupMessage': {
          const groupId = sendGroupId(payload.groupId);
          const input = captureSendInput(payload.message, true);
          return send({ chatType: 2, peerUid: groupId }, input);
        }
        case 'sendMergedForward': {
          const captured=captureMergedForward(payload.peer,payload.nodes,payload.options);
          const destination=await resolvePeer(captured.peer);
          lifetime.signal.throwIfAborted();
          return sendCapturedMergedForward(captured,accountUid ?? '',
            () => longMessageTransport ??= createLongMessageResponseTransport(service('Msg') as any),
            (card,onDispatch) => sendPreparedElements(destination,[card],onDispatch),lifetime.signal);
        }
        case 'getForwardResource': {
          const resourceId=normalizeForwardResourceId(payload.resourceId),selfUid=accountUid ?? '';
          buildForwardResourceRequest(selfUid,resourceId); // Preflight before obtaining any native service.
          lifetime.signal.throwIfAborted();
          return (forwardResourceTransport ??= createForwardResourceTransport(service('Msg') as any)).read(selfUid,resourceId,{signal:lifetime.signal});
        }
        case 'getMessage': {
          const query = normalizeMessageQuery(payload.peer, payload.messageId);
          const raw = await awaitAlive(queryNativeMessage(service('Msg'), await resolvePeer(query.peer), query.messageId));
          lifetime.signal.throwIfAborted();
          return raw === undefined ? undefined : resolvedMessage(raw);
        }
        case 'getMessages': {
          const query = normalizeMessageBatchQuery(payload.peer, payload.messageIds);
          const raw = await awaitAlive(queryNativeMessages(service('Msg'), await resolvePeer(query.peer), query.messageIds));
          lifetime.signal.throwIfAborted();
          const present = raw.filter((message): message is Native => message !== undefined);
          const decoded = await resolvedMessages(present);
          lifetime.signal.throwIfAborted();
          const found = new Map<string, Message>();
          for (let index = 0; index < present.length; index++) {
            const message = decoded[index];
            if (!message || message.messageId !== present[index]!.msgId) throw new Error('Invalid decoded message query batch');
            found.set(message.messageId, message);
          }
          return query.messageIds.map(id => found.get(id));
        }
        case 'getHistory': {
          const query = normalizeHistoryQuery(payload.peer, payload.options);
          const peer = await resolvePeer(query.peer);
          const messages = await awaitAlive(queryNativeHistory(service('Msg'), peer, query.before, query.count, query.reverse));
          lifetime.signal.throwIfAborted();
          return (await resolvedMessages(messages)) as Message[];
        }
        case 'downloadAttachment': {
          const captured=captureDownloadPayload(payload);
          const peer=await resolvePeer(captured.peer);
          lifetime.signal.throwIfAborted();
          return downloadAttachment(service('Msg'),peer,captured,eventCall,lifetime.signal);
        }
        case 'recallMessage': {
          const peer = await resolvePeer(payload.peer);
          const msgId = String(payload.messageId);
          await eventCall('Msg/onMsgInfoListUpdate', (updates: NativeMessage[]) => updates.find(message => message.chatType === peer.chatType && message.peerUid === peer.peerUid && message.msgId === msgId && message.recallTime && message.recallTime !== '0'),
            () => call(service('Msg'), 'recallMsg', peer, [msgId]), 10_000, value => value?.result === 0);
          return undefined;
        }
        case 'getForwardMessages': case 'forwardMessages':
          return forwardMessages.invokeOperation(method, payload);
        case 'listGroupRequests': case 'handleGroupRequest':
          return groupRequests.invokeOperation(method, payload);
        case 'listFriendRequests': case 'handleFriendRequest':
          return friendRequests.invokeOperation(method, payload);
        case 'getUserProfile': case 'setFriendRemark': case 'deleteFriend':
          return contactOperations.invokeOperation(method, payload);
        case 'setNickname': case 'setSignature': return selfProfile.invokeOperation(method,payload);
        case 'listGroupNotices':
          if (!accountId) throw new Error('Group notice listing requires the authenticated account identity');
          return listWebGroupNotices(guardedSession, accountId, payload.groupId, undefined, lifetime.signal);
        case 'publishGroupNotice': case 'deleteGroupNotice':
          return groupNotices.invokeOperation(method, payload);
        case 'setGroupName': case 'setGroupRemark': case 'setGroupMute': case 'setGroupMemberMute':
        case 'setGroupMemberCard': case 'setGroupAdmin': case 'kickGroupMember': case 'leaveGroup':
          return groupOperations.invokeOperation(method, payload);
        default: throw new Error(`Unsupported operation: ${String(method)}`);
      }
    },
    close() {
      closed = true;
      lifetime.abort();
      longMessageTransport?.close();
      forwardResourceTransport?.close();
      usedSendIds.clear();
      recallEvents.close();
      selfProfile.close();
      friendRequests.close();
      groupRequests.close();
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Client closed during native operation')); }
      waiters.clear();
      // Keep native listeners strongly referenced until worker exits; no remove API verified.
      void listeners;
    },
  };
}
