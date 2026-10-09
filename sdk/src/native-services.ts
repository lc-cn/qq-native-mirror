import { nativeResultError } from './errors.ts';
import { normalizeMessageQuery, queryNativeMessage } from './message-query.ts';
import { createSelfProfile, type SelfProfileOperation } from './self-profile.ts';
import { listWebGroupNotices } from './web-group-notices.ts';
import { createGroupNotices, type GroupNoticeOperation } from './group-notices.ts';
import { createForwardMessages, type ForwardOperation } from './forward-messages.ts';
import { createGroupRequests, type GroupRequestOperation } from './group-requests.ts';
import { createVideoElement, type MediaTools } from './media-send.ts';
import { createRecordElement, type RecordCodec } from './media-record.ts';
import { createFriendRequests, type FriendRequestOperation } from './friend-requests.ts';
import { createContactOperations, type ContactOperation } from './contact-operations.ts';
import { downloadAttachment } from './media-operations.ts';
import { createImageElement, createFileElement, createReplyElement, decodeElements, faceElement } from './message-elements.ts';
/** Native contracts extracted from local NapCat; this module never sends at startup. */
import { createGroupOperations, type GroupOperation } from './group-operations.ts';
import { createGroupEvents } from './group-events.ts';
import type { Friend, Group, GroupMember, Message, SentMessage, NativeCallbackAudit } from './types.ts';

