import { createFriendCategoryAssignment } from './features/contacts/friend-category-assignment.ts';
import { createFriendCategoryMutations } from './features/contacts/friend-category-mutations.ts';
import { createGroupSearch } from './features/groups/group-search.ts';
import { createGroupFiles } from './features/groups/group-files.ts';
import { GroupFilePageHistory } from './features/groups/group-file-pages.ts';
import { createMessageQueries } from './features/messages/message-queries.ts';
import { withCleanupFailure } from './runtime/cleanup.ts';
import { NativeServiceLifetime } from './runtime/native-service-lifetime.ts';
import { NativeListenerOwner } from './runtime/native-listener-owner.ts';
import type { NativeServiceContext } from './runtime/native-service-context.ts';
import {
  supportsCategoryAssignment,
  supportsCategoryCreation,
  supportsCategoryRenaming,
  supportsCategoryDeletion,
  supportsCategoryReordering,
  supportsGroupFileCount,
  supportsGroupFilePages,
  supportsGroupFolderDeletion,
  supportsGroupFolderCreation,
  supportsGroupSearch,
} from './native/native-contracts.ts';
import { createFriendSystemEvents } from './features/contacts/friend-system-events.ts';
import { createContactDirectory } from './features/contacts/contact-directory.ts';
import { createNativeEventChannel } from './runtime/native-event-channel.ts';
import { createForwardResourceOwner } from './features/forward/forward-resource-owner.ts';
import type { LongMessageResponseService } from './features/forward/long-message-response.ts';
import { queryNativeMessage } from './features/messages/message-query.ts';
import { createSelfProfile } from './features/contacts/self-profile.ts';
import { createGroupWebReads } from './features/groups/group-web-reads.ts';
import { createGroupNotices } from './features/groups/group-notices.ts';
import { createForwardMessages } from './features/forward/forward-messages.ts';
import { createGroupRequests } from './features/groups/group-requests.ts';
import { createFriendRequests } from './features/contacts/friend-requests.ts';
import { createContactOperations } from './features/contacts/contact-operations.ts';
import { createAttachmentDownloads } from './features/media/attachment-downloads.ts';
import { createMessageResolution } from './features/messages/message-resolution.ts';
import { createNativeMessageSender } from './features/messages/native-message-sender.ts';
/** Native contracts extracted from local NapCat; this module never sends at startup. */
import { createGroupOperations } from './features/groups/group-operations.ts';
import { setGroupEssenceMessage } from './features/groups/group-essence.ts';
import { createGroupEvents } from './features/groups/group-events.ts';
import { createGroupQueries } from './features/groups/group-queries.ts';
import { createGroupSystemEvents } from './features/groups/group-system-events.ts';
import { createMessageUpdateEvents } from './features/messages/recall-events.ts';
import { createMessageRecalls } from './features/messages/recall-operation.ts';
import { createIncomingMessageDelivery } from './features/messages/incoming-message-delivery.ts';
import { sendGroupId } from './validation/identifiers.ts';

import type { NativeObject as Native } from './native/native-object.ts';
import type { NativeMessage } from './native/message-contracts.ts';
export type { NativePeer, NativeMessage } from './native/message-contracts.ts';
import type { ServiceOperation } from './runtime/operations.ts';
export type { ServiceOperation } from './runtime/operations.ts';

