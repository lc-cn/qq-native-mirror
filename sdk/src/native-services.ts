import {
  createFriendCategoryAssignment,
  type FriendCategoryAssignmentContext,
} from './features/contacts/friend-category-assignment.ts';
import {
  createFriendCategoryMutations,
  type FriendCategoryMutationsContext,
} from './features/contacts/friend-category-mutations.ts';
import { createGroupSearch, type GroupSearchContext } from './features/groups/group-search.ts';
import { createGroupFiles, type GroupFilesContext } from './features/groups/group-files.ts';
import { GroupFilePageHistory } from './features/groups/group-file-pages.ts';
import {
  createMessageQueries,
  type MessageQueriesContext,
} from './features/messages/message-queries.ts';
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
  supportsGroupFileDeletion,
  supportsGroupFolderCreation,
  supportsGroupSearch,
} from './native/native-contracts.ts';
import { createFriendSystemEvents } from './features/contacts/friend-system-events.ts';
import {
  createContactDirectory,
  type ContactDirectoryContext,
} from './features/contacts/contact-directory.ts';
import { createNativeEventChannel } from './runtime/native-event-channel.ts';
import { createForwardResourceOwner } from './features/forward/forward-resource-owner.ts';
import type { LongMessageResponseService } from './features/forward/long-message-response.ts';
import { createSelfProfile, type SelfProfileContext } from './features/contacts/self-profile.ts';
import {
  createGroupWebReads,
  type GroupWebReadsContext,
} from './features/groups/group-web-reads.ts';
import { createGroupNotices, type GroupNoticesContext } from './features/groups/group-notices.ts';
import {
  createForwardMessages,
  type ForwardMessagesContext,
} from './features/forward/forward-messages.ts';
import {
  createGroupRequests,
  type GroupRequestsContext,
} from './features/groups/group-requests.ts';
import {
  createFriendRequests,
  type FriendRequestsContext,
} from './features/contacts/friend-requests.ts';
import {
  createContactOperations,
  type ContactOperationsContext,
} from './features/contacts/contact-operations.ts';
import {
  createAttachmentDownloads,
  type AttachmentDownloadsContext,
} from './features/media/attachment-downloads.ts';
import {
  createMessageResolution,
  type MessageResolutionContext,
} from './features/messages/message-resolution.ts';
import {
  createNativeMessageSender,
  type NativeMessageSenderContext,
} from './features/messages/native-message-sender.ts';
/** Native contracts extracted from local NapCat; this module never sends at startup. */
import {
  createGroupOperations,
  type GroupOperationsContext,
} from './features/groups/group-operations.ts';
import {
  createGroupEssenceMutations,
  type GroupEssenceMutationContext,
} from './features/groups/group-essence.ts';
import { createGroupEventIngress } from './features/groups/group-events.ts';
import { createGroupQueries, type GroupQueriesContext } from './features/groups/group-queries.ts';
import { createGroupSystemEvents } from './features/groups/group-system-events.ts';
import { createMessageUpdateEvents } from './features/messages/recall-events.ts';
import { createMessageRecalls, type RecallContext } from './features/messages/recall-operation.ts';
import { createIncomingMessageDelivery } from './features/messages/incoming-message-delivery.ts';

import type { NativeObject as Native } from './native/native-object.ts';
export type { NativePeer } from './native/message-contracts.ts';
import type { ServiceOperation } from './runtime/operations.ts';
export type { ServiceOperation } from './runtime/operations.ts';

type ServicePort<Factory extends () => unknown> = NonNullable<ReturnType<Factory>>;
type EssenceMethod = Parameters<GroupEssenceMutationContext['invoke']>[0];
type EssenceRequest = Parameters<GroupEssenceMutationContext['invoke']>[1];

/** Internal caller contracts for the services this composition actually binds.
 * Reuse domain ports instead of declaring a second native ABI. Their results
 * remain unknown and optional methods stay optional. NativeServiceLifetime and
 * the domain owners still check runtime availability, cancellation and results.
 */
