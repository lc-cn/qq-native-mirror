import type {
  HistoryOptions,
  Message,
  MessageInput,
  Peer,
  SentMessage,
} from '../../contracts/messages.ts';
import type { OperationCall, OperationResult } from '../../runtime/operation-contracts.ts';
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

  /** Submit once. A timeout after dispatch leaves the remote effect unknown. */
  async recallMessage(messageId: string): Promise<void> {
    this.assertActive();
    return this.invoke('recallMessage', captureRecallRequest(this.peer, messageId));
  }
}
