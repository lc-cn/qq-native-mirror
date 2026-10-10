import type { ContactDirectoryContext } from '../../src/features/contacts/contact-directory.ts';
import type { GroupQueriesContext } from '../../src/features/groups/group-queries.ts';
import type { NativeMessageSenderContext } from '../../src/features/messages/native-message-sender.ts';
import type { ContactOperationsContext } from '../../src/features/contacts/contact-operations.ts';
import type { GroupOperationsContext } from '../../src/features/groups/group-operations.ts';
import type { SelfProfileContext } from '../../src/features/contacts/self-profile.ts';
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
