import { captureMergedForward } from './features/forward/merged-forward-input.ts';
import { captureDownloadPayload } from './features/media/download-input.ts';
import {
  normalizeMessageQuery,
  normalizeMessageBatchQuery,
  normalizeHistoryQuery,
} from './features/messages/query-input.ts';
import { cleanupAll, withCleanupFailure } from './runtime/cleanup.ts';
import type { NativeServiceContext } from './runtime/native-service-context.ts';
import { supportsCategoryCreation } from './native/native-contracts.ts';
import { createFriendCategory } from './features/contacts/friend-category-create.ts';
import { createFriendSystemEvents } from './features/contacts/friend-system-events.ts';
import {
  friendCategoryName,
  captureFriendCategories,
  projectFriendCategories,
} from './features/contacts/friend-categories.ts';
import { nativeResultError } from './errors.ts';
import { createNativeEventChannel } from './runtime/native-event-channel.ts';
import { sendCapturedMergedForward } from './features/forward/merged-forward.ts';
import {
  createLongMessageResponseTransport,
  type LongMessageResponseService,
} from './features/forward/long-message-response.ts';
import {
  buildForwardResourceRequest,
  normalizeForwardResourceId,
} from './features/forward/forward-resource-wire.ts';
import {
  createForwardResourceTransport,
  type ForwardResourceService,
} from './features/forward/forward-resource-transport.ts';
import {
  queryNativeMessage,
  queryNativeMessages,
  queryNativeHistory,
} from './features/messages/message-query.ts';
import { createSelfProfile } from './features/contacts/self-profile.ts';
import { listWebGroupNotices } from './features/groups/web-group-notices.ts';
import { createGroupNotices } from './features/groups/group-notices.ts';
import { createForwardMessages } from './features/forward/forward-messages.ts';
import { createGroupRequests } from './features/groups/group-requests.ts';
import { createFriendRequests } from './features/contacts/friend-requests.ts';
import { createContactOperations } from './features/contacts/contact-operations.ts';
import { downloadAttachment } from './features/media/media-operations.ts';
import { decodeElements } from './features/messages/message-elements.ts';
import { createNativeMessageSender } from './features/messages/native-message-sender.ts';
/** Native contracts extracted from local NapCat; this module never sends at startup. */
import { createGroupOperations } from './features/groups/group-operations.ts';
import { createGroupEvents, projectGroupInfo } from './features/groups/group-events.ts';
import { createGroupSystemEvents } from './features/groups/group-system-events.ts';
import { projectGroupMuteList } from './features/groups/group-mute-list.ts';
import { createRecallEvents } from './features/messages/recall-events.ts';
import { createIncomingMessageDelivery } from './features/messages/incoming-message-delivery.ts';
import {
  decodeNativeMessages,
  projectNativeMessage,
} from './features/messages/inbound-messages.ts';
import { captureSendInput, sendUserId, sendGroupId } from './features/messages/send-input.ts';
import type {
  Friend,
  Group,
  GroupMember,
  GroupInfoUpdate,
  GroupMutedMember,
  Message,
} from './types.ts';

import type { NativeObject as Native } from './native/native-object.ts';
import type { NativePeer, NativeMessage } from './native/message-contracts.ts';
export type { NativePeer, NativeMessage } from './native/message-contracts.ts';
import type { ServiceOperation } from './runtime/operations.ts';
export type { ServiceOperation } from './runtime/operations.ts';

/** A callback does not replace the native method's own completion code. */
function nativeCallSucceeded(value: unknown): boolean {
  return (value as { result?: unknown } | null | undefined)?.result === 0;
}

function toMessage(message: Native, raw: unknown = message): Message {
  return projectNativeMessage(message, decodeElements(message.elements), new Map(), raw);
}

/** Compose account-scoped native operations from explicit runtime dependencies.
 * This context changes dependency injection only: native calls remain guarded,
 * callback completion and shutdown retain their existing semantics.
 */
