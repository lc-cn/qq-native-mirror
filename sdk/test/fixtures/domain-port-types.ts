import type { FriendCategoryAssignmentContext } from '../../src/features/contacts/friend-category-assignment.ts';
import type { FriendCategoryMutationsContext } from '../../src/features/contacts/friend-category-mutations.ts';
import type { NativeServiceLifetime } from '../../src/runtime/native-service-lifetime.ts';
import type { ContactDirectoryContext } from '../../src/features/contacts/contact-directory.ts';
import type { GroupQueriesContext } from '../../src/features/groups/group-queries.ts';
import type { NativeMessageSenderContext } from '../../src/features/messages/native-message-sender.ts';
import type { ContactOperationsContext } from '../../src/features/contacts/contact-operations.ts';
import type { GroupOperationsContext } from '../../src/features/groups/group-operations.ts';
import type { SelfProfileContext } from '../../src/features/contacts/self-profile.ts';
import type { GroupNoticesContext } from '../../src/features/groups/group-notices.ts';
import type { ForwardMessagesContext } from '../../src/features/forward/forward-messages.ts';
import type { ForwardResourceOwnerContext } from '../../src/features/forward/forward-resource-owner.ts';
import type { QunWebReadContext } from '../../src/features/groups/qun-web-read.ts';
import type { WebGroupNoticesContext } from '../../src/features/groups/web-group-notices.ts';
import type { GroupWebReadsContext } from '../../src/features/groups/group-web-reads.ts';
import type {
  GroupRequestsContext,
  GroupRequestListener,
} from '../../src/features/groups/group-requests.ts';
import type {
  FriendRequestsContext,
  FriendBuddyListener,
} from '../../src/features/contacts/friend-requests.ts';

/** Compile-only negative contracts: feature dependencies cannot regain the full
 * native Session, and unchecked native responses must remain unknown.
 */
