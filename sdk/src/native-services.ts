import { captureGroupFileCount } from './features/groups/group-file-input.ts';
import { deleteGroupFolder, getGroupFileCount } from './features/groups/group-file-operations.ts';
import { captureMergedForward } from './features/forward/merged-forward-input.ts';
import { captureDownloadPayload } from './features/media/download-input.ts';
import { createMessageQueries } from './features/messages/message-queries.ts';
import { withCleanupFailure } from './runtime/cleanup.ts';
import { NativeServiceLifetime } from './runtime/native-service-lifetime.ts';
import type { NativeServiceContext } from './runtime/native-service-context.ts';
import { supportsCategoryCreation, supportsGroupFileCount } from './native/native-contracts.ts';
import { createFriendCategory } from './features/contacts/friend-category-create.ts';
import { createFriendSystemEvents } from './features/contacts/friend-system-events.ts';
import { friendCategoryName } from './features/contacts/friend-categories.ts';
import { createContactDirectory } from './features/contacts/contact-directory.ts';
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
import { queryNativeMessage } from './features/messages/message-query.ts';
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
import {
  getGroupEssencePage,
  listGroupEssenceMessages,
} from './features/groups/group-essence-list.ts';
import { setGroupEssenceMessage } from './features/groups/group-essence.ts';
import { createGroupEvents } from './features/groups/group-events.ts';
import { createGroupQueries } from './features/groups/group-queries.ts';
import { createGroupSystemEvents } from './features/groups/group-system-events.ts';
import { createRecallEvents } from './features/messages/recall-events.ts';
import { createIncomingMessageDelivery } from './features/messages/incoming-message-delivery.ts';
import {
  decodeNativeMessages,
  projectNativeMessage,
} from './features/messages/inbound-messages.ts';
import { captureSendInput, sendUserId, sendGroupId } from './features/messages/send-input.ts';
import type { Message } from './contracts/messages.ts';

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
    if (!lifetime.closed) context.events.emit(event, payload);
  };
  const { userId: accountId, uid: accountUid } = context.identity ?? {};
  const lifetime = new NativeServiceLifetime();
  const listeners: Native[] = [];
  const own = <T extends { close(): void }>(resource: T): T => lifetime.own(resource);
  const close = () => {
    // Removal ABIs are not verified for these listeners. Retain native callback
    // objects for the worker lifetime; callbacks consult the closed Session.
    void listeners;
    lifetime.close();
  };
  try {
    const guardedSession = lifetime.guardSession(session);
    const callbackChannel = own(createNativeEventChannel(lifetime.signal));
    const { dispatch, call: eventCall } = callbackChannel;
    const recallEvents = own(createRecallEvents(emit));
    const call = (object: Native, name: string, ...args: unknown[]) => {
      if (lifetime.closed) throw new Error('Native services are closed');
      if (!object || typeof object[name] !== 'function')
        throw new Error(`Native service is missing ${name}`);
      return object[name](...args);
    };
    const service = (name: string): Native => call(guardedSession, `get${name}Service`);
    const { awaitAlive } = lifetime;
    const directory = own(
      createContactDirectory({
        signal: lifetime.signal,
        version,
        getBuddyService: () => service('Buddy'),
        getProfileService: () => service('Profile'),
        getUidService: () => service('UixConvert'),
        awaitAlive,
      }),
    );
    const { uidFor } = directory;
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
          if (!lifetime.closed) emit('diagnostic', { stage });
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
              if (lifetime.closed) return;
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
        if (lifetime.closed) return;
        if (!Array.isArray(messages)) {
          emit('diagnostic', { stage: 'invalid-native-message-batch' });
          return;
        }
        if (groupSystemEvents.hasMuteCandidate(messages)) groupSystemEvents.onRecvMsg(messages);
        if (lifetime.closed) return;
        if (friendSystemEvents.hasAddedCandidate(messages)) friendSystemEvents.onRecvMsg(messages);
        if (lifetime.closed) return;
        incomingMessages.receive(messages);
      },
      onMsgInfoListUpdate: (messages: NativeMessage[]) => {
        if (lifetime.closed) return;
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
        if (!lifetime.closed) emit('kicked', { info: args[0], args });
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
    const groupQueries = own(
      createGroupQueries({
        signal: lifetime.signal,
        getGroupService: () => service('Group'),
        eventCall,
        awaitAlive,
        commitMembers: directory.rememberMembers,
      }),
    );
    const friendRequests = own(
      createFriendRequests({
        getBuddyService: () => service('Buddy'),
        emit,
        signal: lifetime.signal,
        awaitAlive,
      }),
    );
    const groupRequests = own(
      createGroupRequests({
        getGroupService: () => service('Group'),
        emit,
        signal: lifetime.signal,
        awaitAlive,
      }),
    );
    const contactOperations = createContactOperations({
      getBuddyService: () => service('Buddy'),
      getProfileService: () => service('Profile'),
      resolveUid: uidFor,
      signal: lifetime.signal,
      awaitAlive,
    });
    const selfProfile = own(
      createSelfProfile({
        getProfileService: () => service('Profile'),
        resolveSelfUid: () => accountUid ?? '',
        signal: lifetime.signal,
        awaitAlive,
      }),
    );
    const groupNotices = own(
      createGroupNotices({
        getGroupService: () => service('Group'),
        getTipOffService: () => service('TipOff'),
        signal: lifetime.signal,
        awaitAlive,
      }),
    );
    const groupOperations = createGroupOperations({
      getGroupService: () => service('Group'),
      resolveUid: uidFor,
      signal: lifetime.signal,
      awaitAlive,
    });
    const resolvePeer = async (value: unknown): Promise<NativePeer> => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Unsupported peer type');
      const peer = value as Record<string, unknown>;
      if (peer?.chatType === 1 || peer?.chatType === 2) {
        if (typeof peer.peerUid !== 'string' || !peer.peerUid) throw new Error('Invalid peer UID');
        return { chatType: peer.chatType, peerUid: peer.peerUid };
      }
      if (peer?.type === 'group') return { chatType: 2, peerUid: String(peer.groupId ?? peer.id) };
      if (peer?.type === 'private')
        return { chatType: 1, peerUid: await uidFor(String(peer.userId ?? peer.id)) };
      throw new Error('Unsupported peer type');
    };
    const forwardMessages = own(
      createForwardMessages({
        getMessageService: () => service('Msg'),
        resolvePeer,
        decodeMessage: resolvedMessage,
        signal: lifetime.signal,
        awaitAlive,
        decodeMessages: resolvedMessages,
      }),
    );
    const sender = own(
      createNativeMessageSender({
        signal: lifetime.signal,
        getMessageService: () => service('Msg'),
        getServerTimeService: () => service('MSF'),
        awaitAlive,
        uidFor,
        eventCall,
        media: context.media,
      }),
    );
    const messageQueries = createMessageQueries({
      signal: lifetime.signal,
      getMessageService: () => service('Msg'),
      resolvePeer,
      decode: resolvedMessages,
      awaitAlive,
    });
    let longMessageTransport: ReturnType<typeof createLongMessageResponseTransport> | undefined;
    let forwardResourceTransport: ReturnType<typeof createForwardResourceTransport> | undefined;
    lifetime.defer(() => longMessageTransport?.close());
    lifetime.defer(() => forwardResourceTransport?.close());
    return {
      async invokeOperation(
        method: ServiceOperation,
        payload: Record<string, unknown> = {},
        requestSignal?: AbortSignal,
      ): Promise<unknown> {
        if (lifetime.closed) throw new Error('Native services are closed');
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
            return groupQueries.listGroupMutedMembers(sendGroupId(payload.groupId));
          case 'getGroupInfo':
            return groupQueries.getGroupInfo(sendGroupId(payload.groupId));
          case 'listFriendCategories':
            return directory.listFriendCategories();
          case 'listFriends':
            return directory.listFriends();
          case 'listGroups':
            return groupQueries.listGroups(payload.refresh ?? true);
          case 'getGroupMembers':
            return groupQueries.getGroupMembers(
              sendGroupId(payload.groupId),
              payload.refresh ?? false,
            );
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
          case 'getMessage':
            return messageQueries.getMessage(payload.peer, payload.messageId);
          case 'getMessages':
            return messageQueries.getMessages(payload.peer, payload.messageIds);
          case 'getHistory':
            return messageQueries.getHistory(payload.peer, payload.options);
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
          case 'listGroupNotices': {
            if (!accountId)
              throw new Error('Group notice listing requires the authenticated account identity');
            const signal = requestSignal
              ? AbortSignal.any([lifetime.signal, requestSignal])
              : lifetime.signal;
            signal.throwIfAborted();
            return awaitAlive(
              listWebGroupNotices(guardedSession, accountId, payload.groupId, undefined, signal),
              signal,
            );
          }
          case 'publishGroupNotice':
          case 'deleteGroupNotice':
            return groupNotices.invokeOperation(method, payload);
          case 'getGroupFileCount': {
            const captured = captureGroupFileCount(payload.groupId);
            if (!supportsGroupFileCount(nativeContracts, version))
              throw Object.assign(
                new Error('Group file count contract is not verified for this native binary'),
                { code: 'unsupported-native-contract' },
              );
            return getGroupFileCount(
              {
                signal: lifetime.signal,
                awaitAlive,
                getRichMediaService: () => {
                  const richMedia = service('RichMedia');
                  return {
                    batchGetGroupFileCount: (groups) =>
                      call(richMedia, 'batchGetGroupFileCount', groups),
                  };
                },
              },
              captured.groupId,
            );
          }
          case 'deleteGroupFolder':
            return deleteGroupFolder(
              {
                signal: lifetime.signal,
                awaitAlive,
                getRichMediaService: () => {
                  const richMedia = service('RichMedia');
                  return {
                    deleteGroupFolder: (groupId, folderId) =>
                      call(richMedia, 'deleteGroupFolder', groupId, folderId),
                  };
                },
              },
              payload.groupId,
              payload.folderId,
            );
          case 'setGroupName':
            return groupOperations.invokeOperation(method, payload);
          case 'getGroupEssencePage':
          case 'listGroupEssenceMessages': {
            if (!accountId)
              throw new Error('Group essence listing requires the authenticated account identity');
            const signal = requestSignal
              ? AbortSignal.any([lifetime.signal, requestSignal])
              : lifetime.signal;
            signal.throwIfAborted();
            return awaitAlive<unknown>(
              (method === 'getGroupEssencePage' ? getGroupEssencePage : listGroupEssenceMessages)(
                { session: guardedSession, accountId, signal },
                payload.groupId,
                payload.options,
              ),
              signal,
            );
          }
          case 'setGroupEssenceMessage':
            return setGroupEssenceMessage(
              {
                signal: lifetime.signal,
                awaitAlive,
                query: (groupId, messageId) =>
                  queryNativeMessage(service('Msg'), { chatType: 2, peerUid: groupId }, messageId),
                invoke: (name, request) => call(service('Group'), name, request),
              },
              payload.groupId,
              payload.messageId,
              payload.enabled,
            );
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
