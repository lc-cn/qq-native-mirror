import type { NativeServicePorts } from '../../src/native-services.ts';

/** Compile-only composition boundary; this function is never invoked. Native
 * receipts remain unknown until their domain owner validates them. */
function verifyCompositionPorts(ports: NativeServicePorts) {
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.Buddy.getBuddyListV2?.('0', true, 0)?.result;
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.Profile.getCoreAndBaseInfo?.('nodeStore', ['u_friend'])?.result;
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.UixConvert.getUid?.(['123'])?.result;
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.Msg.getMsgsByMsgId?.({ chatType: 1, peerUid: 'u_friend' }, ['42'])?.result;
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.Group.getGroupDetailInfo?.('123', 0)?.result;
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.MSF.getServerTime?.()?.result;
  const searchReceipt = ports.Search.searchGroup?.({
    keyWords: '123',
    groupNum: 25,
    exactSearch: false,
    penetrate: '',
  });
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void searchReceipt?.result;
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.Ticket.forceFetchClientKey?.('')?.result;
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.TipOff.getPskey?.(['qun.qq.com'], true)?.result;
  // @ts-expect-error Unchecked native receipt cannot expose result before validation.
  void ports.RichMedia.batchGetGroupFileCount(['123'])?.result;
  // @ts-expect-error Buddy cannot dispatch message operations.
  void ports.Buddy.sendMsg;
  // @ts-expect-error Profile cannot acquire group data.
  void ports.Profile.getGroupList;
  // @ts-expect-error Identity conversion cannot access buddy lists.
  void ports.UixConvert.getBuddyListV2;
  // @ts-expect-error Message service cannot fetch credentials.
  void ports.Msg.getPskey;
  // @ts-expect-error Group service cannot convert identities.
  void ports.Group.getUid;
  // @ts-expect-error MSF cannot search groups.
  void ports.MSF.searchGroup;
  // @ts-expect-error Search cannot mutate categories.
  void ports.Search.renameCategory;
  // @ts-expect-error Ticket cannot read profile data.
  void ports.Ticket.getCoreAndBaseInfo;
  // @ts-expect-error TipOff cannot send messages.
  void ports.TipOff.sendMsg;
  // @ts-expect-error RichMedia cannot manage group members.
  void ports.RichMedia.kickMember;
  // @ts-expect-error Family names are closed, without an arbitrary string index.
  void ports.Unreviewed;
  // @ts-expect-error Buddy refresh is boolean.
  ports.Buddy.getBuddyListV2?.('0', 'true', 0);
  // @ts-expect-error Profile takes an array of UID strings.
  ports.Profile.getCoreAndBaseInfo?.('nodeStore', [42]);
  // @ts-expect-error Identity conversion takes string identities.
  ports.UixConvert.getUid?.([42]);
  // @ts-expect-error Native message IDs are strings.
  ports.Msg.getMsgsByMsgId?.({ chatType: 1, peerUid: 'u_friend' }, [42]);
  // @ts-expect-error Group detail source is numeric.
  ports.Group.getGroupDetailInfo?.('123', '0');
  // @ts-expect-error Server time has no request arguments.
  ports.MSF.getServerTime?.(0);
  // @ts-expect-error Search fixed tuple does not permit other group counts.
  ports.Search.searchGroup?.({ keyWords: '123', groupNum: 50, exactSearch: false, penetrate: '' });
  // @ts-expect-error Ticket selector is a string.
  ports.Ticket.forceFetchClientKey?.(42);
  // @ts-expect-error PSKey flag is boolean.
  ports.TipOff.getPskey?.(['qun.qq.com'], 1);
  // @ts-expect-error RichMedia group IDs are strings.
  ports.RichMedia.batchGetGroupFileCount([123]);
}
void verifyCompositionPorts;