function verifyDomainPorts(
  contacts: ContactDirectoryContext,
  groups: GroupQueriesContext,
  sender: NativeMessageSenderContext,
  contactActions: ContactOperationsContext,
  groupActions: GroupOperationsContext,
  selfProfile: SelfProfileContext,
  requests: FriendRequestsContext,
  groupRequests: GroupRequestsContext,
  notices: GroupNoticesContext,
  forward: ForwardMessagesContext,
  forwardResources: ForwardResourceOwnerContext,
  webRead: QunWebReadContext,
  noticeRead: WebGroupNoticesContext,
  groupReads: GroupWebReadsContext,
  categoryMutations: FriendCategoryMutationsContext,
  lifetime: NativeServiceLifetime,
) {
  const nativeCompletion = lifetime.call({}, 'method');
  // @ts-expect-error Dispatch does not validate proprietary native receipts.
  void nativeCompletion.result;
  // @ts-expect-error Resource orchestration cannot acquire unrelated Session services.
  forwardResources.getBuddyService();
  // @ts-expect-error The SSO transport cannot submit ordinary messages.
  forwardResources.getMessageService().sendMsg();
  const nativeForwardResponse = forwardResources
    .getMessageService()
    .sendSsoCmdReqByContend('command', Buffer.alloc(0));
  // @ts-expect-error Native resource envelopes require validation by the transport.
  void nativeForwardResponse.rspbuffer;
  // @ts-expect-error A contact directory cannot acquire arbitrary native services.
  contacts.service('Group');
  // @ts-expect-error A group query cannot acquire arbitrary native services.
  groups.service('Profile');
  // @ts-expect-error Sender waits must always carry the owner's cancellation signal.
  sender.awaitAlive(Promise.resolve('fixture'));
  // @ts-expect-error A sender cannot acquire arbitrary native services.
  sender.service('Buddy');
  // @ts-expect-error Contacts do not own message submission.
  contacts.getBuddyService()?.sendMsg();
  // @ts-expect-error Queries cannot mutate group membership.
  groups.getGroupService()?.kickMember();
  // @ts-expect-error The sender does not own the full account composition context.
  void sender.media?.identity;
  // @ts-expect-error Contact actions cannot acquire a full native Session.
  contactActions.getGroupService();
  // @ts-expect-error Contact mutation ports do not own request listeners.
  contactActions.getBuddyService()?.addKernelBuddyListener({});
  // @ts-expect-error Group actions cannot read unrelated profile services.
  groupActions.getProfileService();
  // @ts-expect-error Group mutations cannot turn into group query owners.
  groupActions.getGroupService()?.getAllMemberList('123', false);
  // @ts-expect-error Role mutation arguments retain their native scalar types.
  groupActions.getGroupService()?.modifyMemberRole?.('123', 'u_fixture', 'admin');
  // @ts-expect-error Friend deletion requires explicit native policy booleans.
  contactActions.getBuddyService()?.delBuddy?.({ friendUid: 'u_fixture' });

  const deleted = contactActions.getBuddyService()?.delBuddy?.({
    friendUid: 'u_fixture',
    tempBlock: false,
    tempBothDel: false,
  });
  const renamed = groupActions.getGroupService()?.modifyGroupName?.('123', 'name', false);
  // @ts-expect-error Mutation completion must be validated before accessing status.
  void deleted.result;
  // @ts-expect-error A group mutation response is still unknown at its port.
  void renamed.result;
  // @ts-expect-error Profile updates do not own the complete native Session.
  selfProfile.getBuddyService();
  // @ts-expect-error Profile updates cannot send messages.
  selfProfile.getProfileService()?.sendMsg();
  // @ts-expect-error Request handling cannot acquire arbitrary native services.
  requests.service('Group');
  // @ts-expect-error Request handling does not own friend deletion.
  requests.getBuddyService()?.delBuddy({});
  const requested = requests.getBuddyService()?.getBuddyReq?.();
  const fetched = selfProfile
    .getProfileService()
    ?.fetchUserDetailInfo?.('BuddyProfileStore', ['self'], 1, [0]);
  requests.getBuddyService()?.approvalFriendRequest?.({
    friendUid: 'u_fixture',
    reqTime: '1',
    // @ts-expect-error Approval requires an explicit boolean, not truthy coercion.
    accept: 'yes',
  });
  // @ts-expect-error Native request results require validation.
  void requested.result;
  // @ts-expect-error Profile fetch completion does not establish a validated detail.
  void fetched.simpleInfo;
  // @ts-expect-error Buddy registration requires both owned callback entry points.
  const incompleteListener: FriendBuddyListener = { onBuddyReqChange() {} };
  void incompleteListener;
  // @ts-expect-error Group applications cannot acquire profile services.
  groupRequests.getProfileService();
  // @ts-expect-error Group applications do not own membership mutations.
  groupRequests.getGroupService()?.kickMember('123', ['u_fixture'], false, '');
  // @ts-expect-error Both application notification entry points are required.
  const incompleteGroupListener: GroupRequestListener = { onGroupNotifiesUpdated() {} };
  void incompleteGroupListener;
  // @ts-expect-error Bulletin operations cannot acquire unrelated native services.
  notices.getProfileService();
  // @ts-expect-error The bulletin port cannot change group membership.
  notices.getGroupService()?.kickMember('123', ['u_fixture'], false, '');
  // @ts-expect-error The ticket port cannot submit messages.
  notices.getTipOffService()?.sendMsg();
  // @ts-expect-error Ticket refresh uses a native boolean.
  notices.getTipOffService()?.getPskey?.(['qun.qq.com'], 'true');
  const ticket = notices.getTipOffService()?.getPskey?.(['qun.qq.com'], true);
  const bulletin = notices.getGroupService()?.deleteGroupBulletin?.('123', 'private-key', 'id');
  // @ts-expect-error Ticket maps require native result validation.
  ticket.domainPskeyMap.get('qun.qq.com');
  // @ts-expect-error Deletion completion remains unknown until validated.
  void bulletin.result;
  // @ts-expect-error Forwarding cannot acquire arbitrary account services.
  forward.getGroupService();
  // @ts-expect-error The forward port cannot submit a new message.
  forward.getMessageService()?.sendMsg();
  const forwarded = forward
    .getMessageService()
    ?.forwardMsg?.(
      ['1'],
      { chatType: 2, peerUid: '123' },
      [{ chatType: 2, peerUid: '456' }],
      new Map(),
    );
  // @ts-expect-error Forward acknowledgements require result validation.
  void forwarded.result;
  // @ts-expect-error HTTP group reads cannot acquire arbitrary account services.
  webRead.getGroupService();
  // @ts-expect-error Read orchestration has no arbitrary native service locator.
  groupReads.service('Group');
  // @ts-expect-error A request cannot close its account or sibling reads.
  groupReads.close();
  // @ts-expect-error Category rename does not own friend removal.
  categoryMutations.getBuddyService()?.delBuddy();
  // @ts-expect-error Native selectors are numbers, not category names or decimal strings.
  categoryMutations.getBuddyService()?.renameCategory?.('123', 'name');
  const renameAck = categoryMutations.getBuddyService()?.renameCategory?.(123, 'name');
  // @ts-expect-error Delete uses a numeric native selector, not a category name.
  categoryMutations.getBuddyService()?.delCategory?.('name');
  const deleteAck = categoryMutations.getBuddyService()?.delCategory?.(123);
  // @ts-expect-error Creation always passes an explicit second undefined argument.
  categoryMutations.getBuddyService()?.addCategoryV2?.('name');
  // @ts-expect-error UID-array encoding is not established by the creation contract.
  categoryMutations.getBuddyService()?.addCategoryV2?.('name', ['u_fixture']);
  const creationAck = categoryMutations.getBuddyService()?.addCategoryV2?.('name', undefined);
  // @ts-expect-error Native creation results require dedicated receipt projection.
  void creationAck.categoryId;
  // @ts-expect-error Deletion acknowledgement requires result validation.
  void deleteAck.result;
  // @ts-expect-error A native ACK remains unknown until the domain adapter validates it.
  void renameAck.result;
  // @ts-expect-error Group reads cannot dispatch message mutations.
  groupReads.getTicketService()?.sendMsg();
  // @ts-expect-error Client tickets cannot turn into message submission.
  webRead.getTicketService()?.sendMsg();
  // @ts-expect-error Domain-key acquisition keeps an explicit native boolean.
  webRead.getTipOffService()?.getPskey?.(['qun.qq.com'], 'true');
  const webTicket = webRead.getTicketService()?.forceFetchClientKey?.('');
  // @ts-expect-error Client ticket responses remain unknown until sanitized validation.
  void webTicket.clientKey;
  // @ts-expect-error Notice projection cannot acquire native tickets.
  noticeRead.getTicketService();
  // @ts-expect-error A fixed notice reader cannot select an unrelated endpoint.
  noticeRead.readPage('essence', new URLSearchParams());
  // @ts-expect-error Native reads require an exact conversation descriptor.
  forward.getMessageService()?.getMultiMsg?.({ type: 'group', groupId: '123' }, '1', '1');
  // @ts-expect-error Query doubt must retain its native boolean type.
  groupRequests.getGroupService()?.getSingleScreenNotifies?.('false', '', 20);
  const groupPage = groupRequests.getGroupService()?.getSingleScreenNotifies?.(false, '', 20);
  // @ts-expect-error Native group page completion requires validation.
  void groupPage.result;
  groupRequests.getGroupService()?.operateSysNotify?.(false, {
    // @ts-expect-error Native decisions are explicit accept/reject codes.
    operateType: 3,
    targetMsg: { seq: '1', type: 7, groupCode: '123', postscript: ' ' },
  });

  const buddy = contacts.getBuddyService()?.getBuddyListV2?.('0', true, 0);
  const profile = contacts.getProfileService()?.getCoreAndBaseInfo?.('nodeStore', ['u_fixture']);
  const uid = contacts.getUidService()?.getUid?.(['123']);
  const members = groups.getGroupService()?.getAllMemberList?.('123', false);
  const generated = sender.getMessageService()?.generateMsgUniqueId?.(2, '100');
  // @ts-expect-error Native buddy data requires validation before property access.
  void buddy.result;
  // @ts-expect-error Native profiles are not a validated map yet.
  profile.get('u_fixture');
  // @ts-expect-error Native UID data requires validation before property access.
  void uid.uidInfo;
  // @ts-expect-error Native member data requires validation before property access.
  void members.result;
  // @ts-expect-error A generated native ID is not a string until validated.
  generated.trim();
}
void verifyDomainPorts;

