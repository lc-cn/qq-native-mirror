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
