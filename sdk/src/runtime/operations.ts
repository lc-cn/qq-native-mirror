/**
 * The closed business-operation vocabulary shared by IPC routing and native dispatch.
 * Public methods retain their own typed payload/result contracts. Keeping this list
 * independent of native implementations avoids loading them to classify a request.
 */
export const SERVICE_OPERATIONS = Object.freeze([
  'addFriendCategory',
  'renameFriendCategory',
  'listFriends',
  'listFriendCategories',
  'listGroups',
  'getGroupInfo',
  'listGroupMutedMembers',
  'getGroupMembers',
  'sendPrivateMessage',
  'sendGroupMessage',
  'sendMergedForward',
  'getMessage',
  'getMessages',
  'getHistory',
  'recallMessage',
  'getForwardMessages',
  'getForwardResource',
  'forwardMessages',
  'getGroupFileCount',
  'searchGroup',
  'deleteGroupFolder',
  'createGroupFolder',
  'setGroupName',
  'setGroupEssenceMessage',
  'getGroupEssencePage',
  'listGroupEssenceMessages',
  'setGroupRemark',
  'setGroupMute',
  'setGroupMemberMute',
  'setGroupMemberCard',
  'setGroupAdmin',
  'kickGroupMember',
  'leaveGroup',
  'setNickname',
  'setSignature',
  'listGroupNotices',
  'publishGroupNotice',
  'deleteGroupNotice',
  'downloadAttachment',
  'getUserProfile',
  'setFriendRemark',
  'deleteFriend',
  'listFriendRequests',
  'handleFriendRequest',
  'listGroupRequests',
  'handleGroupRequest',
] as const);

export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];

const operationNames: ReadonlySet<string> = new Set(SERVICE_OPERATIONS);

/** Classify untrusted IPC input without coercing user-defined objects. */
export function isServiceOperation(value: unknown): value is ServiceOperation {
  return typeof value === 'string' && operationNames.has(value);
}

/** Only these HTTP readers propagate a per-request signal through all awaits.
 * An IPC timeout cannot undo an issued native call or a remote mutation.
 */
export function isCancellableRead(value: unknown): boolean {
  return (
    value === 'getGroupEssencePage' ||
    value === 'listGroupEssenceMessages' ||
    value === 'listGroupNotices'
  );
}
