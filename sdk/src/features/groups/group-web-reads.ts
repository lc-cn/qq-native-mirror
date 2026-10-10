import { requestQunPage, type QunWebReadContext } from './qun-web-read.ts';
import { listWebGroupNotices } from './web-group-notices.ts';
import { getGroupEssencePage, listGroupEssenceMessages } from './group-essence-list.ts';

export interface GroupWebReadsContext {
  readonly accountId?: string;
  readonly signal: AbortSignal;
  readonly getTicketService: QunWebReadContext['getTicketService'];
  readonly getTipOffService: QunWebReadContext['getTipOffService'];
  readonly fetchImpl?: typeof fetch;
  awaitAlive<T>(value: T | PromiseLike<T>, requestSignal?: AbortSignal): Promise<T>;
}

/** Owns account-bound group HTTP read orchestration. Each call has independent
 * cancellation; tickets remain transport-owned and are never cached here.
 */
export function createGroupWebReads(context: GroupWebReadsContext) {
  const prepare = (label: 'notice' | 'essence', requestSignal?: AbortSignal) => {
    const accountId = context.accountId;
    if (!accountId)
      throw new Error(`Group ${label} listing requires the authenticated account identity`);
    const signal = requestSignal
      ? AbortSignal.any([context.signal, requestSignal])
      : context.signal;
    signal.throwIfAborted();
    const transport: QunWebReadContext = {
      accountId,
      signal,
      getTicketService: context.getTicketService,
      getTipOffService: context.getTipOffService,
      fetchImpl: context.fetchImpl,
      awaitAlive: (value) => context.awaitAlive(value, signal),
    };
    return transport;
  };
  return {
    async listGroupNotices(groupId: unknown, requestSignal?: AbortSignal) {
      const transport = prepare('notice', requestSignal);
      return context.awaitAlive(
        listWebGroupNotices(
          {
            accountId: transport.accountId,
            signal: transport.signal,
            readPage: (parameters) => requestQunPage(transport, 'notices', parameters),
          },
          groupId,
        ),
        transport.signal,
      );
    },
    async getGroupEssencePage(groupId: unknown, options?: unknown, requestSignal?: AbortSignal) {
      const transport = prepare('essence', requestSignal);
      return context.awaitAlive(getGroupEssencePage(transport, groupId, options), transport.signal);
    },
    async listGroupEssenceMessages(
      groupId: unknown,
      options?: unknown,
      requestSignal?: AbortSignal,
    ) {
      const transport = prepare('essence', requestSignal);
      return context.awaitAlive(
        listGroupEssenceMessages(transport, groupId, options),
        transport.signal,
      );
    },
  };
}