import type { MessageQueriesContext } from '../../src/features/messages/message-queries.ts';
function verifyMessageQueryPort(context: MessageQueriesContext) {
  const service = context.getMessageService();
  // @ts-expect-error Queries cannot send messages through their port.
  service?.sendMsg({}, [], '');
  // @ts-expect-error The query owner has no arbitrary service lookup.
  context.service('Msg');
  const result = service?.getMsgsByMsgId?.({ chatType: 2, peerUid: '123' }, ['1']);
  // @ts-expect-error Native responses remain unknown until validated.
  void result.result;
  // @ts-expect-error Native query chat types are limited to private and group.
  service?.getMsgsByMsgId?.({ chatType: 3, peerUid: '123' }, ['1']);
}
void verifyMessageQueryPort;

import type { GroupSearchContext } from '../../src/features/groups/group-search.ts';
function verifyGroupSearchPort(context: GroupSearchContext) {
  const service = context.getSearchService();
  // @ts-expect-error Search cannot mutate membership through its port.
  service?.addGroup('123');
  // @ts-expect-error Native callback retention belongs to the registration port.
  service?.addKernelSearchListener({});
  // @ts-expect-error Registration accepts the Search port, not a service name.
  context.registerSearchListener('Search');
  // @ts-expect-error Search has no arbitrary service acquisition.
  context.service('Group');
  const result = service?.searchGroup?.({
    keyWords: '123',
    groupNum: 25,
    exactSearch: false,
    penetrate: '',
  });
  // @ts-expect-error Native acknowledgement is unknown until validated.
  void result.result;
}
void verifyGroupSearchPort;

