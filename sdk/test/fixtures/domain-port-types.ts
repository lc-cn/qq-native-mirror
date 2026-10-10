import type { ContactDirectoryContext } from '../../src/features/contacts/contact-directory.ts';
import type { GroupQueriesContext } from '../../src/features/groups/group-queries.ts';
import type { NativeMessageSenderContext } from '../../src/features/messages/native-message-sender.ts';
import type { ContactOperationsContext } from '../../src/features/contacts/contact-operations.ts';
import type { GroupOperationsContext } from '../../src/features/groups/group-operations.ts';
import type { SelfProfileContext } from '../../src/features/contacts/self-profile.ts';
import type { GroupNoticesContext } from '../../src/features/groups/group-notices.ts';
import type { ForwardMessagesContext } from '../../src/features/forward/forward-messages.ts';
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
  webRead: QunWebReadContext,
  noticeRead: WebGroupNoticesContext,
  groupReads: GroupWebReadsContext,
) {
  // @ts-expect-error A contact directory cannot acquire arbitrary native services.
  contacts.service('Group');
  // @ts-expect-error A group query cannot acquire arbitrary native services.
  groups.service('Profile');
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

import type { GroupFolderCreationContext } from '../../src/features/groups/group-file-operations.ts';
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
  // @ts-expect-error Recall does not own message submission or a second listener.
  service.sendMsg({}, [], '');
  // @ts-expect-error Recall cannot register an independent Session listener.
  service.addKernelMsgListener({});
  const returned = service.recallMsg({ chatType: 2, peerUid: '123' }, ['42']);
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
function verifyCapturedMessage(message: CapturedNativeMessage) {
  // @ts-expect-error Queue consumers cannot replace the captured receipt identity.
  message.msgId = '42';
  // @ts-expect-error Snapshot consumers receive validated strings, not arbitrary native values.
  const invalidTime: number = message.msgTime;
  // @ts-expect-error Unrelated raw members remain with Message.raw, not the delivery snapshot.
  message.nativeHandle.initialize();
  void invalidTime;
}
void verifyCapturedMessage;
