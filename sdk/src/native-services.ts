import { createFriendCategoryRename } from './features/contacts/friend-category-rename.ts';
import { captureGroupSearch } from './features/groups/group-search-input.ts';
import { createGroupSearch } from './features/groups/group-search.ts';
import {
  captureCreateGroupFolder,
  captureDeleteGroupFolder,
  captureGroupFileCount,
} from './features/groups/group-file-input.ts';
import {
  createGroupFolder,
  deleteGroupFolder,
  getGroupFileCount,
} from './features/groups/group-file-operations.ts';
import { captureMergedForward } from './features/forward/merged-forward-input.ts';
import { captureDownloadPayload } from './features/media/download-input.ts';
import { createMessageQueries } from './features/messages/message-queries.ts';
import { withCleanupFailure } from './runtime/cleanup.ts';
import { NativeServiceLifetime } from './runtime/native-service-lifetime.ts';
import { NativeListenerOwner } from './runtime/native-listener-owner.ts';
import type { NativeServiceContext } from './runtime/native-service-context.ts';
import {
  supportsCategoryCreation,
  supportsCategoryRenaming,
  supportsGroupFileCount,
  supportsGroupFolderDeletion,
  supportsGroupFolderCreation,
  supportsGroupSearch,
} from './native/native-contracts.ts';
import { createFriendCategory } from './features/contacts/friend-category-create.ts';
import { createFriendSystemEvents } from './features/contacts/friend-system-events.ts';
import {
  friendCategoryName,
  captureRenameFriendCategory,
} from './features/contacts/friend-categories.ts';
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
import { createGroupWebReads } from './features/groups/group-web-reads.ts';
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
import { setGroupEssenceMessage } from './features/groups/group-essence.ts';
import { createGroupEvents } from './features/groups/group-events.ts';
import { createGroupQueries } from './features/groups/group-queries.ts';
import { createGroupSystemEvents } from './features/groups/group-system-events.ts';
import { createRecallEvents } from './features/messages/recall-events.ts';
import { recallMessage } from './features/messages/recall-operation.ts';
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
  // Retained until worker exit: listener removal ABIs are not verified.
  let listenerOwner: NativeListenerOwner | undefined;
  const own = <T extends { close(): void }>(resource: T): T => lifetime.own(resource);
  const close = () => {
    // Removal ABIs are not verified for these listeners. Retain native callback
    // objects for the worker lifetime; callbacks consult the closed Session.
    void listenerOwner;
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
    const groupWebReads = createGroupWebReads({
      accountId,
      signal: lifetime.signal,
      getTicketService: () => service('Ticket'),
      getTipOffService: () => service('TipOff'),
      awaitAlive,
    });
    const categoryRename = own(
      createFriendCategoryRename({
        signal: lifetime.signal,
        getBuddyService: () => service('Buddy'),
      }),
    );
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
    const callbacks = (listenerOwner = new NativeListenerOwner({
      isClosed: () => lifetime.closed,
      auditCallback,
      dispatch,
    }));
    const listener = (
      family: string,
      overrides: Native,
      acquired?: Native,
      retainBeforeAdd = false,
    ) => {
      callbacks.register({
        family,
        overrides,
        retainBeforeAdd,
        add: (target) => call(acquired ?? service(family), `addKernel${family}Listener`, target),
      });
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
    let searchRegistrationAttempted = false;
    let searchHandle: Native | undefined;
    const groupSearch = own(
      createGroupSearch({
        signal: lifetime.signal,
        awaitAlive,
        eventCall,
        getSearchService: () => {
          if (!searchRegistrationAttempted) {
            const search = service('Search');
            lifetime.signal.throwIfAborted();
            searchHandle = search;
            searchRegistrationAttempted = true;
            listener('Search', {}, search, true);
            lifetime.signal.throwIfAborted();
          }
          return searchHandle;
        },
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
          case 'renameFriendCategory': {
            const captured = captureRenameFriendCategory(payload.categoryId, payload.name);
            if (!supportsCategoryRenaming(nativeContracts, version))
              throw Object.assign(
                new Error('Friend category rename contract is not verified for this native binary'),
                { code: 'unsupported-native-contract' },
              );
            return categoryRename.rename(captured.categoryId, captured.name);
          }
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
          case 'recallMessage':
            return recallMessage(
              {
                resolvePeer,
                eventCall,
                getMessageService: () => {
                  const messageService = service('Msg');
                  return {
                    recallMsg: (peer, ids) => call(messageService, 'recallMsg', peer, ids),
                  };
                },
              },
              payload.peer,
              () => payload.messageId,
            );
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
            return groupWebReads.listGroupNotices(payload.groupId, requestSignal);
          case 'publishGroupNotice':
          case 'deleteGroupNotice':
            return groupNotices.invokeOperation(method, payload);
          case 'searchGroup': {
            const group = captureGroupSearch(payload.groupId);
            if (!supportsGroupSearch(nativeContracts, version))
              throw Object.assign(
                new Error('Group search contract is not verified for this native binary'),
                { code: 'unsupported-native-contract' },
              );
            return groupSearch.searchGroup(group);
          }
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
          case 'createGroupFolder': {
            const captured = captureCreateGroupFolder(payload.groupId, payload.name);
            if (!supportsGroupFolderCreation(nativeContracts, version))
              throw Object.assign(
                new Error('Group folder creation contract is not verified for this native binary'),
                { code: 'unsupported-native-contract' },
              );
            return createGroupFolder(
              {
                signal: lifetime.signal,
                awaitAlive,
                getRichMediaService: () => {
                  const richMedia = service('RichMedia');
                  return {
                    createGroupFolder: (groupId, name) =>
                      call(richMedia, 'createGroupFolder', groupId, name),
                  };
                },
              },
              captured.groupId,
              captured.name,
            );
          }
          case 'deleteGroupFolder': {
            const captured = captureDeleteGroupFolder(payload.groupId, payload.folderId);
            if (!supportsGroupFolderDeletion(nativeContracts, version))
              throw Object.assign(
                new Error('Group folder deletion contract is not verified for this native binary'),
                { code: 'unsupported-native-contract' },
              );
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
              captured.groupId,
              captured.folderId,
            );
          }
          case 'setGroupName':
            return groupOperations.invokeOperation(method, payload);
          case 'getGroupEssencePage':
            return groupWebReads.getGroupEssencePage(
              payload.groupId,
              payload.options,
              requestSignal,
            );
          case 'listGroupEssenceMessages':
            return groupWebReads.listGroupEssenceMessages(
              payload.groupId,
              payload.options,
              requestSignal,
            );
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