import type { GroupFolderCreationContext } from '../../src/features/groups/files/group-file-operations.ts';
function verifyGroupFolderCreationPort(context: GroupFolderCreationContext) {
  const service = context.getRichMediaService();
  // @ts-expect-error Folder creation cannot delete files through its port.
  service.deleteGroupFile('123', ['102'], ['file']);
  // @ts-expect-error Folder creation has no arbitrary native service lookup.
  context.service('Buddy');
  const result = service.createGroupFolder('123', 'files');
  // @ts-expect-error Creation responses are unknown until validated.
  void result.resultWithGroupItem;
}
void verifyGroupFolderCreationPort;

import type { RecallContext } from '../../src/features/messages/recall-operation.ts';
function verifyRecallPort(context: RecallContext) {
  // @ts-expect-error Recall cannot acquire arbitrary native services.
  context.service('Buddy');
  const service = context.getMessageService();
  if (!service) throw new Error('Compile-only recall port fixture');
  // @ts-expect-error Recall does not own message submission or a second listener.
  service.sendMsg({}, [], '');
  // @ts-expect-error Recall cannot register an independent Session listener.
  service.addKernelMsgListener({});
  const returned = service?.recallMsg?.({ chatType: 2, peerUid: '123' }, ['42']);
  // @ts-expect-error Recipient waits must carry this recall owner's lifetime.
  context.awaitAlive(Promise.resolve({ chatType: 2, peerUid: '123' }));
  // @ts-expect-error Native acknowledgement is unknown before validation.
  void returned.result;
}
void verifyRecallPort;

