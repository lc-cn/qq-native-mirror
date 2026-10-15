import type {
  GroupEssenceListOptions,
  GroupEssenceMessage,
  GroupEssencePage,
  GroupEssencePageOptions,
} from '../../contracts/groups.ts';
import {
  captureGroupEssenceList,
  captureGroupEssencePage,
  captureGroupEssenceRequest,
} from '../../features/groups/group-essence-input.ts';
import { sendGroupId } from '../../validation/identifiers.ts';
import type { ContactContext } from './contact-context.ts';

/** Essence reads and mutations scoped to one group and captured online session. */
export class GroupEssence {
  readonly groupId: string;
  readonly #context: ContactContext;

  /** @internal Constructed by GroupContact with its captured session context. */
  constructor(context: ContactContext, groupId: string) {
    this.#context = context;
    this.groupId = sendGroupId(groupId);
    Object.freeze(this);
  }

  /** Read one QQ HTTP page using the worker's native tickets. */
  async getPage(options: GroupEssencePageOptions = {}): Promise<GroupEssencePage> {
    this.#context.assertActive();
    const captured = captureGroupEssencePage(this.groupId, options);
    return this.#context.invoke('getGroupEssencePage', {
      groupId: captured.groupId,
      options: { pageStart: captured.pageStart, pageLimit: captured.pageLimit },
    });
  }

  /** Traverse until the server's end marker; never return a partial list. */
  async list(options: GroupEssenceListOptions = {}): Promise<GroupEssenceMessage[]> {
    this.#context.assertActive();
    const captured = captureGroupEssenceList(this.groupId, options);
    return this.#context.invoke('listGroupEssenceMessages', {
      groupId: captured.groupId,
      options: { maxPages: captured.maxPages },
    });
  }

  /** Set a kernel message ID, not the sequence/random fields from essence reads.
   * A native acknowledgement is not remote readback; the operation is never retried.
   */
  async set(messageId: string, enabled: boolean): Promise<void> {
    this.#context.assertActive();
    return this.#context.invoke(
      'setGroupEssenceMessage',
      captureGroupEssenceRequest(this.groupId, messageId, enabled),
    );
  }
}
