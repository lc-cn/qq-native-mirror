import type { DeleteFriendOptions, UserProfile } from '../../contracts/contacts.ts';
import type { MessageInput, Peer, SentMessage } from '../../contracts/messages.ts';
import { captureContactOperation } from '../../features/contacts/contact-operation-input.ts';
import { captureFriendCategoryAssignment } from '../../features/contacts/friend-category-input.ts';
import { capturePrivateMessage } from '../../features/messages/send-input.ts';
import { contactUserId, type ContactContext } from './contact-context.ts';
import { ConversationContact } from './conversation-contact.ts';

/** Actions addressed to one QQ account; selection does not assert friendship.
 * Obtain a contact from an online client's pickFriend(). Re-select after reconnect.
 */
export class FriendContact extends ConversationContact<Extract<Peer, { type: 'private' }>> {
  readonly userId: string;

  /** @internal Constructed by QQClient with its captured session context. */
  constructor(context: ContactContext, userId: string) {
    const id = contactUserId(userId);
    super(context, { type: 'private', userId: id });
    this.userId = id;
    Object.freeze(this);
  }

  async sendMessage(content: MessageInput): Promise<SentMessage> {
    this.assertActive();
    return this.invoke('sendPrivateMessage', capturePrivateMessage(this.userId, content));
  }

  async getProfile(): Promise<UserProfile> {
    this.assertActive();
    return this.invoke(
      'getUserProfile',
      captureContactOperation('getUserProfile', { userId: this.userId }).payload,
    );
  }

  async setRemark(remark: string): Promise<void> {
    this.assertActive();
    return this.invoke(
      'setFriendRemark',
      captureContactOperation('setFriendRemark', { userId: this.userId, remark }).payload,
    );
  }

  /** Native acknowledgement only; the remote category still requires readback. */
  async setCategory(categoryId: number): Promise<void> {
    this.assertActive();
    return this.invoke(
      'setFriendCategory',
      captureFriendCategoryAssignment(this.userId, categoryId),
    );
  }

  /** Submit once; defaults and acknowledgement semantics match deleteFriend(). */
  async delete(options: DeleteFriendOptions = {}): Promise<void> {
    this.assertActive();
    return this.invoke(
      'deleteFriend',
      captureContactOperation('deleteFriend', { userId: this.userId, options }).payload,
    );
  }
}