import type { NativeWorkerBootstrap, WorkerKernel } from '../../src/worker/native-bootstrap.ts';
function verifyWorkerOwnership(owner: NativeWorkerBootstrap, kernel: WorkerKernel) {
  // @ts-expect-error Bootstrap acquisition dependencies are private to the owner.
  owner.dependencies.loadAddon({}, 'unreviewed.node');
  // @ts-expect-error Business callers cannot obtain an unprepared kernel.
  owner.kernel.prepare();
  // @ts-expect-error The worker kernel interface cannot acquire raw Session services.
  kernel.getMsgService();
}
void verifyWorkerOwnership;

import type { CapturedNativeMessage } from '../../src/features/messages/inbound-messages.ts';
import type { IncomingSystemMessagePort } from '../../src/features/messages/incoming-message-delivery.ts';
function verifyIncomingSystemPort(port: IncomingSystemMessagePort) {
  port.hasCandidate([]);
  port.receive([]);
  // @ts-expect-error A system projector cannot acquire an account service.
  port.getMsgService();
  // @ts-expect-error Closing the account is outside this projection port.
  port.close();
}
void verifyIncomingSystemPort;

function verifyCapturedMessage(message: CapturedNativeMessage) {
  // @ts-expect-error Queue consumers cannot replace the captured receipt identity.
  message.msgId = '42';
  // @ts-expect-error Snapshot consumers receive validated strings, not arbitrary native values.
  const invalidTime: number = message.msgTime;
  // @ts-expect-error Unrelated raw members remain with Message.raw, not the delivery snapshot.
  message.nativeHandle.initialize();
  // @ts-expect-error Capturing an envelope does not validate native element bodies.
  void message.elements[0].textElement.content;
  void invalidTime;
}
void verifyCapturedMessage;

import type { MediaStagingPort } from '../../src/runtime/media-contracts.ts';
import type { MessageIdQueryPort } from '../../src/features/messages/message-query.ts';
function verifyElementPreparationPorts(image: MediaStagingPort, reply: MessageIdQueryPort) {
  // @ts-expect-error Image staging cannot send messages.
  image.sendMsg('42', {}, [], new Map());
  // @ts-expect-error Staging requires its exact request object, not a path scalar.
  image.getRichMediaFilePathForGuild?.('/tmp/image.png');
  const staged = image.getRichMediaFilePathForGuild?.({
    md5HexStr: 'hash',
    fileName: 'image.png',
    elementType: 2,
    elementSubType: 0,
    thumbSize: 0,
    needCreate: true,
    downloadType: 1,
    file_uuid: '',
  });
  // @ts-expect-error Native staging returns unknown until validated.
  void staged.path;
  // @ts-expect-error Reply lookup cannot stage images or acquire other services.
  reply.getRichMediaFilePathForGuild({});
  // @ts-expect-error Reply IDs are a string array, not a scalar.
  reply.getMsgsByMsgId?.({ chatType: 2, peerUid: '123' }, '42');
  const queried = reply.getMsgsByMsgId?.({ chatType: 2, peerUid: '123' }, ['42']);
  // @ts-expect-error Native query results must validate before reading message fields.
  void queried.msgList;
}
void verifyElementPreparationPorts;

import type { createRecordElement } from '../../src/features/media/media-record.ts';
import type { createVideoElement } from '../../src/features/media/media-send.ts';
function verifyAudioVideoStagingPorts(
  record: Parameters<typeof createRecordElement>[1],
  video: Parameters<typeof createVideoElement>[1],
) {
  const sharedRecord: MediaStagingPort = record;
  const sharedVideo: MediaStagingPort = video;
  void sharedRecord;
  void sharedVideo;
  // @ts-expect-error Voice preparation cannot submit messages.
  record.sendMsg('42', {}, [], new Map());
  // @ts-expect-error Video preparation cannot query messages.
  video.getMsgsByMsgId({}, ['42']);
  // @ts-expect-error Neither preparation port can acquire unrelated services.
  record.getBuddyService();
  // @ts-expect-error Native cache allocation requires its structured request.
  video.getRichMediaFilePathForGuild?.('path');
  const request = {
    md5HexStr: 'hash',
    fileName: 'media',
    elementType: 4,
    elementSubType: 0,
    thumbSize: 0,
    needCreate: true,
    downloadType: 1,
    file_uuid: '',
  };
  const recordPath = record.getRichMediaFilePathForGuild?.(request);
  const videoPath = video.getRichMediaFilePathForGuild?.(request);
  // @ts-expect-error Voice allocation output remains unknown until validated.
  void recordPath.path;
  // @ts-expect-error Video allocation output remains unknown until validated.
  void videoPath.path;
}
void verifyAudioVideoStagingPorts;

