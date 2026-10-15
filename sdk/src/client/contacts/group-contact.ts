import { captureSetGroupAvatar } from '../../features/groups/group-avatar-input.ts';
import type { GroupInfoUpdate, GroupMember, GroupMutedMember } from '../../contracts/groups.ts';
import type { MessageInput, Peer, SentMessage } from '../../contracts/messages.ts';
import { captureGroupOperation } from '../../features/groups/group-operation-input.ts';
import { captureGroupMessage } from '../../features/messages/send-input.ts';
import { sendGroupId } from '../../validation/identifiers.ts';
import type { ContactContext } from './contact-context.ts';
import { ConversationContact } from './conversation-contact.ts';
import { GroupEssence } from './group-essence.ts';
import { GroupFiles } from './group-files.ts';
import { GroupMemberContact } from './group-member-contact.ts';
import { GroupNotices } from './group-notices.ts';

/** Actions in one group, scoped to the current online session. Selection performs
 * no lookup and does not assert that the account has joined the group.
 */
export class GroupContact extends ConversationContact<Extract<Peer, { type: 'group' }>> {
  readonly groupId: string;
  readonly files: GroupFiles;
  readonly essence: GroupEssence;
  readonly notices: GroupNotices;
  readonly #context: ContactContext;

  /** @internal Constructed by QQClient with its captured session context. */
  constructor(context: ContactContext, groupId: string) {
    const id = sendGroupId(groupId);
    super(context, { type: 'group', groupId: id });
    this.#context = context;
    this.groupId = id;
    this.files = new GroupFiles(context, id);
    this.essence = new GroupEssence(context, id);
    this.notices = new GroupNotices(context, id);
    Object.freeze(this);
  }

  /** Select locally with the same session; invalid identities throw synchronously. */
  pickMember(userId: string): GroupMemberContact {
    this.assertActive();
    return new GroupMemberContact(this.#context, this.groupId, userId);
  }

  async sendMessage(content: MessageInput): Promise<SentMessage> {
    this.assertActive();
    return this.invoke('sendGroupMessage', captureGroupMessage(this.groupId, content));
  }

  async getInfo(): Promise<GroupInfoUpdate> {
    this.assertActive();
    return this.invoke('getGroupInfo', { groupId: this.groupId });
  }

  async getMembers(): Promise<GroupMember[]> {
    this.assertActive();
    return this.invoke('getGroupMembers', { groupId: this.groupId });
  }

  /** Preserve native mute metadata without interpreting its time units. */
  async listMutedMembers(): Promise<GroupMutedMember[]> {
    this.assertActive();
    return this.invoke('listGroupMutedMembers', { groupId: this.groupId });
  }

  /** Submit a stable absolute local image path once. Requires a verified native
   * profile; native acknowledgement does not confirm remote avatar propagation.
   */
  async setAvatar(file: string): Promise<void> {
    this.assertActive();
    return this.invoke('setGroupAvatar', captureSetGroupAvatar(this.groupId, file));
  }

  async setName(name: string): Promise<void> {
    this.assertActive();
    return this.invoke(
      'setGroupName',
      captureGroupOperation('setGroupName', { groupId: this.groupId, name }).payload,
    );
  }

  async setRemark(remark: string): Promise<void> {
    this.assertActive();
    return this.invoke(
      'setGroupRemark',
      captureGroupOperation('setGroupRemark', { groupId: this.groupId, remark }).payload,
    );
  }

  /** Enable or disable whole-group mute; native acknowledgement is not readback. */
  async mute(enabled: boolean): Promise<void> {
    this.assertActive();
    return this.invoke(
      'setGroupMute',
      captureGroupOperation('setGroupMute', { groupId: this.groupId, enabled }).payload,
    );
  }

  async leave(): Promise<void> {
    this.assertActive();
    return this.invoke(
      'leaveGroup',
      captureGroupOperation('leaveGroup', { groupId: this.groupId }).payload,
    );
  }
}