export function createNativeServices(context: NativeServiceContext) {
  const { session, version, auditCallback, binaryProfile: nativeContracts } = context;
  const emit = (event: string, payload: unknown) => {
    if (!closed) context.events.emit(event, payload);
  };
  const { userId: accountId, uid: accountUid } = context.identity ?? {};
  const lifetime = new AbortController();
  let closed = false;
  const listeners: Native[] = [];
  const cleanupSteps: (() => void)[] = [() => lifetime.abort()];
  const own = <T extends { close(): void }>(resource: T): T => {
    cleanupSteps.push(() => resource.close());
    return resource;
  };
  const close = () => {
    // Retain native listener objects for the owned worker lifetime. A removal ABI
    // is not verified for these listeners; closed callbacks become inert instead.
    void listeners;
    if (closed) return;
    closed = true;
    cleanupAll(cleanupSteps);
  };
  try {
    // Modules may retain services across awaits. Guard the actual method boundary,
    // so stale work cannot dispatch a new mutation after Session shutdown.
    const guardedSession = new Proxy(session, {
      get(target, key) {
        const member = Reflect.get(target, key);
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          if (closed) throw new Error('Native services are closed');
          const value = Reflect.apply(member, target, args);
          if (
            typeof key !== 'string' ||
            !/^get.+Service$/.test(key) ||
            !value ||
            typeof value !== 'object'
          )
            return value;
          return new Proxy(value, {
            get(serviceTarget, serviceKey) {
              const method = Reflect.get(serviceTarget, serviceKey);
              if (typeof method !== 'function') return method;
              return (...serviceArgs: unknown[]) => {
                if (
                  closed &&
                  !(typeof serviceKey === 'string' && /^removeKernel.+Listener$/.test(serviceKey))
                )
                  throw new Error('Native services are closed');
                return Reflect.apply(method, serviceTarget, serviceArgs);
              };
            },
          });
        };
      },
    });
    const callbackChannel = own(createNativeEventChannel(lifetime.signal));
    const { dispatch, call: eventCall } = callbackChannel;
    const uidCache = new Map<string, string>();
    cleanupSteps.push(() => {
      uidCache.clear();
    });
    const recallEvents = own(createRecallEvents(emit));
    let groupListRequest: Promise<unknown> | undefined;
    let groupListInvalidated = false;
    const call = (object: Native, name: string, ...args: unknown[]) => {
      if (closed) throw new Error('Native services are closed');
      if (!object || typeof object[name] !== 'function')
        throw new Error(`Native service is missing ${name}`);
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
      } finally {
        lifetime.signal.removeEventListener('abort', abort!);
      }
    };
    const resolvedMessages = async (
      messages: Native[],
      rawMessages = messages,
      live = false,
      signal = lifetime.signal,
    ): Promise<(Message | undefined)[]> => {
      return decodeNativeMessages(
        messages,
        rawMessages,
        async (uids) => {
          const value = await call(service('UixConvert'), 'getUin', uids);
          return value?.uinInfo;
        },
        signal,
        (stage) => {
          if (!closed) emit('diagnostic', { stage });
        },
        live,
      );
    };
    const resolvedMessage = async (message: Native) => (await resolvedMessages([message]))[0];
    const incomingMessages = own(
      createIncomingMessageDelivery({
        resolveMessages: (messages, rawMessages, signal) =>
          resolvedMessages(messages, rawMessages, true, signal),
        project: toMessage,
        emitMessage: (message) => emit('message', message),
        diagnostic: (stage) => emit('diagnostic', { stage }),
        dispatch: (rawMessages) => dispatch('Msg/onRecvMsg', [rawMessages]),
      }),
    );
    const listener = (family: string, overrides: Native) => {
      const wrapped = new Map<PropertyKey, (...args: unknown[]) => unknown>();
      const target = new Proxy(overrides, {
        get: (object, key) => {
          const member = object[key as string];
          if (member !== undefined && typeof member !== 'function') return member;
          if (!wrapped.has(key))
            wrapped.set(key, (...args: unknown[]) => {
              if (closed) return;
              auditCallback?.({
                family,
                name: String(key),
                argumentTypes: args.map((value) =>
                  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
                ),
              });
              return typeof member === 'function'
                ? Reflect.apply(member, object, args)
                : dispatch(`${family}/${String(key)}`, args);
            });
          return wrapped.get(key);
        },
      });
      call(service(family), `addKernel${family}Listener`, target);
      listeners.push(target);
    };
    const groupSystemEvents = own(createGroupSystemEvents(emit));
    const friendSystemEvents = own(createFriendSystemEvents(emit));
    listener('Msg', {
      onRecvSysMsg: groupSystemEvents.onRecvSysMsg,
      onRecvMsg: (messages: NativeMessage[]) => {
        if (closed) return;
        if (!Array.isArray(messages)) {
          emit('diagnostic', { stage: 'invalid-native-message-batch' });
          return;
        }
        if (groupSystemEvents.hasMuteCandidate(messages)) groupSystemEvents.onRecvMsg(messages);
        if (closed) return;
        if (friendSystemEvents.hasAddedCandidate(messages)) friendSystemEvents.onRecvMsg(messages);
        if (closed) return;
        incomingMessages.receive(messages);
      },
      onMsgInfoListUpdate: (messages: NativeMessage[]) => {
        if (closed) return;
        if (!Array.isArray(messages)) {
          emit('diagnostic', { stage: 'invalid-native-message-update-batch' });
          return;
        }
        const validMessages = messages.filter((message) => message && typeof message === 'object');
        if (validMessages.length !== messages.length)
          emit('diagnostic', { stage: 'invalid-native-message-update' });
        dispatch('Msg/onMsgInfoListUpdate', [validMessages]);
        for (const message of validMessages) {
          recallEvents.onMessageUpdate(message);
          if (message.recallTime && message.recallTime !== '0') emit('message-recalled', message);
        }
      },
      onKickedOffLine: (...args: unknown[]) => {
        if (!closed) emit('kicked', { info: args[0], args });
      },
    });
    const groupEvents = createGroupEvents(emit);
    listener('Group', {
      onGroupListUpdate: (kind: unknown, groups: Native[]) => {
        if (process.env.QQ_NATIVE_TRACE_FIELDS === '1')
          emit('diagnostic', {
            stage: `group-list-update:kind-${typeof kind === 'number' || typeof kind === 'boolean' ? String(kind) : typeof kind}:count-${Array.isArray(groups) ? groups.length : 'non-array'}`,
          });
        groupEvents.onGroupListUpdate(kind, groups);
        dispatch('Group/onGroupListUpdate', [kind, groups]);
      },
      onMemberInfoChange: groupEvents.onMemberInfoChange,
      onGroupDetailInfoChange: (value: unknown) => {
        groupEvents.onGroupDetailInfoChange(value);
        dispatch('Group/onGroupDetailInfoChange', [value]);
      },
    });
    // Detail callbacks carry a group ID but no request nonce. Coalesce concurrent
    // reads, and quarantine failed channels so late results cannot satisfy retries.
    const groupInfoQueries = new Map<string, Promise<GroupInfoUpdate>>();
    const invalidGroupInfoQueries = new Set<string>();
    cleanupSteps.push(() => {
      groupInfoQueries.clear();
      invalidGroupInfoQueries.clear();
    });
    const getGroupInfo = async (id: string): Promise<GroupInfoUpdate> => {
      lifetime.signal.throwIfAborted();
      if (invalidGroupInfoQueries.has(id))
        throw new Error('Group detail query channel is invalid; recreate the Session');
      let pending = groupInfoQueries.get(id);
      if (!pending) {
        pending = eventCall(
          'Group/onGroupDetailInfoChange',
          (raw: unknown) => {
            if (
              raw === null ||
              typeof raw !== 'object' ||
              Object.getOwnPropertyDescriptor(raw, 'groupCode')?.value !== id
            )
              return;
            return projectGroupInfo(raw);
          },
          () => call(service('Group'), 'getGroupDetailInfo', id, 2),
          5000,
          nativeCallSucceeded,
        )
          .catch((error) => {
            invalidGroupInfoQueries.add(id);
            throw error;
          })
          .finally(() => {
            groupInfoQueries.delete(id);
          });
        groupInfoQueries.set(id, pending);
      }
      const value = await pending;
      lifetime.signal.throwIfAborted();
      return { ...value };
    };
    const groupMuteQueries = new Map<string, Promise<GroupMutedMember[]>>();
    const invalidGroupMuteQueries = new Set<string>();
    cleanupSteps.push(() => {
      groupMuteQueries.clear();
      invalidGroupMuteQueries.clear();
    });
    const listGroupMutedMembers = async (id: string): Promise<GroupMutedMember[]> => {
      lifetime.signal.throwIfAborted();
      if (invalidGroupMuteQueries.has(id))
        throw new Error('Group mute-list query channel is invalid; recreate the Session');
      let pending = groupMuteQueries.get(id);
      if (!pending) {
        pending = eventCall(
          'Group/onShutUpMemberListChanged',
          (groupId: unknown, members: unknown) => {
            if (groupId !== id) return;
            return projectGroupMuteList(members);
          },
          () => call(service('Group'), 'getGroupShutUpMemberList', id),
          5000,
          nativeCallSucceeded,
        )
          .catch((error) => {
            invalidGroupMuteQueries.add(id);
            throw error;
          })
          .finally(() => {
            groupMuteQueries.delete(id);
          });
        groupMuteQueries.set(id, pending);
      }
      const value = await pending;
      lifetime.signal.throwIfAborted();
      return value.map((member) => ({ ...member }));
    };
    const uidFor = async (id: string): Promise<string> => {
      if (id.startsWith('u_')) return id;
      if (uidCache.has(id)) return uidCache.get(id)!;
      const converted = await awaitAlive(call(service('UixConvert'), 'getUid', [id]));
      const uid = converted?.uidInfo?.get(id);
      if (typeof uid !== 'string' || !uid || uid.includes('*'))
        throw new Error('Could not resolve user identifier');
      return uid;
    };
    const friendRequests = own(createFriendRequests(guardedSession, emit));
    const groupRequests = own(createGroupRequests(guardedSession, emit));
    const contactOperations = createContactOperations(guardedSession, uidFor);
    const selfProfile = own(createSelfProfile(guardedSession, () => accountUid ?? ''));
    const groupNotices = createGroupNotices(guardedSession);
    const groupOperations = createGroupOperations(guardedSession, uidFor);
    const resolvePeer = async (peer: Native): Promise<NativePeer> => {
      if (peer?.chatType === 1 || peer?.chatType === 2) {
        if (typeof peer.peerUid !== 'string' || !peer.peerUid) throw new Error('Invalid peer UID');
        return { chatType: peer.chatType, peerUid: peer.peerUid };
      }
      if (peer?.type === 'group') return { chatType: 2, peerUid: String(peer.groupId ?? peer.id) };
      if (peer?.type === 'private')
        return { chatType: 1, peerUid: await uidFor(String(peer.userId ?? peer.id)) };
      throw new Error('Unsupported peer type');
    };
    const forwardMessages = createForwardMessages(
      guardedSession,
      resolvePeer,
      resolvedMessage,
      lifetime.signal,
      resolvedMessages,
    );
    const sender = own(
      createNativeMessageSender({
        signal: lifetime.signal,
        service,
        call,
        awaitAlive,
        uidFor,
        eventCall,
        media: context.media,
      }),
    );
    let longMessageTransport: ReturnType<typeof createLongMessageResponseTransport> | undefined;
    let forwardResourceTransport: ReturnType<typeof createForwardResourceTransport> | undefined;
    cleanupSteps.push(
      () => longMessageTransport?.close(),
      () => forwardResourceTransport?.close(),
    );
    return {
      async invokeOperation(method: ServiceOperation, payload: Native = {}): Promise<unknown> {
        if (closed) throw new Error('Native services are closed');
        switch (method) {
          case 'addFriendCategory': {
            const name = friendCategoryName(payload.name);
            if (!supportsCategoryCreation(nativeContracts, version))
              throw new Error(
                'Friend category creation contract is not verified for this native binary',
              );
            return createFriendCategory(
              name,
              (value, members) => call(service('Buddy'), 'addCategoryV2', value, members),
              lifetime.signal,
            );
          }
          case 'listGroupMutedMembers':
            return listGroupMutedMembers(sendGroupId(payload.groupId));
          case 'getGroupInfo':
            return getGroupInfo(sendGroupId(payload.groupId));
          case 'listFriendCategories': {
            if (!['7.0.2-53644', '3.2.32-52194', '9.9.33-52230'].includes(version))
              throw new Error('Buddy list signature not verified for this native version');
            const raw = await awaitAlive(call(service('Buddy'), 'getBuddyListV2', '0', true, 0));
            const captured = captureFriendCategories(raw);
            const profiles = await awaitAlive(
              call(service('Profile'), 'getCoreAndBaseInfo', 'nodeStore', [...captured.uniqueUIDs]),
            );
            const categories = projectFriendCategories(captured, profiles);
            lifetime.signal.throwIfAborted();
            for (const category of categories)
              for (const friend of category.friends) uidCache.set(friend.userId, friend.uid);
            return categories;
          }
          case 'listFriends': {
            // Windows 9.9.33 uses the same three-argument V2 contract in the pinned
            // upstream implementation; account-level Windows validation is pending.
            if (!['7.0.2-53644', '3.2.32-52194', '9.9.33-52230'].includes(version))
              throw new Error('Buddy list signature not verified for this native version');
            const result = await awaitAlive(call(service('Buddy'), 'getBuddyListV2', '0', true, 0));
            // Pinned getBuddyListV2 returns GeneralCallResult as well as data.
            // An empty data array does not establish a successful query.
            if (result?.result !== 0)
              throw nativeResultError('Native buddy list query failed', result);
            if (!Array.isArray(result?.data)) throw new Error('Invalid native buddy list');
            // Materialize holes before validation; flatMap/some would skip them.
            const categories = Array.from(result.data);
            if (categories.some((category) => !Array.isArray((category as Native)?.buddyUids)))
              throw new Error('Invalid native buddy list');
            const requested = categories.flatMap((category) =>
              Array.from((category as Native).buddyUids),
            );
            if (!requested.every((uid): uid is string => typeof uid === 'string' && uid.length > 0))
              throw new Error('Invalid native buddy UID');
            const uids = [...new Set<string>(requested)];
            const profiles = await awaitAlive(
              call(service('Profile'), 'getCoreAndBaseInfo', 'nodeStore', uids),
            );
            if (!(profiles instanceof Map)) throw new Error('Invalid native profile map');
            if (uids.some((uid) => !profiles.has(uid)))
              throw new Error('Native buddy profiles are incomplete');
            const friends = uids.map((uid): Friend => {
              const profile = profiles.get(uid);
              const core = profile?.coreInfo;
              if (
                !core ||
                typeof core !== 'object' ||
                Array.isArray(core) ||
                typeof core.uid !== 'string' ||
                !core.uid.trim() ||
                core.uid !== uid ||
                typeof core.uin !== 'string' ||
                !/^\d+$/.test(core.uin) ||
                typeof core.remark !== 'string' ||
                (core.nick !== undefined && typeof core.nick !== 'string')
              )
                throw new Error('Invalid native buddy profile');
              return { userId: core.uin, uid, nickname: core.nick ?? '', remark: core.remark };
            });
            // A rejected batch must not leave usable entries from an earlier row.
            lifetime.signal.throwIfAborted();
            for (const friend of friends) uidCache.set(friend.userId, friend.uid);
            return friends;
          }
          case 'listGroups': {
            if (groupListInvalidated)
              throw new Error('Group list query channel invalidated; create a new Session');
            if (groupListRequest) return groupListRequest;
            const request = eventCall(
              'Group/onGroupListUpdate',
              (update: number, groups: Native[]) => {
                // Source: NapCatQQ packages/napcat-core/types/group.ts GroupListUpdateType.
                // REFRESHALL=0 and GETALL=1 are full lists; MODIFIED/REMOVE and new native
                // update kinds can carry partial or empty deltas. Never return those.
                if (update !== 0 && update !== 1) return undefined;
                if (!Array.isArray(groups)) throw new Error('Invalid native group list');
                return Array.from(groups, (group): Group => {
                  if (
                    !group ||
                    typeof group !== 'object' ||
                    Array.isArray(group) ||
                    typeof group.groupCode !== 'string' ||
                    !/^\d+$/.test(group.groupCode) ||
                    typeof group.groupName !== 'string' ||
                    !Number.isSafeInteger(group.memberCount) ||
                    group.memberCount < 0 ||
                    !Number.isSafeInteger(group.maxMember) ||
                    group.maxMember < 0
                  )
                    throw new Error('Invalid native group list');
                  return {
                    groupId: group.groupCode,
                    name: group.groupName,
                    memberCount: group.memberCount,
                    maxMemberCount: group.maxMember,
                  };
                });
              },
              () => call(service('Group'), 'getGroupList', payload.refresh ?? true),
              10_000,
              nativeCallSucceeded,
            );
            groupListRequest = request;
            try {
              return await request;
            } catch (error) {
              groupListInvalidated = true;
              throw error;
            } finally {
              if (groupListRequest === request) groupListRequest = undefined;
            }
          }
          case 'getGroupMembers': {
            const groupId = sendGroupId(payload.groupId);
            const refresh = payload.refresh ?? false;
            if (typeof refresh !== 'boolean') throw new Error('refresh must be a boolean');
            const result = await awaitAlive(
              call(service('Group'), 'getAllMemberList', groupId, refresh),
            );
            // Pinned NodeIKernelGroupService.getAllMemberList reports errCode and
            // finish:true. A Map alone does not establish a successful full list.
            if (result?.errCode !== 0)
              throw nativeResultError('Native group member query failed', result, 'errCode');
            const infos = result?.result?.infos;
            if (!(infos instanceof Map)) throw new Error('Invalid native group member map');
            if (result.result.finish !== true)
              throw Object.assign(new Error('Native group member list is incomplete'), {
                code: 'incomplete-result',
              });
            const members = [...infos.entries()].map(([uid, member]): GroupMember => {
              // Pinned GroupMember identity and display fields are strings. Do not
              // invent an identity by coercing a number/object or substituting keys.
              if (
                typeof uid !== 'string' ||
                !uid.trim() ||
                !member ||
                typeof member !== 'object' ||
                Array.isArray(member) ||
                member.uid !== uid ||
                typeof member.uin !== 'string' ||
                !/^\d+$/.test(member.uin) ||
                typeof member.nick !== 'string' ||
                typeof member.cardName !== 'string'
              )
                throw new Error('Invalid native group member');
              if (typeof member.role !== 'number')
                throw new Error('Unknown native group member role');
              const role = ({ 4: 'owner', 3: 'admin', 2: 'member' } as const)[
                member.role as 2 | 3 | 4
              ];
              if (!role) throw new Error('Unknown native group member role');
              return {
                userId: member.uin,
                uid,
                nickname: member.nick,
                card: member.cardName,
                role,
              };
            });
            // Commit only a complete validated query; failures leave no partial cache.
            lifetime.signal.throwIfAborted();
            for (const member of members) uidCache.set(member.userId, member.uid);
            return members;
          }
          case 'sendPrivateMessage': {
            const userId = sendUserId(payload.userId);
            const input = captureSendInput(payload.message, false);
            return sender.send({ chatType: 1, peerUid: await uidFor(userId) }, input);
          }
          case 'sendGroupMessage': {
            const groupId = sendGroupId(payload.groupId);
            const input = captureSendInput(payload.message, true);
            return sender.send({ chatType: 2, peerUid: groupId }, input);
          }
          case 'sendMergedForward': {
            const captured = captureMergedForward(payload.peer, payload.nodes, payload.options);
            const destination = await resolvePeer(captured.peer);
            lifetime.signal.throwIfAborted();
            return sendCapturedMergedForward(
              captured,
              accountUid ?? '',
              () =>
                (longMessageTransport ??= createLongMessageResponseTransport(
                  service('Msg') as LongMessageResponseService,
                )),
              (card, onDispatch) => sender.sendPrepared(destination, [card], onDispatch),
              lifetime.signal,
            );
          }
          case 'getForwardResource': {
            const resourceId = normalizeForwardResourceId(payload.resourceId),
              selfUid = accountUid ?? '';
            buildForwardResourceRequest(selfUid, resourceId); // Preflight before obtaining any native service.
            lifetime.signal.throwIfAborted();
            return (forwardResourceTransport ??= createForwardResourceTransport(
              service('Msg') as ForwardResourceService,
            )).read(selfUid, resourceId, { signal: lifetime.signal });
          }
          case 'getMessage': {
            const query = normalizeMessageQuery(payload.peer, payload.messageId);
            const raw = await awaitAlive(
              queryNativeMessage(service('Msg'), await resolvePeer(query.peer), query.messageId),
            );
            lifetime.signal.throwIfAborted();
            return raw === undefined ? undefined : resolvedMessage(raw);
          }
          case 'getMessages': {
            const query = normalizeMessageBatchQuery(payload.peer, payload.messageIds);
            const raw = await awaitAlive(
              queryNativeMessages(service('Msg'), await resolvePeer(query.peer), query.messageIds),
            );
            lifetime.signal.throwIfAborted();
            const present = raw.filter((message): message is Native => message !== undefined);
            const decoded = await resolvedMessages(present);
            lifetime.signal.throwIfAborted();
            const found = new Map<string, Message>();
            for (let index = 0; index < present.length; index++) {
              const message = decoded[index];
              if (!message || message.messageId !== present[index]!.msgId)
                throw new Error('Invalid decoded message query batch');
              found.set(message.messageId, message);
            }
            return query.messageIds.map((id) => found.get(id));
          }
          case 'getHistory': {
            const query = normalizeHistoryQuery(payload.peer, payload.options);
            const peer = await resolvePeer(query.peer);
            const messages = await awaitAlive(
              queryNativeHistory(service('Msg'), peer, query.before, query.count, query.reverse),
            );
            lifetime.signal.throwIfAborted();
            return (await resolvedMessages(messages)) as Message[];
          }
          case 'downloadAttachment': {
            const captured = captureDownloadPayload(payload);
            const peer = await resolvePeer(captured.peer);
            lifetime.signal.throwIfAborted();
            return downloadAttachment(service('Msg'), peer, captured, eventCall, lifetime.signal);
          }
          case 'recallMessage': {
            const peer = await resolvePeer(payload.peer);
            const msgId = String(payload.messageId);
            await eventCall(
              'Msg/onMsgInfoListUpdate',
              (updates: NativeMessage[]) =>
                updates.find(
                  (message) =>
                    message.chatType === peer.chatType &&
                    message.peerUid === peer.peerUid &&
                    message.msgId === msgId &&
                    message.recallTime &&
                    message.recallTime !== '0',
                ),
              () => call(service('Msg'), 'recallMsg', peer, [msgId]),
              10_000,
              nativeCallSucceeded,
            );
            return undefined;
          }
          case 'getForwardMessages':
          case 'forwardMessages':
            return forwardMessages.invokeOperation(method, payload);
          case 'listGroupRequests':
          case 'handleGroupRequest':
            return groupRequests.invokeOperation(method, payload);
          case 'listFriendRequests':
          case 'handleFriendRequest':
            return friendRequests.invokeOperation(method, payload);
          case 'getUserProfile':
          case 'setFriendRemark':
          case 'deleteFriend':
            return contactOperations.invokeOperation(method, payload);
          case 'setNickname':
          case 'setSignature':
            return selfProfile.invokeOperation(method, payload);
          case 'listGroupNotices':
            if (!accountId)
              throw new Error('Group notice listing requires the authenticated account identity');
            return listWebGroupNotices(
              guardedSession,
              accountId,
              payload.groupId,
              undefined,
              lifetime.signal,
            );
          case 'publishGroupNotice':
          case 'deleteGroupNotice':
            return groupNotices.invokeOperation(method, payload);
          case 'setGroupName':
          case 'setGroupRemark':
          case 'setGroupMute':
          case 'setGroupMemberMute':
          case 'setGroupMemberCard':
          case 'setGroupAdmin':
          case 'kickGroupMember':
          case 'leaveGroup':
            return groupOperations.invokeOperation(method, payload);
          default: {
            const unsupported: never = method;
            throw new Error(`Unsupported operation: ${String(unsupported)}`);
          }
        }
      },
      close,
    };
  } catch (original) {
    try {
      close();
    } catch (cleanup) {
      throw withCleanupFailure(original, cleanup);
    }
    throw original;
  }
}
