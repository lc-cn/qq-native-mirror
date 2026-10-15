import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify the actual installed declaration graph and package-root type interface.
 * @param {string} packageRoot
 * @param {string} compilerRoot
 * @param {string[]} typeRoots
 */
export async function verifyPublicContracts(packageRoot, compilerRoot, typeRoots) {
  /** @type {Promise<{default: typeof import('typescript')}>} */
  const compiler = import(pathToFileURL(join(compilerRoot, 'lib/typescript.js')).href);
  const { default: ts } = await compiler;
  /** @type {unknown} */
  const expected = JSON.parse(
    await readFile(new URL('../../test/fixtures/public-type-names.json', import.meta.url), 'utf8'),
  );
  assert.ok(Array.isArray(expected) && expected.every((name) => typeof name === 'string'));
  /** @type {import('typescript').CompilerOptions} */
  const options = {
    strict: true,
    noEmit: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    typeRoots,
    types: ['node'],
  };
  const dist = join(packageRoot, 'dist');
  /** @param {string} directory @returns {Promise<string[]>} */
  async function declarations(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? declarations(path)
          : entry.name.endsWith('.d.ts')
            ? [path]
            : [];
      }),
    );
    return nested.flat();
  }
  const files = await declarations(dist);
  const inventory = new Set(files);
  for (const file of files) {
    const tree = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    /** @param {import('typescript').Node} node */
    function verify(node) {
      /** @type {import('typescript').Node | undefined} */
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        specifier = node.moduleSpecifier;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        specifier = node.argument.literal;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        // TypeScript may retain .ts specifiers in declaration-only imports. Resolve
        // them with the consumer's compiler and require the actual packed .d.ts.
        const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule;
        assert.ok(
          resolved && inventory.has(resolved.resolvedFileName),
          `Unpacked declaration dependency ${file} → ${specifier.text}`,
        );
      }
      ts.forEachChild(node, verify);
    }
    verify(tree);
  }
  const consumer = join(dirname(dirname(packageRoot)), 'public-contract-consumer.ts');
  await writeFile(
    consumer,
    `
import type { ${expected.join(', ')} } from 'qq-native-client';
import { segment } from 'qq-native-client';
export type CompatibilityTypes = [${expected.join(', ')}];
declare const peer: Peer;
if (peer.type === 'group') {
  const id: string = peer.groupId;
  void id;
  // @ts-expect-error Group peers do not carry a private recipient.
  peer.userId;
}
const login: LoginRequest = { method: 'quick', uin: '123' };
void login;
// @ts-expect-error Quick login requires an explicit account.
const invalidLogin: LoginRequest = { method: 'quick' };
// @ts-expect-error Received forward cards cannot be sent as raw message inputs.
const receivedAsSendable: SendableMessageElement = { type: 'forward', format: 'ark', resourceId: 'r' };
declare const liveMessage: ClientEvents['message'][0];
const typedMessageEvent: MessageEvent = liveMessage;
const replyFunction: MessageEvent['reply'] = typedMessageEvent.reply;
void replyFunction;
// @ts-expect-error Live reply capabilities cannot be reassigned by observers.
typedMessageEvent.reply = async () => ({ messageId: '1', sequence: '1', time: 0 });
const replyReceipt: Promise<SentMessage> = liveMessage.reply('pong', true);
void replyReceipt;
declare const groupEvent: ClientEvents['message.group'][0];
declare const privateEvent: ClientEvents['message.private'][0];
const groupId: string = groupEvent.peer.groupId;
const privateId: string = privateEvent.peer.userId;
const capturedText: string = liveMessage.text;
const capturedConversation: import('qq-native-client').FriendContact | import('qq-native-client').GroupContact = liveMessage.conversation;
const capturedFriend: import('qq-native-client').FriendContact = privateEvent.friend;
const capturedGroup: import('qq-native-client').GroupContact = groupEvent.group;
const capturedMember: import('qq-native-client').GroupMemberContact = groupEvent.member;
const groupConversation: import('qq-native-client').GroupContact = groupEvent.conversation;
const privateConversation: import('qq-native-client').FriendContact = privateEvent.conversation;
const eventConversationSend: Promise<SentMessage> = liveMessage.conversation.sendMessage('hello');
const eventMemberProfile: Promise<UserProfile> = groupEvent.member.getProfile();
// @ts-expect-error Observers cannot replace captured text.
liveMessage.text = 'altered';
// @ts-expect-error Observers cannot redirect an event capability.
groupEvent.group = groupConversation;
// @ts-expect-error Private events do not expose group operations.
privateEvent.group;
// @ts-expect-error Group events do not imply a private relationship.
groupEvent.friend;
// @ts-expect-error General event handlers must select a precise alias for member operations.
liveMessage.member;
void [capturedText, capturedConversation, capturedFriend, capturedGroup, capturedMember, groupConversation, privateConversation, eventConversationSend, eventMemberProfile];
const typedGroup: GroupMessageEvent = groupEvent;
const typedPrivate: PrivateMessageEvent = privateEvent;
// @ts-expect-error Group event routing cannot expose a private destination.
groupEvent.peer.userId;
// @ts-expect-error The conversation is immutable in live events.
groupEvent.peer.groupId = '123';
// @ts-expect-error Listeners cannot replace the captured conversation.
liveMessage.peer = {type: 'private', userId: '123'};
const textElement: Extract<SendableMessageElement, {type: 'text'}> = segment.text('hello');
const imageElement: Extract<SendableMessageElement, {type: 'image'}> = segment.image('/image.png');
const mixedMessage = [segment.at('123'), ' hello', segment.face(14)] as const;
const composedInput: MessageInput = mixedMessage;
const singleInput: MessageInput = textElement;
const composedReply: Promise<SentMessage> = groupEvent.reply(mixedMessage);
// @ts-expect-error Message input cannot contain arbitrary primitives.
const invalidMixed: MessageInput = ['text', 123];
// @ts-expect-error Media helpers currently accept local paths, not buffers.
segment.image(new Uint8Array());
declare const friendRequestEvent: FriendRequestEvent;
declare const groupRequestEvent: GroupRequestEvent;
const friendApproval: Promise<void> = friendRequestEvent.approve();
const groupApproval: Promise<void> = groupRequestEvent.approve(false, 'declined');
// @ts-expect-error An approval result is not proof of remote friendship.
const confirmed: Promise<boolean> = friendRequestEvent.approve();
// @ts-expect-error An approval capability is immutable.
groupRequestEvent.approve = async () => {};
declare const requestSnapshot: GroupRequest;
const requestParticipant: import('qq-native-client').GroupRequestParticipant = { uid: 'u_opaque' };
const requestApplicant: import('qq-native-client').GroupRequestParticipant | undefined = requestSnapshot.applicant;
const requestInviter: import('qq-native-client').GroupRequestParticipant | undefined = groupRequestEvent.inviter;
const participantNickname: string | undefined = requestParticipant.nickname;
// @ts-expect-error Missing native display data does not invent a participant.
const requiredRequestApplicant: import('qq-native-client').GroupRequestParticipant = requestSnapshot.applicant;
// @ts-expect-error Group request participants carry opaque UIDs, not fabricated numeric accounts.
requestParticipant.userId;
// @ts-expect-error Participant nickname is optional display text, not a required account name.
const requiredParticipantNickname: string = requestParticipant.nickname;
// @ts-expect-error Native participant identity is a captured readonly value.
requestParticipant.uid = 'u_changed';
// @ts-expect-error Captured display text cannot be assigned through the public type.
requestParticipant.nickname = 'changed';
// @ts-expect-error Request participants preserve string identity rather than coercing numbers.
const numericParticipant: import('qq-native-client').GroupRequestParticipant = { uid: 123 };
void [requestApplicant, requestInviter, participantNickname];
// @ts-expect-error Query snapshots do not own live approval capabilities.
requestSnapshot.approve();
void [groupId, privateId, typedGroup, typedPrivate, imageElement, composedInput, singleInput, composedReply, friendApproval, groupApproval];
// @ts-expect-error Reply quoting is a boolean, not a string option.
liveMessage.reply('pong', 'quote');
declare const historicalMessage: Message;
// @ts-expect-error Historical message data does not own a live client reply capability.
historicalMessage.reply('pong');
declare const event: ClientEvents['request.group'][0];
const request: GroupRequest = event;
declare const receipt: SentMergedForward;
const sent: SentMessage = receipt;
declare const notices: GroupNoticePage;
const webNotices: WebGroupNoticeResult = notices;
declare const search: GroupSearchMatch;
const searchGroup: Group = search;
const ownerUid: string = search.ownerUid;
// @ts-expect-error Search snapshots do not invent a numeric owner account.
search.ownerUserId;
declare const client: import('qq-native-client').QQClient;
const friendContact: import('qq-native-client').FriendContact = client.pickFriend('123');
const groupContact: import('qq-native-client').GroupContact = client.pickGroup('456');
const memberContact: import('qq-native-client').GroupMemberContact = groupContact.pickMember('123');
const selectedMember: import('qq-native-client').GroupMemberContact = client.pickMember('456', '123');
const selectedUserId: string = friendContact.peer.userId;
const selectedGroupId: string = groupContact.peer.groupId;
const contactSend: Promise<SentMessage> = friendContact.sendMessage('hello');
const contactComposed: Promise<SentMessage> = groupContact.sendMessage(mixedMessage);
const clientSingle: Promise<SentMessage> = client.sendPrivateMessage('123', segment.text('hello'));
const contactHistory: Promise<Message[]> = groupContact.getHistory({limit: 10});
const contactBatch: Promise<(Message | undefined)[]> = friendContact.getMessages(['789']);
const memberProfile: Promise<UserProfile> = memberContact.getProfile();
const selectedMembers: Promise<GroupMember[]> = groupContact.getMembers();
const memberQueryOptions: import('qq-native-client').GroupMemberQueryOptions = { refresh: true };
const selectedMemberInfo: Promise<GroupMember | undefined> = memberContact.getInfo(memberQueryOptions);
const queriedMemberInfo: Promise<GroupMember | undefined> = client.getGroupMember('456', '123', memberQueryOptions);
const refreshedMembers: Promise<GroupMember[]> = client.getGroupMembers('456', memberQueryOptions);
const refreshedContactMembers: Promise<GroupMember[]> = groupContact.getMembers({ refresh: false });
// @ts-expect-error A successful complete query may not contain the selected member.
const requiredMemberInfo: Promise<GroupMember> = memberContact.getInfo();
// @ts-expect-error Refresh is an explicit boolean, not a numeric cache age.
memberContact.getInfo({ refresh: 1 });
// @ts-expect-error Account identities preserve decimal precision as strings.
client.getGroupMember('456', 123);
// @ts-expect-error Account profile queries do not read group-specific metadata.
friendContact.getInfo();
void [selectedMemberInfo, queriedMemberInfo, refreshedMembers, refreshedContactMembers];
const selectedMuted: Promise<GroupMutedMember[]> = groupContact.listMutedMembers();
const groupAvatar: Promise<void> = client.setGroupAvatar('456', '/tmp/avatar.png');
const selectedGroupAvatar: Promise<void> = groupContact.setAvatar('/tmp/avatar.png');
// @ts-expect-error Group identities must preserve decimal precision as strings.
client.setGroupAvatar(456, '/tmp/avatar.png');
// @ts-expect-error Avatar inputs are local paths, not byte arrays.
groupContact.setAvatar(new Uint8Array());
// @ts-expect-error A native avatar acknowledgement is not remote-effect readback.
const avatarConfirmed: Promise<boolean> = client.setGroupAvatar('456', '/tmp/avatar.png');
// @ts-expect-error Private contacts do not own group-avatar mutations.
friendContact.setAvatar('/tmp/avatar.png');
void [groupAvatar, selectedGroupAvatar];
const selectedFiles: import('qq-native-client').GroupFiles = groupContact.files;
const selectedNotices: import('qq-native-client').GroupNotices = groupContact.notices;
const selectedEssence: import('qq-native-client').GroupEssence = groupContact.essence;
const selectedFilePage: Promise<GroupFilePage> = selectedFiles.getPage({ startIndex: 0 });
const selectedFileList: Promise<GroupFileEntry[]> = selectedFiles.list({ maxPages: 2 });
const selectedCount: Promise<number> = selectedFiles.count();
const selectedFolder: Promise<GroupFolder> = selectedFiles.createFolder('files');
const selectedFileDeletion: Promise<void> = selectedFiles.deleteFile('file-id');
const selectedFolderDeletion: Promise<void> = selectedFiles.deleteFolder('folder-id');
const selectedNoticePage: Promise<GroupNoticePage> = selectedNotices.list();
const selectedNoticePublication: Promise<void> = selectedNotices.publish('notice', { pinned: true });
const selectedNoticeDeletion: Promise<void> = selectedNotices.delete('notice-id');
const selectedEssencePage: Promise<GroupEssencePage> = selectedEssence.getPage({ pageStart: 0 });
const selectedEssenceList: Promise<GroupEssenceMessage[]> = selectedEssence.list({ maxPages: 2 });
const selectedEssenceMutation: Promise<void> = selectedEssence.set('789', true);
const selectedForwardRead: Promise<Message[]> = friendContact.getForwardMessages('789');
const selectedForwardSubmission: Promise<void> = friendContact.forwardMessages(groupContact.peer, ['789'] as const);
const selectedMerged: Promise<SentMergedForward> = groupContact.sendMergedForward([{ userId: '123', nickname: 'name', time: 1, text: 'hello' }]);
const selectedAttachment: Promise<{file: string}> = groupContact.downloadAttachment('789', '1', '/tmp/attachment');
// @ts-expect-error Selected resource objects cannot be replaced.
groupContact.files = selectedFiles;
// @ts-expect-error Resource routing is immutable.
selectedNotices.groupId = '999';
// @ts-expect-error Full group-file traversal always starts at zero.
selectedFiles.list({ startIndex: 1 });
// @ts-expect-error Group resource capabilities do not belong to private contacts.
friendContact.notices.list();
// @ts-expect-error Essence mutations use kernel message IDs, not list-entry objects.
selectedEssence.set({ sequence: '1', random: '2' }, true);
void [selectedMuted, selectedFilePage, selectedFileList, selectedCount, selectedFolder, selectedFileDeletion, selectedFolderDeletion, selectedNoticePage, selectedNoticePublication, selectedNoticeDeletion, selectedEssencePage, selectedEssenceList, selectedEssenceMutation, selectedForwardRead, selectedForwardSubmission, selectedMerged, selectedAttachment];
// @ts-expect-error Selecting a contact requires a lossless string identity.
client.pickFriend(123);
// @ts-expect-error A selected identity cannot be reassigned.
friendContact.userId = '456';
// @ts-expect-error Conversation routing is immutable.
groupContact.peer.groupId = '789';
// @ts-expect-error A friend has no group peer.
friendContact.peer.groupId;
// @ts-expect-error Group membership does not imply private-message capability.
memberContact.sendMessage('hello');
declare const snapshotFriend: Friend;
// @ts-expect-error Friend query snapshots remain data, without active operations.
snapshotFriend.sendMessage('hello');
void [selectedMember, selectedUserId, selectedGroupId, contactSend, contactComposed, clientSingle, contactHistory, contactBatch, memberProfile, selectedMembers];
const searchResult: Promise<GroupSearchMatch | undefined> = client.searchGroup('123');
const folderResult: Promise<GroupFolder> = client.createGroupFolder('123', 'files');
const filePageResult: Promise<GroupFilePage> = client.getGroupFilePage('123', {startIndex: 0});
const fileListResult: Promise<GroupFileEntry[]> = client.listGroupFiles('123', {maxPages: 20});
// @ts-expect-error Full folder traversal always starts at zero.
client.listGroupFiles('123', {startIndex: 1});
// @ts-expect-error Page selectors are numeric, never unchecked strings.
client.getGroupFilePage('123', {sortType: '1'});
declare const fileMetadata: GroupFile;
const fileSize: string = fileMetadata.fileSize;
const parentFolder: string | null = fileMetadata.parentFolderId;
// @ts-expect-error uint64 native metadata must not lose precision through Number.
const roundedSize: number = fileMetadata.fileSize;
declare const fileEntry: GroupFileEntry;
// @ts-expect-error An opaque native kind cannot imply that file metadata exists.
fileEntry.fileInfo.fileId;
declare const folder: GroupFolder;
client.deleteGroupFolder(folder.groupId, folder.folderId);
// @ts-expect-error A folder snapshot does not claim a listing or file-count result.
folder.files;
void [request, sent, webNotices, searchGroup, ownerUid, searchResult, folderResult, filePageResult, fileListResult, fileSize, parentFolder];
`,
  );
  const program = ts.createProgram([consumer, join(dist, 'types.d.ts')], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    diagnostics.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
  );
  const compatibility = program.getSourceFile(join(dist, 'types.d.ts'));
  assert.ok(compatibility);
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(compatibility);
  assert.ok(symbol);
  const exports = checker.getExportsOfModule(symbol);
  assert.deepEqual(exports.map((symbol) => symbol.name).sort(), [...expected].sort());
  return { publicTypeExports: expected.length, installedDeclarationFiles: files.length };
}