export interface NativeServicePorts {
  Buddy: ServicePort<ContactDirectoryContext['getBuddyService']> &
    ServicePort<FriendCategoryAssignmentContext['getBuddyService']> &
    ServicePort<FriendCategoryMutationsContext['getBuddyService']> &
    ServicePort<FriendRequestsContext['getBuddyService']> &
    ServicePort<ContactOperationsContext['getBuddyService']>;
  Profile: ServicePort<ContactDirectoryContext['getProfileService']> &
    ServicePort<ContactOperationsContext['getProfileService']> &
    ServicePort<SelfProfileContext['getProfileService']>;
  UixConvert: ServicePort<ContactDirectoryContext['getUidService']> &
    ServicePort<MessageResolutionContext['getIdentityService']>;
  Msg: ServicePort<NativeMessageSenderContext['getMessageService']> &
    ServicePort<MessageQueriesContext['getMessageService']> &
    ServicePort<RecallContext['getMessageService']> &
    ServicePort<AttachmentDownloadsContext['getMessageService']> &
    ServicePort<ForwardMessagesContext['getMessageService']> &
    ServicePort<GroupEssenceMutationContext['getMessageService']> &
    LongMessageResponseService;
  Group: ServicePort<GroupQueriesContext['getGroupService']> &
    ServicePort<GroupRequestsContext['getGroupService']> &
    ServicePort<GroupNoticesContext['getGroupService']> &
    ServicePort<GroupOperationsContext['getGroupService']> & {
      [Method in EssenceMethod]: (request: EssenceRequest) => unknown;
    };
  MSF: ServicePort<NativeMessageSenderContext['getServerTimeService']>;
  Search: ServicePort<GroupSearchContext['getSearchService']>;
  Ticket: ServicePort<GroupWebReadsContext['getTicketService']>;
  TipOff: ServicePort<GroupWebReadsContext['getTipOffService']> &
    ServicePort<GroupNoticesContext['getTipOffService']>;
  RichMedia: ServicePort<NonNullable<GroupFilesContext['getFilePageService']>> &
    ServicePort<GroupFilesContext['getFileCountService']> &
    ServicePort<GroupFilesContext['getFolderCreationService']> &
    ServicePort<GroupFilesContext['getFolderDeletionService']> &
    ServicePort<NonNullable<GroupFilesContext['getFileDeletionService']>>;
}
type ListenerFamily = 'Msg' | 'Group' | 'Search';
type PortMethod<Port> = string extends keyof Port
  ? never
  : Extract<
      {
        [Name in keyof Port]-?: NonNullable<Port[Name]> extends (...args: never[]) => unknown
          ? Name
          : never;
      }[keyof Port],
      string
    >;