// Callback tokens belong to the native worker, including account replacements.
// Only process recreation releases reservations; feature owners keep request state.
const groupFilePageHistory = new GroupFilePageHistory();

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
    const messageUpdateEvents = own(
      createMessageUpdateEvents({
        emit,
        dispatchUpdates: (rows) => dispatch('Msg/onMsgInfoListUpdate', [rows]),
        isClosed: () => lifetime.closed,
      }),
    );
    const { call, awaitAlive } = lifetime;
    const service = (name: string): Native => call(guardedSession, `get${name}Service`) as Native;
    const groupWebReads = createGroupWebReads({
      accountId,
      signal: lifetime.signal,
      getTicketService: () => service('Ticket'),
      getTipOffService: () => service('TipOff'),
      awaitAlive,
    });
    const categoryMutations = own(
      createFriendCategoryMutations({
        signal: lifetime.signal,
        getBuddyService: () => service('Buddy'),
        canCreate: () => supportsCategoryCreation(nativeContracts, version),
        canRename: () => supportsCategoryRenaming(nativeContracts, version),
        canDelete: () => supportsCategoryDeletion(nativeContracts, version),
        canReorder: () => supportsCategoryReordering(nativeContracts, version),
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
    const categoryAssignment = own(
      createFriendCategoryAssignment({
        signal: lifetime.signal,
        canAssign: () => supportsCategoryAssignment(nativeContracts, version),
        resolveUid: uidFor,
        awaitAlive,
        getBuddyService: () => service('Buddy'),
      }),
    );
    const messageResolution = createMessageResolution({
      signal: lifetime.signal,
      resolveUid: uidFor,
      getIdentityService: () => ({ getUin: (uids) => call(service('UixConvert'), 'getUin', uids) }),
      diagnostic: (stage) => {
        if (!lifetime.closed) emit('diagnostic', { stage });
      },
    });
    const {
      resolvePeer,
      resolveMessages: resolvedMessages,
      resolveMessage: resolvedMessage,
    } = messageResolution;
    const messageRecalls = own(
      createMessageRecalls({
        signal: lifetime.signal,
        resolvePeer,
        awaitAlive,
        getMessageService: () => service('Msg'),
        eventCall,
      }),
    );
    const attachmentDownloads = own(
      createAttachmentDownloads({
        signal: lifetime.signal,
        resolvePeer,
        awaitAlive,
        getMessageService: () => service('Msg'),
        eventCall,
      }),
    );
    const incomingMessages = own(
      createIncomingMessageDelivery({
        resolveMessages: (messages, rawMessages, signal) =>
          resolvedMessages(messages, rawMessages, true, signal),
        project: messageResolution.projectImmediate,
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
    let receiveGroupFileInfo: (value: unknown) => void = () => {};
    listener('Msg', {
      onGroupFileInfoUpdate: (value: unknown) => {
        receiveGroupFileInfo(value);
        dispatch('Msg/onGroupFileInfoUpdate', [value]);
      },
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
      onMsgInfoListUpdate: messageUpdateEvents.onMessageUpdates,
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
        supportsSearch: () => supportsGroupSearch(nativeContracts, version),
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
    const forwardResources = createForwardResourceOwner({
      selfUid: accountUid ?? '',
      signal: lifetime.signal,
      resolvePeer,
      getMessageService: () => service('Msg') as LongMessageResponseService,
      sendPrepared: (peer, elements, onDispatch) => sender.sendPrepared(peer, elements, onDispatch),
      defer: (cleanup) => lifetime.defer(cleanup),
    });
    const groupFiles = own(
      createGroupFiles({
        signal: lifetime.signal,
        awaitAlive,
        supportsFileCount: () => supportsGroupFileCount(nativeContracts, version),
        supportsFilePage: () => supportsGroupFilePages(nativeContracts, version),
        history: groupFilePageHistory,
        getFilePageService: () => service('RichMedia'),
        supportsFolderCreation: () => supportsGroupFolderCreation(nativeContracts, version),
        supportsFolderDeletion: () => supportsGroupFolderDeletion(nativeContracts, version),
        getFileCountService: () => {
          const richMedia = service('RichMedia');
          return {
            batchGetGroupFileCount: (groups) => call(richMedia, 'batchGetGroupFileCount', groups),
          };
        },
        getFolderCreationService: () => {
          const richMedia = service('RichMedia');
          return {
            createGroupFolder: (groupId, name) =>
              call(richMedia, 'createGroupFolder', groupId, name),
          };
        },
        getFolderDeletionService: () => {
          const richMedia = service('RichMedia');
          return {
            deleteGroupFolder: (groupId, folderId) =>
              call(richMedia, 'deleteGroupFolder', groupId, folderId),
          };
        },
      }),
    );
    receiveGroupFileInfo = groupFiles.receiveFileInfo;
    return {
      async invokeOperation(
        method: ServiceOperation,
        payload: Record<string, unknown> = {},
        requestSignal?: AbortSignal,
      ): Promise<unknown> {
        if (lifetime.closed) throw new Error('Native services are closed');
        switch (method) {
          case 'setFriendCategory':
            return categoryAssignment.assign(payload.userId, payload.categoryId);
          case 'renameFriendCategory': {
            return categoryMutations.rename(payload.categoryId, payload.name);
          }
          case 'deleteFriendCategory':
            return categoryMutations.delete(payload.categoryId);
          case 'reorderFriendCategories':
            return categoryMutations.reorder(payload.categories);
          case 'addFriendCategory':
            return categoryMutations.create(payload.name);
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
          case 'sendPrivateMessage':
            return sender.sendPrivateMessage(payload.userId, payload.message);
          case 'sendGroupMessage':
            return sender.sendGroupMessage(payload.groupId, payload.message);
          case 'sendMergedForward':
            return forwardResources.sendMerged(payload.peer, payload.nodes, payload.options);
          case 'getForwardResource':
            return forwardResources.readResource(payload.resourceId);
          case 'getMessage':
            return messageQueries.getMessage(payload.peer, payload.messageId);
          case 'getMessages':
            return messageQueries.getMessages(payload.peer, payload.messageIds);
          case 'getHistory':
            return messageQueries.getHistory(payload.peer, payload.options);
          case 'downloadAttachment':
            return attachmentDownloads.download(payload, requestSignal);
          case 'recallMessage':
            return messageRecalls.recall(payload);
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
          case 'searchGroup':
            return groupSearch.searchGroup(payload.groupId);
          case 'getGroupFileCount':
            return groupFiles.getGroupFileCount(payload.groupId);
          case 'getGroupFilePage':
            return awaitAlive(
              groupFiles.getGroupFilePage(payload.groupId, payload.options, requestSignal),
              requestSignal,
            );
          case 'listGroupFiles':
            return awaitAlive(
              groupFiles.listGroupFiles(payload.groupId, payload.options, requestSignal),
              requestSignal,
            );
          case 'createGroupFolder':
            return groupFiles.createGroupFolder(payload.groupId, payload.name);
          case 'deleteGroupFolder':
            return groupFiles.deleteGroupFolder(payload.groupId, payload.folderId);
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