import type { downloadAttachment } from '../../src/features/media/attachment-downloads.ts';
function verifyAttachmentDownloadPort(port: NonNullable<Parameters<typeof downloadAttachment>[0]>) {
  // @ts-expect-error A download cannot send messages or acquire unrelated services.
  port.sendMsg({}, [], '');
  // @ts-expect-error The download port does not expose Session acquisition.
  port.getBuddyService();
  // @ts-expect-error The native method requires the exact structured request.
  port.downloadRichMedia?.('/tmp/file');
  const request = {
    fileModelId: '0',
    downSourceType: 0,
    downloadSourceType: 0,
    triggerType: 1,
    msgId: '9',
    chatType: 2,
    peerUid: '123',
    elementId: '2',
    thumbSize: 0,
    downloadType: 1,
    filePath: '/tmp/staged',
  } satisfies Parameters<NonNullable<typeof port.downloadRichMedia>>[0];
  const result = port.downloadRichMedia?.(request);
  // @ts-expect-error Native return values require validation before field access.
  void result.result;
  // @ts-expect-error Downloads accept only private and group native peers.
  port.downloadRichMedia?.({ ...request, chatType: 3 });
  // @ts-expect-error Current native download mode is the measured numeric literal.
  port.downloadRichMedia?.({ ...request, downloadType: '1' });
}
void verifyAttachmentDownloadPort;

import type { faceElement } from '../../src/features/messages/face-input.ts';
import type {
  createImageElement,
  createFileElement,
  createReplyElement,
} from '../../src/features/messages/outbound-elements.ts';
import type { PreparedMessageElement } from '../../src/native/prepared-message-contracts.ts';
import type { buildMergedForwardCard } from '../../src/features/forward/merged-forward-card.ts';
import type { MessageSendPort } from '../../src/features/messages/native-message-sender.ts';
function verifyPreparedElementResults(
  face: ReturnType<typeof faceElement>,
  image: Awaited<ReturnType<typeof createImageElement>>,
  file: Awaited<ReturnType<typeof createFileElement>>,
  reply: Awaited<ReturnType<typeof createReplyElement>>,
  record: Awaited<ReturnType<typeof createRecordElement>>,
  video: Awaited<ReturnType<typeof createVideoElement>>,
) {
  // @ts-expect-error Locally constructed elements cannot expose native services.
  face.getBuddyService();
  // @ts-expect-error A prepared face index is a number, not an unchecked native value.
  face.faceElement.faceIndex = '14';
  // @ts-expect-error Prepared image paths retain their verified string type.
  image.picElement.sourcePath = 42;
  // @ts-expect-error Ordinary file builders do not select an arbitrary folder.
  file.fileElement.folderId = 'folder';
  // @ts-expect-error Reply receipt fields have been validated as strings.
  reply.replyElement.senderUin = 42;
  // @ts-expect-error Record builders return measured numeric durations.
  record.pttElement.duration = '1';
  // @ts-expect-error Video thumbnails remain a Map, not an untyped path dictionary.
  video.videoElement.thumbPath[0] = '/tmp/thumbnail';
  const elements: PreparedMessageElement[] = [face, image, file, reply, record, video];
  for (const element of elements) {
    if (element.elementType === 6) {
      const id: number = element.faceElement.faceIndex;
      void id;
    }
    // @ts-expect-error Variant fields require discriminant narrowing.
    void element.faceElement.faceIndex;
  }
  // @ts-expect-error A face envelope cannot masquerade as an image variant.
  const mismatched: PreparedMessageElement = { ...face, elementType: 2 };
  void mismatched;
}
void verifyPreparedElementResults;

