import type {
  HistoryOptions,
  Message,
  MessageInput,
  Peer,
  SentMessage,
} from '../../contracts/messages.ts';
import type { OperationCall, OperationResult } from '../../runtime/operation-contracts.ts';
import type {
  ForwardTextNode,
  MergedForwardOptions,
  SentMergedForward,
} from '../../contracts/forward.ts';
import { captureForwardSubmission } from '../../features/forward/forward-input.ts';
import { captureMergedForward } from '../../features/forward/merged-forward-input.ts';
import { captureDownloadRequest } from '../../features/media/download-input.ts';
import {
  normalizeHistoryQuery,
  normalizeMessageBatchQuery,
  normalizeMessageQuery,
} from '../../features/messages/query-input.ts';
import { captureRecallRequest } from '../../features/messages/recall-input.ts';
import type { ContactContext } from './contact-context.ts';

/** Shared conversation actions capture their destination once. Instances belong
 * to the online session that selected them and never refresh or reconnect it.
 */
export abstract class ConversationContact<P extends Peer> {
  readonly peer: Readonly<P>;
  readonly #context: ContactContext;

  protected constructor(context: ContactContext, peer: P) {
    this.#context = context;
    this.peer = Object.freeze({ ...peer });
  }

  protected assertActive(): void {
    this.#context.assertActive();
  }

  protected invoke<C extends OperationCall>(...command: C): Promise<OperationResult<C[0]>> {
    return this.#context.invoke<C>(...command);
  }

  abstract sendMessage(content: MessageInput): Promise<SentMessage>;

  async getHistory(options: HistoryOptions = {}): Promise<Message[]> {
    this.assertActive();
    const query = normalizeHistoryQuery(this.peer, options);
    return this.invoke('getHistory', {
      peer: query.peer,
      options: { before: query.before, limit: query.count, reverse: query.reverse },
    });
  }

  async getMessage(messageId: string): Promise<Message | undefined> {
    this.assertActive();
    return this.invoke('getMessage', normalizeMessageQuery(this.peer, messageId));
  }

  /** Results retain requested order; successful misses remain undefined. */
  async getMessages(messageIds: readonly string[]): Promise<(Message | undefined)[]> {
    this.assertActive();
    return this.invoke('getMessages', normalizeMessageBatchQuery(this.peer, messageIds));
  }

  /** Read a card in this conversation. Nested cards keep the outer root ID and
   * supply their own parent ID; first-level cards use the root for both.
   */
  async getForwardMessages(
    rootMessageId: string,
    parentMessageId: string = rootMessageId,
  ): Promise<Message[]> {
    this.assertActive();
    const root = normalizeMessageQuery(this.peer, rootMessageId);
    const parent = normalizeMessageQuery(root.peer, parentMessageId);
    return this.invoke('getForwardMessages', {
      peer: root.peer,
      rootMessageId: root.messageId,
      parentMessageId: parent.messageId,
    });
  }

  /** Forward existing messages from this conversation. Native submission does
   * not confirm destination receipt, and failures are never automatically retried.
   */
  async forwardMessages(destination: Peer, messageIds: readonly string[]): Promise<void> {
    this.assertActive();
    return this.invoke(
      'forwardMessages',
      captureForwardSubmission({ source: this.peer, destination, messageIds }),
    );
  }

  /** Compose text records into a card addressed to this conversation. Upload
   * and card dispatch retain their existing completion and unknown-effect errors.
   */
  async sendMergedForward(
    nodes: readonly ForwardTextNode[],
    options: MergedForwardOptions = {},
  ): Promise<SentMergedForward> {
    this.assertActive();
    return this.invoke('sendMergedForward', captureMergedForward(this.peer, nodes, options));
  }

  async downloadAttachment(
    messageId: string,
    elementId: string,
    destination: string,
  ): Promise<{ file: string }> {
    this.assertActive();
    return this.invoke(
      'downloadAttachment',
      captureDownloadRequest(this.peer, messageId, elementId, destination),
    );
  }

  /** Submit once. A timeout after dispatch leaves the remote effect unknown. */
  async recallMessage(messageId: string): Promise<void> {
    this.assertActive();
    return this.invoke('recallMessage', captureRecallRequest(this.peer, messageId));
  }
}