type Native = Record<string, any>;
export interface NativePeer { chatType: 1 | 2; peerUid: string; guildId?: string }
export type ServiceOperation = 'listFriends' | 'listGroups' | 'getGroupMembers' | 'sendPrivateMessage' | 'sendGroupMessage' | 'getMessage' | 'getHistory' | 'recallMessage' | 'downloadAttachment' | SelfProfileOperation | 'listGroupNotices' | GroupNoticeOperation | GroupOperation | ContactOperation | FriendRequestOperation | GroupRequestOperation | ForwardOperation;
export interface NativeMessage extends Native { msgId: string; peerUid: string; chatType: number }
interface Waiter { event: string; check: (...args: any[]) => unknown; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

function toSent(message: Native): SentMessage {
  return { messageId: String(message.msgId), sequence: String(message.msgSeq), time: Number(message.msgTime) };
}
function toMessage(message: Native): Message | undefined {
  if (message.chatType !== 1 && message.chatType !== 2) return;
  const elements = decodeElements(message.elements ?? []);
  return {
    ...toSent(message),
    peer: message.chatType === 2 ? { type: 'group', groupId: String(message.peerUid) } : { type: 'private', userId: String(message.peerUin || message.peerUid || '') },
    sender: { userId: String(message.senderUin || message.senderUid || ''), uid: String(message.senderUid || ''), nickname: message.sendNickName ?? '' },
    elements, raw: message,
  };
}

export function createNativeServices(session: Native, version: string, emit: (event: string, payload: unknown) => void, mediaTools?: MediaTools, recordCodec?: RecordCodec, accountId?: string, accountUid?: string, auditCallback?: (info: Pick<NativeCallbackAudit,'family'|'name'|'argumentTypes'>) => void) {
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
  let groupListRequest: Promise<unknown> | undefined;
  let groupListInvalidated = false;
  const call = (object: Native, name: string, ...args: any[]) => {
    if (closed) throw new Error('Native services are closed');
    if (!object || typeof object[name] !== 'function') throw new Error(`Native service is missing ${name}`);
    return object[name](...args);
  };
  const service = (name: string): Native => call(guardedSession, `get${name}Service`);
  const dispatch = (event: string, args: any[]) => {
    for (const waiter of [...waiters]) {
      if (waiter.event !== event) continue;
      try {
        const result = waiter.check(...args);
        if (result !== undefined) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(result); }
      } catch (error) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.reject(error as Error); }
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
      for (const message of messages) {
        if (!message || typeof message !== 'object' || (message.elements !== undefined && (!Array.isArray(message.elements) || message.elements.some((element: unknown) => !element || typeof element !== 'object')))) { emit('diagnostic', { stage: 'invalid-native-message' }); continue; }
        const converted = toMessage(message);
        if (converted) {
          const key = message.msgId && message.peerUid ? JSON.stringify([message.chatType, String(message.peerUid), String(message.msgId)]) : undefined;
          if (key && receivedMessages.has(key)) continue;
          if (key) {
            receivedMessages.add(key);
            if (receivedMessages.size > 10_000) receivedMessages.delete(receivedMessages.values().next().value!);
          }
          emit('message', converted);
        }
      }
      dispatch('Msg/onRecvMsg', [messages]);
    },
    onMsgInfoListUpdate: (messages: NativeMessage[]) => {
      if (closed) return;
      if (!Array.isArray(messages)) { emit('diagnostic', { stage: 'invalid-native-message-update-batch' }); return; }
      const validMessages = messages.filter(message => message && typeof message === 'object');
      if (validMessages.length !== messages.length) emit('diagnostic', { stage: 'invalid-native-message-update' });
      dispatch('Msg/onMsgInfoListUpdate', [validMessages]);
      for (const message of validMessages) {
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
  }, onMemberInfoChange: groupEvents.onMemberInfoChange });
  const eventCall = async (event: string, check: Waiter['check'], invoke: () => any, timeoutMs = 10_000, checkReturn?: (value: any) => boolean) => {
    let waiter: Waiter;
    const result = new Promise<any>((resolve, reject) => {
      waiter = { event, check, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`Native operation timed out: ${event}`)); }, timeoutMs) };
      waiters.add(waiter);
    });
    void result.catch(() => {});
    try {
      const returned = await invoke();
      if (checkReturn && !checkReturn(returned)) throw nativeResultError(`Native operation rejected: ${event}`, returned);
    } catch (error) {
      waiters.delete(waiter!); clearTimeout(waiter!.timer); waiter!.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    return result;
  };
  const uidFor = async (id: string): Promise<string> => {
    if (id.startsWith('u_')) return id;
    if (uidCache.has(id)) return uidCache.get(id)!;
    const converted = await call(service('UixConvert'), 'getUid', [id]);
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
  const forwardMessages = createForwardMessages(guardedSession, resolvePeer, toMessage);
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
      if (element.type === 'video') return createVideoElement(element.file, service('Msg'), mediaTools);
      if (element.type === 'record') return createRecordElement(element.file, service('Msg'), recordCodec);
      if (element.type === 'file') return createFileElement(element.file, element.name);
      if (element.type === 'reply') return createReplyElement(element.messageId, peer, service('Msg'));
      throw new Error(`Unsupported message element: ${String(element.type)}`);
    }));
  };
  const send = async (peer: NativePeer, input: unknown) => {
    const elements = await elementsFor(input, peer);
    const messages = service('Msg');
    const uniqueId = await call(messages, 'generateMsgUniqueId', peer.chatType, call(service('MSF'), 'getServerTime'));
    const destination = { ...peer, guildId: uniqueId };
    const sent = await eventCall('Msg/onMsgInfoListUpdate', (updates: NativeMessage[]) => {
      const message = updates.find(message => message.guildId === uniqueId);
      if (message?.sendStatus === 0) throw new Error('Native message send failed');
      return message?.sendStatus === 2 ? message : undefined;
    },
      () => call(messages, 'sendMsg', '0', destination, elements, new Map()), 10_000, value => value?.result === 0);
    return toSent(sent);
  };
  return {
    async invokeOperation(method: ServiceOperation, payload: Native = {}): Promise<unknown> {
      if (closed) throw new Error('Native services are closed');
      switch (method) {
        case 'listFriends': {
          // Windows 9.9.33 uses the same three-argument V2 contract in the pinned
          // upstream implementation; account-level Windows validation is pending.
          if (!['7.0.2-53644', '3.2.32-52194', '9.9.33-52230'].includes(version)) throw new Error('Buddy list signature not verified for this native version');
          const result = await call(service('Buddy'), 'getBuddyListV2', '0', true, 0);
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
          const profiles = await call(service('Profile'), 'getCoreAndBaseInfo', 'nodeStore', uids);
          if (!(profiles instanceof Map)) throw new Error('Invalid native profile map');
          if (uids.some(uid => !profiles.has(uid))) throw new Error('Native buddy profiles are incomplete');
          const friends = uids.map((uid): Friend => {
            const profile = profiles.get(uid);
            if (!profile?.coreInfo || !/^\d+$/.test(String(profile.coreInfo.uin ?? ''))) throw new Error('Invalid native buddy profile');
            return { userId: String(profile.coreInfo.uin), uid: String(uid), nickname: profile.coreInfo.nick ?? '', remark: profile.coreInfo.remark ?? '' };
          });
          // A rejected batch must not leave usable entries from an earlier row.
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
          return groups.map((group): Group => ({ groupId: String(group.groupCode), name: group.groupName, memberCount: group.memberCount, maxMemberCount: group.maxMember }));
        },
          () => call(service('Group'), 'getGroupList', payload.refresh ?? true),10_000,value=>value?.result===0);
          groupListRequest=request;
          try {return await request;}
          catch(error) {groupListInvalidated=true;throw error;}
          finally {if(groupListRequest===request)groupListRequest=undefined;}
        }
        case 'getGroupMembers': {
          const result = await call(service('Group'), 'getAllMemberList', String(payload.groupId), payload.refresh ?? false);
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
          for (const member of members) uidCache.set(member.userId, member.uid);
          return members;
        }
        case 'sendPrivateMessage': return send({ chatType: 1, peerUid: await uidFor(String(payload.userId)) }, payload.message);
        case 'sendGroupMessage': return send({ chatType: 2, peerUid: String(payload.groupId) }, payload.message);
        case 'getMessage': {
          const query = normalizeMessageQuery(payload.peer, payload.messageId);
          const raw = await queryNativeMessage(service('Msg'), await resolvePeer(query.peer), query.messageId);
          lifetime.signal.throwIfAborted();
          return raw === undefined ? undefined : toMessage(raw);
        }
        case 'getHistory': {
          const peer = await resolvePeer(payload.peer);
          const options = payload.options ?? {};
          const count = options.limit ?? options.count ?? 20;
          if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('History count must be between 1 and 100');
          const result = await call(service('Msg'), 'getMsgsIncludeSelf', peer, String(options.before ?? options.messageId ?? '0'), count, options.reverse ?? false);
          if (!Array.isArray(result?.msgList)) throw new Error('Invalid native history message list');
          return result.msgList.map(toMessage).filter(Boolean);
        }
        case 'downloadAttachment': return downloadAttachment(service('Msg'), await resolvePeer(payload.peer), { messageId: payload.messageId, elementId: payload.elementId, destination: payload.destination }, eventCall, lifetime.signal);
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
        case 'setGroupName': case 'setGroupMute': case 'setGroupMemberMute':
        case 'setGroupMemberCard': case 'setGroupAdmin': case 'kickGroupMember': case 'leaveGroup':
          return groupOperations.invokeOperation(method, payload);
        default: throw new Error(`Unsupported operation: ${String(method)}`);
      }
    },
    close() {
      closed = true;
      lifetime.abort();
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