function verifyPreparedSubmission(
  service: MessageSendPort,
  card: ReturnType<typeof buildMergedForwardCard>,
  ordinary: PreparedMessageElement,
) {
  const destination = { chatType: 2 as const, peerUid: '123', guildId: 'fixture' };
  service.sendMsg?.('0', destination, [ordinary, card], new Map());
  // @ts-expect-error Raw public inputs cannot enter the prepared native submission port.
  service.sendMsg?.('0', destination, [{ type: 'text', text: 'fixture' }], new Map());
  // @ts-expect-error Native submission accepts only envelopes constructed by the SDK.
  service.sendMsg?.('0', destination, [{ elementType: 99, elementId: '' }], new Map());
  // @ts-expect-error Forward cards are not an ordinary message builder variant.
  const ordinaryCard: PreparedMessageElement = card;
  void ordinaryCard;
}
void verifyPreparedSubmission;

function verifyCategoryAssignmentPort(context: FriendCategoryAssignmentContext) {
  // @ts-expect-error Assignment cannot acquire unrelated native services.
  context.getGroupService();
  // @ts-expect-error The assignment port cannot create categories.
  context.getBuddyService()?.addCategory('name');
  // @ts-expect-error Native UID is a string, not a numeric UIN.
  context.getBuddyService()?.setBuddyCategory?.(123, 7);
  const receipt = context.getBuddyService()?.setBuddyCategory?.('u_fixture', 7);
  // @ts-expect-error Opaque native completion must be validated by its owner.
  void receipt.result;
}
void verifyCategoryAssignmentPort;

import type { AttachmentDownloadsContext } from '../../src/features/media/attachment-downloads.ts';
function verifyAttachmentDownloadsContext(context: AttachmentDownloadsContext) {
  // @ts-expect-error Download orchestration cannot acquire unrelated services.
  context.getBuddyService();
  // @ts-expect-error Its lazy native port cannot send messages.
  context.getMessageService()?.sendMsg('fixture');
  // @ts-expect-error Identity waits must carry the operation's cancellation signal.
  context.awaitAlive(Promise.resolve('fixture'));
}
void verifyAttachmentDownloadsContext;

import type {
  UserProfileQueryContext,
  ContactProfilePort,
} from '../../src/features/contacts/user-profile-query.ts';
import type {
  ContactProfile,
  ContactProfilePort as LegacyProfilePort,
} from '../../src/features/contacts/contact-operations.ts';
import type { UserProfile } from '../../src/contracts/contacts.ts';
function verifyResolvedProfileQuery(
  context: UserProfileQueryContext,
  profile: UserProfile,
  legacy: ContactProfile,
  port: ContactProfilePort,
  legacyPort: LegacyProfilePort,
) {
  // @ts-expect-error UID resolution belongs to the contact dispatcher.
  context.resolveUid('123');
  // @ts-expect-error Profile queries cannot acquire contact mutation services.
  context.getBuddyService();
  // @ts-expect-error A stateless query cannot retire its account.
  context.close();
  // @ts-expect-error The profile port cannot mutate user details.
  context.getProfileService()?.modifyProfile({});
  const result = context.getProfileService()?.getCoreAndBaseInfo?.('nodeStore', ['uid']);
  // @ts-expect-error A native profile completion remains unknown until projection.
  void result.coreInfo;
  const canonical: UserProfile = legacy;
  const compatible: ContactProfile = profile;
  const canonicalPort: ContactProfilePort = legacyPort;
  const compatiblePort: LegacyProfilePort = port;
  void [canonical, compatible, canonicalPort, compatiblePort];
}
void verifyResolvedProfileQuery;