type PortArguments<Port, Method extends keyof Port> =
  NonNullable<Port[Method]> extends (...args: infer Arguments) => unknown ? Arguments : never;

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
    // Known business bindings keep method and argument tuples correlated.
    // The runtime guard still captures once and dispatches with the native receiver.
    const callPort = <Port extends object, Method extends PortMethod<Port>>(
      target: Port,
      name: Method,
      ...args: PortArguments<Port, Method>
    ): unknown => call(target, name, ...args);
    // The only assertion for acquired services: native handles are opaque, while
    // callers must satisfy the closed family-specific SDK port contract.
    const service = <Family extends keyof NativeServicePorts>(
      name: Family,
    ): NativeServicePorts[Family] =>
      call(guardedSession, `get${name}Service`) as NativeServicePorts[Family];
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
      getIdentityService: () => ({
        getUin: (uids) => callPort(service('UixConvert'), 'getUin', uids),
      }),
      diagnostic: (stage) => {
        if (!lifetime.closed) emit('diagnostic', { stage });
      },
    });
    const { resolvePeer, resolveMessages: resolvedMessages } = messageResolution;
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
        getSystemMessageHandlers: () => [
          {
            hasCandidate: (batch) => groupSystemEvents.hasMuteCandidate(batch),
            receive: (batch) => groupSystemEvents.onRecvMsg(batch),
          },
          {
            hasCandidate: (batch) => friendSystemEvents.hasAddedCandidate(batch),
            receive: (batch) => friendSystemEvents.onRecvMsg(batch),
          },
        ],
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
      family: ListenerFamily,
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
      onRecvMsg: incomingMessages.receive,
      onMsgInfoListUpdate: messageUpdateEvents.onMessageUpdates,
      onKickedOffLine: (...args: unknown[]) => {
        if (!lifetime.closed) emit('kicked', { info: args[0], args });
      },
    });
    const groupEvents = createGroupEventIngress({
      emit,
      dispatchList: (kind, groups) => dispatch('Group/onGroupListUpdate', [kind, groups]),
      dispatchDetail: (value) => dispatch('Group/onGroupDetailInfoChange', [value]),
      traceEnabled: () => process.env.QQ_NATIVE_TRACE_FIELDS === '1',
    });
    listener('Group', groupEvents);
    const groupQueries = own(
      createGroupQueries({
        signal: lifetime.signal,
        getGroupService: () => service('Group'),
        eventCall,
        awaitAlive,
        commitMembers: directory.rememberMembers,
      }),
    );
    const groupSearch = own(
      createGroupSearch({
        supportsSearch: () => supportsGroupSearch(nativeContracts, version),
        signal: lifetime.signal,
        awaitAlive,
        eventCall,
        getSearchService: () => service('Search'),
        registerSearchListener: (search) => listener('Search', {}, search, true),
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
    const groupEssence = createGroupEssenceMutations({
      signal: lifetime.signal,
      awaitAlive,
      getMessageService: () => service('Msg'),
      invoke: (name, request) => callPort(service('Group'), name, request),
    });
    const forwardMessages = own(
      createForwardMessages({
        getMessageService: () => service('Msg'),
        resolvePeer,
        decodeMessage: async (message, raw) => (await resolvedMessages([message], [raw]))[0],
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
      decode: (messages) =>
        resolvedMessages(
          messages.map((message) => message.message),
          messages.map((message) => message.raw),
        ),
      awaitAlive,
    });
    const forwardResources = createForwardResourceOwner({
      selfUid: accountUid ?? '',
      signal: lifetime.signal,
      resolvePeer,
      getMessageService: () => service('Msg'),
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
        supportsFileDeletion: () => supportsGroupFileDeletion(nativeContracts, version),
        getFileDeletionService: () => {
          const richMedia = service('RichMedia');
          return {
            deleteGroupFile: (groupId, params, files) =>
              callPort(richMedia, 'deleteGroupFile', groupId, params, files),
          };
        },
        getFileCountService: () => {
          const richMedia = service('RichMedia');
          return {
            batchGetGroupFileCount: (groups) =>
              callPort(richMedia, 'batchGetGroupFileCount', groups),
          };
        },
        getFolderCreationService: () => {
          const richMedia = service('RichMedia');
          return {
            createGroupFolder: (groupId, name) =>
              callPort(richMedia, 'createGroupFolder', groupId, name),
          };
        },
        getFolderDeletionService: () => {
          const richMedia = service('RichMedia');
          return {
            deleteGroupFolder: (groupId, folderId) =>
              callPort(richMedia, 'deleteGroupFolder', groupId, folderId),
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
            return groupQueries.listGroupMutedMembers(payload.groupId);
          case 'getGroupInfo':
            return groupQueries.getGroupInfo(payload.groupId);
          case 'listFriendCategories':
            return directory.listFriendCategories();
          case 'listFriends':
            return directory.listFriends();
          case 'listGroups':
            return groupQueries.listGroups(payload.refresh);
          case 'getGroupMembers':
            return groupQueries.getGroupMembers(payload.groupId, payload.refresh);
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
          case 'deleteGroupFile':
            return groupFiles.deleteGroupFile(payload.groupId, payload.fileId);
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
            return groupEssence.setMessage(payload.groupId, payload.messageId, payload.enabled);
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
