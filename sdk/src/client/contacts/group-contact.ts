import type { GroupInfoUpdate, GroupMember } from '../../contracts/groups.ts';
import type { MessageInput, Peer, SentMessage } from '../../contracts/messages.ts';
import { captureGroupOperation } from '../../features/groups/group-operation-input.ts';
import { captureGroupMessage } from '../../features/messages/send-input.ts';
import { sendGroupId } from '../../validation/identifiers.ts';
import type { ContactContext } from './contact-context.ts';
import { ConversationContact } from './conversation-contact.ts';
import { GroupMemberContact } from './group-member-contact.ts';

/** Actions in one group, scoped to the current online session. Selection performs
 * no lookup and does not assert that the account has joined the group.
 */
export class GroupContact extends ConversationContact<Extract<Peer, { type: 'group' }>> {
  readonly groupId: string;
  readonly #context: ContactContext;

  /** @internal Constructed by QQClient with its captured session context. */
  constructor(context: ContactContext, groupId: string) {
    const id = sendGroupId(groupId);
    super(context, { type: 'group', groupId: id });
    this.#context = context;
    this.groupId = id;
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
