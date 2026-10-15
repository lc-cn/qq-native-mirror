import type { GroupNoticeOptions, GroupNoticePage } from '../../contracts/groups.ts';
import {
  captureGroupNoticeDeletion,
  captureGroupNoticeList,
  captureGroupNoticePublication,
} from '../../features/groups/group-notice-input.ts';
import { sendGroupId } from '../../validation/identifiers.ts';
import type { ContactContext } from './contact-context.ts';

/** Group notices bound to the selecting online session. Reads return the
 * supported server page; mutations are submitted once, without readback/retry.
 */
export class GroupNotices {
  readonly groupId: string;
  readonly #context: ContactContext;

  /** @internal Constructed by GroupContact with its captured session context. */
  constructor(context: ContactContext, groupId: string) {
    this.#context = context;
    this.groupId = sendGroupId(groupId);
    Object.freeze(this);
  }

  /** The native profile exposes one notice page, not a complete history. */
  async list(): Promise<GroupNoticePage> {
    this.#context.assertActive();
    return this.#context.invoke('listGroupNotices', captureGroupNoticeList(this.groupId));
  }

  /** Native acknowledgement supplies no verified notice ID or delivery receipt. */
  async publish(text: string, options?: GroupNoticeOptions): Promise<void> {
    this.#context.assertActive();
    const captured = captureGroupNoticePublication(this.groupId, text, options);
    return this.#context.invoke('publishGroupNotice', captured);
  }

  /** Completion confirms submission; remote disappearance requires a later read. */
  async delete(noticeId: string): Promise<void> {
    this.#context.assertActive();
    return this.#context.invoke(
      'deleteGroupNotice',
      captureGroupNoticeDeletion(this.groupId, noticeId),
    );
  }
}
