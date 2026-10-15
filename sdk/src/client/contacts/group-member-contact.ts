import type { UserProfile } from '../../contracts/contacts.ts';
import type { GroupMember, GroupMemberQueryOptions, KickOptions } from '../../contracts/groups.ts';
import type { OperationCall, OperationResult } from '../../runtime/operation-contracts.ts';
import { captureContactOperation } from '../../features/contacts/contact-operation-input.ts';
import { captureGroupOperation } from '../../features/groups/group-operation-input.ts';
import { captureGroupMemberQuery } from '../../features/groups/group-member-query-input.ts';
import { sendGroupId } from '../../validation/identifiers.ts';
import { contactUserId, type ContactContext } from './contact-context.ts';

/** One member identity in one group. This object does not imply membership,
 * friendship or permission, and does not turn group actions into private sends.
 */
export class GroupMemberContact {
  readonly groupId: string;
  readonly userId: string;
  readonly #context: ContactContext;

  /** @internal Constructed by QQClient or GroupContact with a captured session. */
  constructor(context: ContactContext, groupId: string, userId: string) {
    this.#context = context;
    this.groupId = sendGroupId(groupId);
    this.userId = contactUserId(userId);
    Object.freeze(this);
  }

  #invoke<C extends OperationCall>(...command: C): Promise<OperationResult<C[0]>> {
    return this.#context.invoke<C>(...command);
  }

  /** Read the user's account profile; this is not a group membership snapshot. */
  async getProfile(): Promise<UserProfile> {
    this.#context.assertActive();
    return this.#invoke(
      'getUserProfile',
      captureContactOperation('getUserProfile', { userId: this.userId }).payload,
    );
  }

  /** Read role and card from a successful complete group member query. */
  async getInfo(options?: GroupMemberQueryOptions): Promise<GroupMember | undefined> {
    this.#context.assertActive();
    let captured;
    try {
      captured = captureGroupMemberQuery(this.groupId, this.userId, options);
    } finally {
      this.#context.assertActive();
    }
    const member = await this.#invoke('getGroupMember', captured);
    this.#context.assertActive();
    return member;
  }

  async setCard(card: string): Promise<void> {
    this.#context.assertActive();
    return this.#invoke(
      'setGroupMemberCard',
      captureGroupOperation('setGroupMemberCard', {
        groupId: this.groupId,
        userId: this.userId,
        card,
      }).payload,
    );
  }

  async setAdmin(enabled: boolean): Promise<void> {
    this.#context.assertActive();
    return this.#invoke(
      'setGroupAdmin',
      captureGroupOperation('setGroupAdmin', {
        groupId: this.groupId,
        userId: this.userId,
        enabled,
      }).payload,
    );
  }

  async mute(seconds: number): Promise<void> {
    this.#context.assertActive();
    return this.#invoke(
      'setGroupMemberMute',
      captureGroupOperation('setGroupMemberMute', {
        groupId: this.groupId,
        userId: this.userId,
        seconds,
      }).payload,
    );
  }

  /** Native submission only; completion does not confirm remote membership. */
  async kick(options: KickOptions = {}): Promise<void> {
    this.#context.assertActive();
    return this.#invoke(
      'kickGroupMember',
      captureGroupOperation('kickGroupMember', {
        groupId: this.groupId,
        userId: this.userId,
        options,
      }).payload,
    );
  }
}
